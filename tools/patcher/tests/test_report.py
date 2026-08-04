"""Aggregation rules, and one full run of the entrypoint with a fake agent.

The aggregation tests exist because the reporting rules are easy to state and
easy to violate silently: summing two dispositions that must stay apart, or
emitting a rate whose denominator moved.
"""
import json
import os
import subprocess
import sys

import report as report_mod

ENTRYPOINT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'src', 'run_patcher.py')


def _rec(bug_id, disposition, *, rounds_to_green=None, attested=None,
         probe=True, workflow=True, added=4, removed=2, files=('routes/a.ts',)):
    return {
        'bug_id': bug_id, 'task_index': 0,
        'location': {'file': files[0], 'line': 1},
        'disposition': disposition, 'disposition_reason': None,
        'measured': {
            'characterisation': {'workflow_green_pre_fix': workflow,
                                 'probe_proven_pre_fix': probe, 'attempts': 1,
                                 'related_test_files': [], 'baseline_failures': []},
            'rounds': [{'round': 0, 'green': disposition == 'fixed', 'gates': {},
                        'failures': [], 'agent': {'phase': 'fix', 'ok': True,
                                                  'cost_usd': 1.25,
                                                  'model_usage': {'m': {'inputTokens': 10}}}}],
            'final_gates': {}, 'rounds_to_green': rounds_to_green,
            'wall_s': 1.0, 'cost_usd': 1.25,
        },
        'attested': attested,
        'attestation_delta': None,
        'diff_stats': {'files_touched': list(files), 'lines_added': added,
                       'lines_removed': removed, 'touched_outside_bug_file': False,
                       'net_deletion': removed >= max(8, added * 3)},
        'violations': [],
    }


CLEAN_AUDIT = {'contaminated': False, 'input_scrub': {}, 'runtime_denials': {}, 'notes': []}


def agg(records, audit=None):
    return report_mod.aggregate(records, run_meta={'run_id': 'r'},
                                blind_audit=audit or CLEAN_AUDIT,
                                agent_desc={'runner': 'fake'})


# ---------------------------------------------------------------------------

def test_verified_and_unverified_fixes_are_never_summed():
    """`fixed_workflow_only` means the remediation axis was never demonstrated.
    Folding it into `fixed` is the false-confidence failure the eval exists for."""
    r = agg([_rec('A', 'fixed', rounds_to_green=0),
             _rec('B', 'fixed_workflow_only', rounds_to_green=1, probe=False)])
    d = r['totals']['dispositions']
    assert d['fixed'] == 1 and d['fixed_workflow_only'] == 1
    assert 'fixed_total' not in d


def test_dispositions_sum_to_task_count():
    recs = [_rec('A', 'fixed'), _rec('B', 'abandoned'), _rec('C', 'blocked'),
            _rec('D', 'partial'), _rec('E', 'already_remediated')]
    r = agg(recs)
    assert sum(r['totals']['dispositions'].values()) == r['totals']['tasks'] == 5


def test_self_verification_coverage_is_a_rate_over_all_tasks():
    r = agg([_rec('A', 'fixed', probe=True), _rec('B', 'abandoned', probe=False),
             _rec('C', 'blocked', probe=False, workflow=False)])
    sv = r['totals']['self_verification']
    assert sv['probe_coverage'] == round(1 / 3, 4)
    assert sv['probe_unproven_tasks'] == 2
    assert sv['workflow_characterised'] == round(2 / 3, 4)


def test_rounds_to_green_keeps_the_tail():
    """A mean would hide the tail, and the tail is where the cost is."""
    recs = ([_rec(f'A{i}', 'fixed', rounds_to_green=0) for i in range(3)]
            + [_rec('B', 'fixed', rounds_to_green=4), _rec('C', 'abandoned')])
    rg = agg(recs)['totals']['rounds_to_green']
    assert rg['histogram'] == {'0': 3, '4': 1, 'never': 1}
    assert rg['max'] == 4


def test_cost_is_measured_and_summed_not_estimated():
    r = agg([_rec('A', 'fixed'), _rec('B', 'abandoned')])
    assert r['run']['cost']['total_usd'] == 2.5
    assert r['run']['cost']['invocations'] == 2
    assert r['run']['cost']['by_model']['m']['inputTokens'] == 20


def test_cost_is_null_when_the_runtime_reported_none():
    rec = _rec('A', 'fixed')
    rec['measured']['rounds'][0]['agent']['cost_usd'] = None
    assert agg([rec])['run']['cost']['total_usd'] is None


def test_fix_by_deletion_is_counted_for_human_review():
    r = agg([_rec('A', 'fixed', added=1, removed=40)])
    assert r['totals']['blast_radius']['tasks_net_deletion'] == 1
    assert 'read every one of these by hand' in report_mod.render_summary(r)


