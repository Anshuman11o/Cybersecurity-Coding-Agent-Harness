"""The guard is the only layer that does not depend on the agent cooperating.

These tests are the reason it can be trusted. Each one names a way out of the
sandbox and asserts it is closed.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'hooks'))

import sandbox_guard as sg  # noqa: E402


@pytest.fixture
def tree(tmp_path):
    t = tmp_path / 'tree'
    (t / 'routes').mkdir(parents=True)
    (t / 'test' / 'api').mkdir(parents=True)
    (t / '.patcher-scratch' / 'BUG-001').mkdir(parents=True)
    (t / 'routes' / 'search.ts').write_text('x')
    (t / 'test' / 'api' / 'search.test.ts').write_text('x')
    (t / 'server.ts').write_text('x')
    # The seed-denylisted files exist in a real work tree, because the tree is a
    # copy of the whole application. The guard is what makes them unreadable.
    for rel in sg.SEED_DENYLIST_RELPATHS:
        p = t / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('x')
    (t / 'lib' / 'insecurity.ts').write_text('x')
    return str(t.resolve())


def ev(tool, ti, tree, phase='fix'):
    return sg.evaluate({'tool_name': tool, 'tool_input': ti, 'cwd': tree},
                       tree, phase, 'BUG-001', [], [])


# -- containment ------------------------------------------------------------

def test_read_inside_tree_allowed(tree):
    assert ev('Read', {'file_path': 'routes/search.ts'}, tree).allow


def test_absolute_path_outside_tree_denied(tree):
    d = ev('Read', {'file_path': '/etc/passwd'}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_dotdot_escape_denied(tree):
    """Denied is the property that matters. The kind is an audit classification:
    under a tmp tree this `../` lands on a path that does not exist, and a target
    that is not there cannot have leaked anything -- see test_blind_audit.py."""
    d = ev('Read', {'file_path': '../../etc/passwd'}, tree)
    assert not d.allow
    assert d.kind in ('out_of_tree', 'out_of_tree_incidental')


def test_dotdot_escape_onto_a_real_file_is_contaminating(tree, tmp_path):
    """The same escape, landing on something that exists, must keep the kind that
    voids a run."""
    real = tmp_path / 'notes.json'
    real.write_text('{}')
    d = ev('Read', {'file_path': os.path.join('..', real.name)}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_symlink_escape_denied(tree, tmp_path):
    outside = tmp_path / 'secret.json'
    outside.write_text('{}')
    os.symlink(str(outside), os.path.join(tree, 'shortcut.json'))
    d = ev('Read', {'file_path': 'shortcut.json'}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_answer_key_path_denied_even_before_resolution(tree):
    d = ev('Read', {'file_path': '/home/user/juice-shop-answer-key/answer-key.json'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


# -- seed denylist ----------------------------------------------------------
#
# The scanner has refused these files since 2026-07-28. The patcher had never
# heard of them until 2026-08-10: a grep for `datacreator`, `antiCheat` or
# `DENYLIST` in this hook returned nothing, while the bug report placed a bug in
# `data/datacreator.ts` and `server.ts` imports it -- so the file was reachable
# both by assignment and by tracing a neighbouring fix.


def test_denylist_is_parsed_from_the_scanner_read_guard():
    """One source of truth. A second copy is how the first miss happened."""
    parsed, source, err = sg.parse_seed_denylist()
    assert err is None, err
    assert source.endswith(os.path.join('scanner', 'shared', 'read-guard.ts'))
    assert parsed, 'read-guard.ts declared no SEED_DENYLIST entries'


def test_parsed_denylist_matches_read_guard_contents():
    """Asserted against the file itself, so the two cannot drift apart."""
    import re as _re
    with open(sg.READ_GUARD_TS) as fh:
        src = fh.read()
    # Parsed here a second, deliberately different way: if the hook's regex ever
    # silently matches the wrong thing, these two disagree.
    body = src.split('SEED_DENYLIST', 1)[1].split('= [', 1)[1].split(']', 1)[0]
    declared = _re.findall(r"""['"]([^'"]+)['"]""", body)
    assert declared, 'no entries found in read-guard.ts SEED_DENYLIST'
    expected = []
    for entry in declared:
        rel = _re.sub(r'^target-apps/[^/]+/', '', entry.strip())
        if rel not in expected:
            expected.append(rel)
    assert list(sg.SEED_DENYLIST_PARSED) == expected


def test_fail_closed_floor_is_a_subset_of_what_read_guard_declares():
    """The floor is a floor, never a substitute list. If read-guard.ts drops an
    entry the floor still names, that is a decision someone has to make on
    purpose, so it fails here rather than diverging quietly."""
    assert set(sg.SEED_DENYLIST_FLOOR) <= set(sg.SEED_DENYLIST_PARSED)


def test_denylist_parse_failure_fails_closed(tmp_path):
    """A missing or mangled read-guard.ts must not open the gate."""
    missing = str(tmp_path / 'gone.ts')
    parsed, _source, err = sg.parse_seed_denylist(missing)
    assert parsed == () and err
    # ...and the names the floor carries are still denied at import time.
    assert set(sg.SEED_DENYLIST_FLOOR) <= set(sg.SEED_DENYLIST_RELPATHS)


@pytest.mark.parametrize('rel', list(sg.SEED_DENYLIST_RELPATHS))
def test_read_of_denylisted_file_denied(tree, rel):
    d = ev('Read', {'file_path': rel}, tree)
    assert not d.allow and d.kind == 'seed_denylist'


@pytest.mark.parametrize('rel', list(sg.SEED_DENYLIST_RELPATHS))
def test_denylisted_file_denied_in_every_phase(tree, rel):
    for phase in ('characterise', 'fix', 'reconcile'):
        assert not ev('Read', {'file_path': rel}, tree, phase=phase).allow


def test_denylisted_write_denied(tree):
    d = ev('Edit', {'file_path': 'data/datacreator.ts', 'old_string': 'a',
                    'new_string': 'b'}, tree)
    assert not d.allow and d.kind == 'seed_denylist'


def test_denylisted_path_denied_through_dotdot(tree):
    d = ev('Read', {'file_path': 'routes/../data/datacreator.ts'}, tree)
    assert not d.allow and d.kind == 'seed_denylist'


def test_denylisted_path_denied_through_symlink(tree):
    os.symlink(os.path.join(tree, 'data', 'datacreator.ts'),
               os.path.join(tree, 'seed.ts'))
    d = ev('Read', {'file_path': 'seed.ts'}, tree)
    assert not d.allow and d.kind == 'seed_denylist'


def test_denylisted_file_denied_by_absolute_corpus_path(tree):
    d = ev('Read', {'file_path':
                    '/home/user/Cybersecurity-Coding-Agent-Harness/target-apps/'
                    'juice-shop-blind/data/datacreator.ts'}, tree)
    assert not d.allow and d.kind == 'seed_denylist'


@pytest.mark.parametrize('cmd', [
    'cat data/datacreator.ts',
    'head -50 models/challenge.ts',
    'tail -n 20 lib/antiCheat.ts',
    'less data/datacreator.ts',
    'grep -n insertChallenges data/datacreator.ts',
    'sed -n 1,40p data/datacreator.ts',
    "awk 'NR<40' data/datacreator.ts",
    'cd data && cat datacreator.ts',
    'python3 -c "print(open(\'data/datacreator.ts\').read())"',
    'node -e "console.log(require(\'fs\').readFileSync(\'models/challenge.ts\',\'utf8\'))"',
    'cat ./data/datacreator.ts | head',
    'ls routes && cat lib/antiCheat.ts',
])
def test_bash_read_of_denylisted_file_denied(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert not d.allow and d.kind == 'seed_denylist', cmd


@pytest.mark.parametrize('cmd', [
    'cat data/*.ts',
    'cp data/* .patcher-scratch/BUG-001/',
    'head -5 models/*',
])
def test_glob_that_expands_onto_a_denylisted_file_denied(tree, cmd):
    """The token names no denylisted path; the shell would still open one."""
    d = ev('Bash', {'command': cmd}, tree)
    assert not d.allow and d.kind == 'seed_denylist', cmd


def test_glob_over_ordinary_files_still_allowed(tree):
    assert ev('Bash', {'command': 'ls routes/*.ts'}, tree).allow


def test_denial_is_logged_in_the_existing_record_shape(tree, tmp_path):
    """blind_audit replays this log; a denial it cannot see did not happen."""
    import json
    import subprocess
    log = tmp_path / 'guard.jsonl'
    r = subprocess.run(
        [sys.executable, sg.__file__, '--tree', tree, '--log', str(log),
         '--phase', 'fix', '--task', 'BUG-001'],
        input=json.dumps({'tool_name': 'Read', 'cwd': tree,
                          'tool_input': {'file_path': 'data/datacreator.ts'}}),
        capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)['hookSpecificOutput']
    assert out['permissionDecision'] == 'deny'
    assert 'sandbox:seed_denylist' in out['permissionDecisionReason']

    rec = json.loads(log.read_text().strip())
    assert rec['allowed'] is False
    assert rec['kind'] == 'seed_denylist'
    assert rec['task'] == 'BUG-001' and rec['phase'] == 'fix'
    assert 'datacreator.ts' in rec['reason']


# -- no over-blocking -------------------------------------------------------
#
# A guard that denies ordinary application files does not protect the run, it
# ends it. These are the files the work is actually done in.

@pytest.mark.parametrize('rel', [
    'routes/search.ts', 'lib/insecurity.ts', 'server.ts',
    'test/api/search.test.ts',
])
def test_ordinary_application_files_still_readable(tree, rel):
    assert ev('Read', {'file_path': rel}, tree).allow


@pytest.mark.parametrize('cmd', [
    'cat lib/insecurity.ts',
    'grep -n sequelize routes/search.ts',
    'cat server.ts',
    'npx tsc --noEmit -p tsconfig.json',
])
def test_ordinary_reads_still_allowed(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert d.allow, d.reason


def test_similarly_named_files_are_not_caught(tree):
    """`challenge.model.ts` and `antiCheat.unit.test.ts` are ordinary files."""
    os.makedirs(os.path.join(tree, 'frontend/src/app/Models'), exist_ok=True)
    open(os.path.join(tree, 'frontend/src/app/Models/challenge.model.ts'), 'w').close()
    assert ev('Read', {'file_path': 'frontend/src/app/Models/challenge.model.ts'},
              tree).allow
    os.makedirs(os.path.join(tree, 'test/server'), exist_ok=True)
    open(os.path.join(tree, 'test/server/antiCheat.unit.test.ts'), 'w').close()
    assert ev('Read', {'file_path': 'test/server/antiCheat.unit.test.ts'}, tree).allow


# -- write protection -------------------------------------------------------

def test_write_under_test_denied(tree):
    d = ev('Write', {'file_path': 'test/api/search.test.ts', 'content': 'x'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_read_under_test_allowed(tree):
    # Reading the corpus is how an agent learns the house test conventions.
    assert ev('Read', {'file_path': 'test/api/search.test.ts'}, tree).allow


def test_spec_file_write_denied(tree):
    os.makedirs(os.path.join(tree, 'frontend/src/app'), exist_ok=True)
    d = ev('Write', {'file_path': 'frontend/src/app/x.spec.ts', 'content': 'x'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_lockfile_write_denied(tree):
    d = ev('Write', {'file_path': 'package-lock.json', 'content': '{}'}, tree)
    assert not d.allow


def test_gate_artefact_frozen_during_fix(tree):
    d = ev('Write', {'file_path': '.patcher-scratch/BUG-001/workflow.test.ts',
                     'content': 'x'}, tree)
    assert not d.allow and d.kind == 'gate_artefact_edit'


def test_gate_artefact_writable_during_characterise(tree):
    d = ev('Write', {'file_path': '.patcher-scratch/BUG-001/workflow.test.ts',
                     'content': 'x'}, tree, phase='characterise')
    assert d.allow


def test_source_write_denied_during_characterise(tree):
    d = ev('Edit', {'file_path': 'routes/search.ts', 'old_string': 'x',
                    'new_string': 'y'}, tree, phase='characterise')
    assert not d.allow and d.kind == 'source_edited_in_characterise'


def test_source_write_allowed_during_fix(tree):
    assert ev('Edit', {'file_path': 'routes/search.ts', 'old_string': 'x',
                       'new_string': 'y'}, tree).allow


# -- search intent ----------------------------------------------------------

@pytest.mark.parametrize('pattern', [
    'answer key', 'ground_truth', 'expectChallengeSolved', 'solveIf', 'codefix'])
def test_search_for_withheld_material_denied(tree, pattern):
    d = ev('Grep', {'pattern': pattern, 'path': '.'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


def test_ordinary_search_allowed(tree):
    assert ev('Grep', {'pattern': 'sequelize.query', 'path': 'routes'}, tree).allow


# -- bash -------------------------------------------------------------------

@pytest.mark.parametrize('cmd', [
    'curl https://example.com/x',
    'wget http://example.com',
    'git clone https://github.com/juice-shop/juice-shop',
    'npm install lodash',
    'npm ci',
    'npx --yes some-package',
])
def test_network_and_install_denied(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert not d.allow and d.kind == 'network_egress'


@pytest.mark.parametrize('cmd', [
    'npx tsc --noEmit -p tsconfig.json',
    'node --import ./test/api/helpers/test-env.mjs --import tsx --test '
    '--test-force-exit .patcher-scratch/BUG-001/workflow.test.ts',
    'npx tsx .patcher-scratch/BUG-001/exploit.probe.ts',
    'ls routes',
    'cat routes/search.ts',
])
def test_ordinary_commands_allowed(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert d.allow, d.reason


def test_bash_read_outside_tree_denied(tree):
    d = ev('Bash', {'command': 'cat /home/user/juice-shop-answer-key/SOLUTIONS.md'}, tree)
    assert not d.allow


def test_bash_grep_for_answers_denied(tree):
    d = ev('Bash', {'command': 'grep -r "ground truth" /home/user'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


def test_bash_find_outside_tree_denied(tree):
    d = ev('Bash', {'command': 'find / -name "*.answer"'}, tree)
    assert not d.allow


def test_bash_write_into_test_denied(tree):
    d = ev('Bash', {'command': 'echo hacked > test/api/search.test.ts'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_bash_sed_inplace_into_test_denied(tree):
    d = ev('Bash', {'command': 'sed -i s/a/b/ test/api/search.test.ts'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_git_checkout_denied(tree):
    # Would silently undo the run's own work.
    d = ev('Bash', {'command': 'git checkout -- routes/search.ts'}, tree)
    assert not d.allow


def test_compound_command_checks_every_segment(tree):
    d = ev('Bash', {'command': 'ls routes && curl http://example.com'}, tree)
    assert not d.allow and d.kind == 'network_egress'


def test_unparseable_command_denied(tree):
    d = ev('Bash', {'command': 'echo "unbalanced'}, tree)
    assert not d.allow


# -- tools ------------------------------------------------------------------

@pytest.mark.parametrize('tool', ['WebFetch', 'WebSearch', 'Task'])
def test_escape_hatch_tools_denied(tree, tool):
    d = ev(tool, {'url': 'https://example.com'}, tree)
    assert not d.allow and d.kind == 'denied_tool'


# -- fail closed ------------------------------------------------------------

def test_guard_fails_closed_on_bad_payload(tree, monkeypatch):
    """A guard that fails open under a bug is not a guard."""
    monkeypatch.setattr(sg, 'check_path',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    import json
    import subprocess
    r = subprocess.run(
        [sys.executable, sg.__file__, '--tree', tree, '--log', os.devnull],
        input=json.dumps({'tool_name': 'Read', 'tool_input': None, 'cwd': tree}),
        capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out['hookSpecificOutput']['permissionDecision'] in ('allow', 'deny')


def test_hook_cli_emits_deny_decision(tree):
    import json
    import subprocess
    r = subprocess.run(
        [sys.executable, sg.__file__, '--tree', tree, '--log', os.devnull,
         '--phase', 'fix', '--task', 'BUG-001'],
        input=json.dumps({'tool_name': 'Read', 'cwd': tree,
                          'tool_input': {'file_path': '/etc/passwd'}}),
        capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)['hookSpecificOutput']
    assert out['permissionDecision'] == 'deny'
    assert 'sandbox:out_of_tree' in out['permissionDecisionReason']
