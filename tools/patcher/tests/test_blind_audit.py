"""What may and may not void a run.

The flag carries one claim: this run may have learned an answer. It has to fire on
that and nothing else. A real 67-minute, $21 wave was stamped
"BLIND BOUNDARY VIOLATED" whose only out-of-tree denials were /dev/null, the
application's own shared node_modules, and the harness's own scratchpad -- so the
flag stopped meaning anything, in the direction that costs a run.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..', 'src'))
sys.path.insert(0, os.path.join(HERE, '..', 'hooks'))
import blind_guard  # noqa: E402

HOOK = os.path.join(HERE, '..', 'hooks', 'sandbox_guard.py')


def _log(tmp_path, *records) -> str:
    p = str(tmp_path / 'guard.jsonl')
    with open(p, 'w') as fh:
        for r in records:
            fh.write(json.dumps(r) + '\n')
    return p


def _denial(kind, reason='r', task='U', phase='fix'):
    return {'allowed': False, 'kind': kind, 'reason': reason, 'task': task,
            'phase': phase}


def _audit(path):
    return blind_guard.audit_run(path, [], runtime_enforced=True)


# ---- what must NOT void a run ---------------------------------------------

def test_incidental_out_of_tree_does_not_void_a_run(tmp_path):
    a = _audit(_log(tmp_path,
                    _denial('out_of_tree_incidental', '/dev/null resolves to /dev/null'),
                    _denial('out_of_tree_incidental', 'node_modules/jws/package.json')))
    assert a['contaminated'] is False
    assert a['runtime_denials']['out_of_tree_incidental'] == 2
    assert a['runtime_denials']['out_of_tree'] == 0


def test_honest_patching_rules_do_not_void_a_run(tmp_path):
    """A denied write under test/ means the guard worked, not that the run is void."""
    a = _audit(_log(tmp_path, _denial('test_dir_write'), _denial('gate_artefact_edit'),
                    _denial('source_edited_in_characterise')))
    assert a['contaminated'] is False


def test_a_denied_network_egress_does_not_void_a_run(tmp_path):
    """The guard denied it, so nothing was fetched. patch-run-subset-04 was stamped
    contaminated on exactly one such denial -- an `npx --yes` package fetch -- with
    out_of_tree and answer_key_pattern both 0."""
    a = _audit(_log(tmp_path, _denial('network_egress', 'npx --yes some-pkg')))
    assert a['contaminated'] is False
    assert a['runtime_denials']['network_egress'] == 1
    assert any('network egress' in n for n in a['notes'])


def test_a_denied_git_history_read_does_not_void_a_run(tmp_path):
    """Same reasoning as the egress case above: the command was denied, so the
    revision was never rendered and nothing was read. It is counted and noted,
    because an agent reaching into history is worth seeing even when it failed."""
    a = _audit(_log(tmp_path, _denial('git_history', 'git show <rev>:<file>')))
    assert a['contaminated'] is False
    assert a['runtime_denials']['git_history'] == 1
    assert any('git history' in n for n in a['notes'])


def test_git_history_is_deny_only_by_construction(tmp_path):
    """The premise the test above rests on."""
    import sandbox_guard as sg
    for cmd in ('git show HEAD:server.ts', 'git cat-file -p 0123abc',
                'git log -p', 'git worktree add /tmp/w HEAD', 'cat .git/HEAD'):
        d = sg.evaluate({'tool_name': 'Bash', 'tool_input': {'command': cmd}},
                        str(tmp_path), 'fix', 'T', [], [])
        assert not d.allow, cmd
        assert d.kind == 'git_history', cmd


def test_network_egress_is_deny_only_by_construction(tmp_path):
    """The premise the test above rests on. If evaluate() ever ALLOWS with this kind,
    'denied means nothing was learned' breaks and the classifier must be revisited."""
    import sandbox_guard as sg
    for cmd in ('curl https://example.com', 'npm install left-pad',
                'git clone https://github.com/x/y', 'npx --yes cowsay'):
        d = sg.evaluate({'tool_name': 'Bash', 'tool_input': {'command': cmd}},
                        str(tmp_path), 'fix', 'T', [], [])
        assert not d.allow, cmd
        assert d.kind == 'network_egress', cmd


# ---- what MUST void a run -------------------------------------------------

def test_an_answer_key_path_voids_the_run(tmp_path):
    a = _audit(_log(tmp_path, _denial('answer_key_pattern', 'juice-shop-answer-key')))
    assert a['contaminated'] is True


def test_a_non_incidental_out_of_tree_path_still_voids_the_run(tmp_path):
    """Narrowing must not disarm the flag for a reach that could hold an answer."""
    a = _audit(_log(tmp_path, _denial('out_of_tree', '/home/user/somewhere-else/x.json')))
    assert a['contaminated'] is True


# ---- the hook's own classification ---------------------------------------

def _hook(path, tree, log, writing=False):
    """Returns (decision, kind). `kind` is read from the audit log, not the hook
    response -- the log is what audit_run replays, so it is the channel that
    decides whether a run is voided."""
    tool = 'Write' if writing else 'Read'
    r = subprocess.run(
        ['python3', HOOK, '--tree', tree, '--log', log, '--phase', 'fix'],
        input=json.dumps({'tool_name': tool, 'cwd': tree,
                          'tool_input': {'file_path': path}}),
        capture_output=True, text=True)
    decision = json.loads(r.stdout)['hookSpecificOutput']['permissionDecision']
    kind = ''
    with open(log) as fh:
        for line in fh:
            rec = json.loads(line)
            if not rec.get('allowed'):
                kind = rec.get('kind') or ''
    return decision, kind


def test_the_hook_marks_dev_null_and_node_modules_incidental(tmp_path):
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    for i, p in enumerate(('/dev/null',
                           '/elsewhere/node_modules/jws/package.json',
                           '/tmp/claude-0/scratchpad/probe.cjs')):
        decision, kind = _hook(p, tree, str(tmp_path / f'g{i}.jsonl'))
        assert decision == 'deny', f'{p} should still be denied'
        assert kind == 'out_of_tree_incidental', f'{p} classified {kind!r}'


def test_the_hook_denies_an_ordinary_outside_path(tmp_path):
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    decision, _ = _hook('/home/user/elsewhere/notes.json', tree,
                        str(tmp_path / 'g.jsonl'))
    assert decision == 'deny'   # classification is asserted below, on a real file


def test_a_path_that_does_not_exist_is_incidental(tmp_path):
    """Nothing can be learned from a file that is not there. An agent miscounted
    `../` while trying to run a test in its own tree, and that alone voided a wave."""
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    decision, kind = _hook(str(tmp_path / 'nowhere' / 'ghost.ts'), tree,
                           str(tmp_path / 'g.jsonl'))
    assert (decision, kind) == ('deny', 'out_of_tree_incidental')


def test_an_answer_key_path_is_caught_even_when_it_does_not_exist(tmp_path):
    """The existence rule must not open a hole: the pattern is matched on the path
    string, before existence is consulted."""
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    decision, kind = _hook(str(tmp_path / 'juice-shop-answer-key' / 'answer-key.json'),
                           tree, str(tmp_path / 'g2.jsonl'))
    assert (decision, kind) == ('deny', 'answer_key_pattern')


def test_an_existing_outside_file_still_voids_the_run(tmp_path):
    """The case the flag exists for: a real file, outside the tree, that could hold
    something."""
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    real = tmp_path / 'elsewhere' / 'results.json'
    real.parent.mkdir(parents=True, exist_ok=True)
    real.write_text('{}')
    decision, kind = _hook(str(real), tree, str(tmp_path / 'g3.jsonl'))
    assert (decision, kind) == ('deny', 'out_of_tree')


def test_a_log_written_before_the_split_is_corrected_on_read(tmp_path):
    """A guard log is evidence and is never rewritten. CP1 of a checkpointed run was
    recorded by the older hook, and its stale `out_of_tree` labels would otherwise
    void the final report of every later checkpoint too."""
    a = _audit(_log(tmp_path, _denial(
        'out_of_tree',
        '/dev/null resolves to /dev/null, outside the work tree /w. The work tree is')))
    assert a['contaminated'] is False
    assert a['runtime_denials']['out_of_tree_incidental'] == 1


def test_reclassification_fails_closed_when_the_path_cannot_be_recovered(tmp_path):
    """An unparseable reason must keep the kind that voids a run, not lose it."""
    a = _audit(_log(tmp_path, _denial('out_of_tree', 'reason in some other shape')))
    assert a['contaminated'] is True