def test_in_sandbox_overclaim_rate():
    recs = [_rec('A', 'fixed', attested={'status': 'fixed', 'confidence': 0.9}),
            _rec('B', 'abandoned', attested={'status': 'fixed', 'confidence': 0.95}),
            _rec('C', 'fixed', attested={'status': 'not_fixed', 'confidence': 0.2})]
    cal = agg(recs)['totals']['attestation_calibration']
    assert cal['claimed_fixed'] == 2
    assert cal['claimed_fixed_but_gates_red'] == 1
    assert cal['claimed_not_fixed_but_gates_green'] == 1
    assert cal['in_sandbox_overclaim_rate'] == 0.5


def test_summary_disclaims_the_sandbox_calibration_number():
    """It is not the scorer's FCR: there is no oracle in the sandbox."""
    text = report_mod.render_summary(agg([_rec('A', 'fixed')]))
    assert 'NOT the scorer' in text


def test_contamination_leads_the_summary():
    audit = {'contaminated': True, 'input_scrub': {}, 'runtime_denials': {},
             'notes': ['BUG-001/fix answer_key_pattern: searched for solutions']}
    text = report_mod.render_summary(agg([_rec('A', 'fixed')], audit))
    assert text.strip().startswith('!! BLIND BOUNDARY VIOLATED')
    assert 'searched for solutions' in text


def test_summary_carries_no_per_task_detail():
    """`tasks[]` pairs a bug id with a file and a line; the summary must not."""
    text = report_mod.render_summary(agg([_rec('A', 'fixed', files=('routes/secret.ts',))]))
    assert 'routes/secret.ts' not in text and 'BUG' not in text


# ---------------------------------------------------------------------------
# End to end through the real entrypoint
# ---------------------------------------------------------------------------

WORKFLOW = ('import sys, pathlib\n'
            'src = pathlib.Path("routes/app.ts").read_text()\n'
            'print("ok 1 - it works" if "FEATURE" in src else "not ok 1 - it works")\n'
            'sys.exit(0 if "FEATURE" in src else 1)\n')
PROBE = ('import pathlib\n'
         'print("PROVEN" if "VULN{n}" in pathlib.Path("routes/app.ts").read_text() '
         'else "NOT_PROVEN")\n')

DRIVER = r'''
import json, os, pathlib, sys
tree = os.environ["FAKE_TREE"]
phase = os.environ["FAKE_PHASE"]; task = os.environ["FAKE_TASK"]
'''


def _build_fixture(tmp_path, n_bugs=3):
    base = tmp_path / 'base'
    (base / 'routes').mkdir(parents=True)
    (base / 'package.json').write_text('{"name":"fake"}')
    marks = ' '.join(f'VULN{i}' for i in range(n_bugs))
    (base / 'routes' / 'app.ts').write_text(f'// FEATURE {marks}\n')

    bugs = [{'bug_id': f'BUG-{i:03d}',
             'location': {'file': 'routes/app.ts', 'line': i + 1},
             'owasp': [{'code': 'A03'}], 'class': 'Injection / SQL',
             'vulnerability': 'concatenated input', 'reproduction': 'send q'}
            for i in range(n_bugs)]
    br = {'report_id': 'br', 'kind': 'bug-report-agent',
          'visibility': 'BLIND', 'target_dir': 'target-apps/x',
          'bug_count': n_bugs, 'bugs': bugs}
    pb = {'playbook_id': 'pb', 'entries': [
        {'entry_id': 'a03', 'owasp_codes': ['A03'], 'guidance': 'Parameterise.'}]}
    (tmp_path / 'bugs.json').write_text(json.dumps(br))
    (tmp_path / 'pb.json').write_text(json.dumps(pb))

    cfg = {
        'run_id': 'e2e',
        'inputs': {'bug_report': str(tmp_path / 'bugs.json'),
                   'playbook': str(tmp_path / 'pb.json')},
        'target': {'base_tree': str(base), 'work_tree': str(tmp_path / 'tree')},
        'agent': {'runner': 'fake'},
        'loop': {'characterise_rounds': 2, 'reconcile_rounds': 2, 'max_task_wall_s': 600},
        'policy': {'on_exhausted': 'revert', 'require_probe': False,
                   'regression_net': 'related', 'final_full_suite': False},
        'commands': {'typecheck': 'python3 -c "pass"',
                     'run_test_file': 'python3 {file}',
                     'run_probe': 'python3 {file}',
                     'timeout_s': {'typecheck': 60, 'test_file': 60, 'probe': 60}},
        'outputs': {'run_dir': str(tmp_path / 'run')},
    }
    (tmp_path / 'cfg.json').write_text(json.dumps(cfg))
    return str(tmp_path / 'cfg.json')


def test_preflight_spends_nothing_and_reports_cleanly(tmp_path):
    cfg = _build_fixture(tmp_path)
    r = subprocess.run([sys.executable, ENTRYPOINT, '--config', cfg, '--check'],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert 'sandbox hook: verified' in r.stdout
    assert 'preflight clean' in r.stdout
    assert not os.path.exists(tmp_path / 'tree')


def test_preflight_refuses_a_contaminated_bug_report(tmp_path):
    cfg_path = _build_fixture(tmp_path)
    bugs = json.loads((tmp_path / 'bugs.json').read_text())
    bugs['bugs'][0]['vulnerability'] = 'see the ground truth for the fix'
    (tmp_path / 'bugs.json').write_text(json.dumps(bugs))
    r = subprocess.run([sys.executable, ENTRYPOINT, '--config', cfg_path, '--check'],
                       capture_output=True, text=True)
    assert r.returncode == 2
    assert 'withheld material' in r.stdout


def test_preflight_refuses_to_run_without_a_working_sandbox(tmp_path, monkeypatch):
    cfg = _build_fixture(tmp_path)
    import agent as agent_mod
    r = subprocess.run(
        [sys.executable, '-c',
         f'import sys; sys.path.insert(0, {os.path.dirname(ENTRYPOINT)!r});'
         'import agent, run_patcher;'
         'agent.HOOK = "/nonexistent/guard.py";'
         f'sys.argv = ["x", "--config", {cfg!r}, "--check"];'
         'sys.exit(run_patcher.main())'],
        capture_output=True, text=True)
    assert r.returncode == 2
    assert 'sandbox hook missing' in r.stdout
    assert agent_mod.HOOK  # untouched in this process


def test_full_run_with_fake_agent_produces_both_outputs(tmp_path, monkeypatch):
    """The whole outer loop: three tasks, one report, one patched tree."""
    cfg_path = _build_fixture(tmp_path, n_bugs=3)
    tree = str(tmp_path / 'tree')

    driver = tmp_path / 'driver.py'
    driver.write_text(f'''
import json, os, sys
sys.path.insert(0, {os.path.join(os.path.dirname(ENTRYPOINT))!r})
import run_patcher, agent, workspace

WORKFLOW = {WORKFLOW!r}
PROBE = {PROBE!r}

def behave(prompt, phase, task_id, cwd):
    n = int(task_id.split("-")[1])
    d = workspace.ensure_scratch({tree!r}, task_id)
    if phase == "characterise":
        open(os.path.join(d, "workflow.test.ts"), "w").write(WORKFLOW)
        open(os.path.join(d, "exploit.probe.ts"), "w").write(PROBE.format(n=n))
        json.dump({{"bug_id": task_id, "correct_behaviour": "works",
                   "related_test_files": []}},
                  open(os.path.join(d, "characterisation.json"), "w"))
        return True
    src = os.path.join({tree!r}, "routes", "app.ts")
    text = open(src).read()
    # BUG-002 is scripted to destroy the feature and never reconcile.
    if n == 2:
        text = text.replace("FEATURE", "")
    text = text.replace("VULN%d" % n, "")
    open(src, "w").write(text)
    json.dump({{"bug_id": task_id, "status": "fixed", "confidence": 0.9,
                "what_changed": "x", "rounds_used": 0}},
              open(os.path.join(d, "attestation.json"), "w"))
    return True

_orig = agent.build_runner
agent.build_runner = lambda cfg, sb, kind=None: agent.FakeRunner(behaviour=behave)
sys.argv = ["x", "--config", {cfg_path!r}, "--agent", "fake"]
sys.exit(run_patcher.main())
''')
    r = subprocess.run([sys.executable, str(driver)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr

    report = json.loads((tmp_path / 'run' / 'patcher-report.json').read_text())
    assert report['totals']['tasks'] == 3
    d = report['totals']['dispositions']
    assert d['fixed'] == 2, r.stdout
    assert d['abandoned'] == 1              # BUG-002 broke the feature and was reverted

    # Output 1: the report, aggregate and honest — including honest that this
    # run had no sandbox to enforce, so it is a mechanism test.
    assert report['blind_audit']['contaminated'] is False
    assert report['blind_audit']['runtime_enforced'] is False
    assert 'UNENFORCED RUNTIME' in r.stdout
    assert report['run']['tree_digest_end']

    # Output 2: the codebase. Two vulnerabilities gone, the feature intact,
    # and the abandoned task's damage rolled back.
    src = (tmp_path / 'tree' / 'routes' / 'app.ts').read_text()
    assert 'FEATURE' in src
    assert 'VULN0' not in src and 'VULN1' not in src
    assert 'VULN2' in src

    # No agent machinery left in the deliverable.
    assert not os.path.exists(tmp_path / 'tree' / '.patcher-scratch')
    assert not os.path.exists(tmp_path / 'tree' / '.patcher-snapshots')


def test_resume_refuses_a_drifted_tree(tmp_path):
    """A resumed run against a drifted tree would credit the patcher with edits
    it did not make, invisibly."""
    import state as state_mod
    import workspace
    base = tmp_path / 'base'
    (base / 'routes').mkdir(parents=True)
    (base / 'routes' / 'a.ts').write_text('x')
    tree = str(tmp_path / 'tree')
    workspace.prepare(str(base), tree)

    st = state_mod.RunState(str(tmp_path / 'state.json'))
    st.tree_digest = workspace.tree_digest(tree)
    st.assert_tree_matches(workspace.tree_digest(tree))     # matches: fine

    (tmp_path / 'tree' / 'routes' / 'a.ts').write_text('tampered')
    try:
        st.assert_tree_matches(workspace.tree_digest(tree))
        raise AssertionError('expected a refusal')
    except RuntimeError as ex:
        assert 'refusing to resume' in str(ex)
