"""What a finished v3 run's report is able to say about itself.

`run_patcher_v3.py` is the only thing that turns a dispatch into
`patcher-report.json`, and that file is what `archive_run.py` reads and what a
history row is built from. Two of its blocks were being assembled from less than
the run knew, and both failures are silent — the report is well-formed, the run
looks finished, and the missing half is only noticed by a reader months later
trying to compare two rows.

  * **`blind_audit.input_scrub`.** `blind_guard.audit_run` defaults
    `scrub_reports=()` and then asserts `bug_report_clean: True`,
    `playbook_clean: True`, `keys_stripped: []`. v1 re-loads both inputs to
    recover the real reports; v3 passed nothing, so every v3 report certified
    inputs it had never looked at.

    The severity is bounded and worth stating exactly: a forbidden VALUE raises
    `BlindBoundaryError` out of `blind_guard.scrub`, so no run can reach a report
    at all with withheld material embedded in its inputs. What the empty default
    loses is the record of which keys were STRIPPED — the signal that the
    generator producing those inputs is emitting material it should not — and the
    warnings, including the playbook's `content_status`, which is precisely the
    qualification that has to travel next to every number the run produces.

  * **`run.agent`.** The runner's own description names the model and nothing
    about the loop, so a v3 row could not state the reconcile budget it ran
    under. That is exactly the parameter that changed when the fix phase became
    measured, and exactly what a later comparison of two v3 rows turns on.

Driven through `main()` with the fake runner rather than by calling the
assemblers directly, because every one of these was a component being called
correctly and handed the wrong argument — a unit test of the component would have
passed throughout.

The tasks here all end `blocked`: the fake agent writes no characterisation, so
no fix phase is entered and no gate runs. That is deliberate. What is under test
is the reporting path, which a blocked run exercises in full and in a couple of
seconds; the fix loop's own behaviour is `test_v3_measured_fix.py`'s subject.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import run_patcher_v3  # noqa: E402

from test_v3_dispatcher import BUGS, TRUNK_FILES, _map_doc, _write  # noqa: E402

# The application files preflight insists on before a token is spent: the app
# refuses to start without its build output, and an unbuilt tree makes every API
# gate fail at load for reasons that have nothing to do with any patch. Empty
# files are enough — preflight checks presence, and no gate here boots anything.
BUILT_ARTEFACTS = ('build/server.js',
                   'frontend/dist/frontend/index.html',
                   'frontend/dist/frontend/styles.css',
                   'frontend/dist/frontend/main.js',
                   'frontend/dist/frontend/polyfills.js',
                   'frontend/dist/frontend/hacking-instructor-en.js')


def _bug_report(**over) -> dict:
    doc = {
        'report_id': 'bug-report-wiring', 'kind': 'bug-report-agent',
        'visibility': 'BLIND — safe to put in a prompt',
        'target_dir': 'target-apps/juice-shop-blind',
        'target_sha': 'deadbee', 'bug_count': len(BUGS),
        'bugs': [{'bug_id': b['bug_id'], 'location': dict(b['location']),
                  'owasp': [{'code': 'A01'}], 'class': b['class'],
                  'playbook_ref': b['playbook_ref']} for b in BUGS],
    }
    doc.update(over)
    return doc


def _playbook(**over) -> dict:
    doc = {
        'playbook_id': 'playbook-wiring', 'kind': 'remediation-playbook',
        'entries': [{'entry_id': 'generic',
                     'guidance': 'Fail closed. Preserve the public contract.'}],
    }
    doc.update(over)
    return doc


def _config(tmp_path, bug_report: dict, playbook: dict) -> str:
    """A complete v3 run on disk: base tree, inputs, map, config. Returns the
    config path."""
    base = tmp_path / 'base'
    for rel, src in TRUNK_FILES.items():
        _write(str(base / rel), src)
    _write(str(base / 'package.json'), '{"name": "fixture"}\n')
    for rel in BUILT_ARTEFACTS:
        _write(str(base / rel), '')

    _write(str(tmp_path / 'bug-report.json'), json.dumps(bug_report))
    _write(str(tmp_path / 'playbook.json'), json.dumps(playbook))
    _write(str(tmp_path / 'chunk-map.json'), json.dumps(_map_doc()))

    cfg = {
        'run_id': 'patch-run-wiring',
        'inputs': {'bug_report': str(tmp_path / 'bug-report.json'),
                   'playbook': str(tmp_path / 'playbook.json'),
                   'chunk_map': str(tmp_path / 'chunk-map.json')},
        'target': {'base_tree': str(base), 'work_tree': str(tmp_path / 'trunk')},
        'outputs': {'run_dir': str(tmp_path / 'run')},
        'commands': {'typecheck': 'python3 -c "pass"',
                     'run_test_file': 'python3 {file}',
                     'run_server_test_file': 'python3 {file}',
                     'run_probe': 'python3 {file}',
                     'timeout_s': {'typecheck': 60, 'test_file': 60, 'probe': 60}},
        # The knobs the report has to be able to quote back.
        'loop': {'characterise_rounds': 3, 'reconcile_rounds': 5,
                 'max_task_wall_s': 600, 'reuse_characterisation': False},
        # v3 reads none of this; preflight reuses v1's validation, which requires
        # `on_exhausted` to be one of the three legal values.
        'policy': {'on_exhausted': 'revert', 'require_probe': True,
                   'regression_net': 'own_only', 'final_full_suite': False},
    }
    path = str(tmp_path / 'run-config.json')
    _write(path, json.dumps(cfg))
    return path


def _run(tmp_path, monkeypatch, *, bug_report=None, playbook=None) -> dict:
    path = _config(tmp_path, bug_report or _bug_report(), playbook or _playbook())
    monkeypatch.setattr(sys, 'argv',
                        ['run_patcher_v3.py', '--config', path, '--agent', 'fake'])
    assert run_patcher_v3.main() == 0
    with open(tmp_path / 'run' / 'patcher-report.json') as fh:
        return json.load(fh)


@pytest.fixture
def report(tmp_path, monkeypatch):
    return _run(tmp_path, monkeypatch)


# ---------------------------------------------------------------------------
# input_scrub — an unconditional assertion is not evidence
# ---------------------------------------------------------------------------

def test_a_stripped_key_reaches_the_audits_input_scrub_block(tmp_path, monkeypatch):
    """A withheld key inside a bug entry is removed before dispatch, and the
    removal has to be on the record: it is the only signal that the generator
    producing these inputs is emitting material it should not."""
    doc = _bug_report()
    doc['bugs'][0]['oracle'] = 'something the agent must never see'
    rep = _run(tmp_path, monkeypatch, bug_report=doc)

    stripped = rep['blind_audit']['input_scrub']['keys_stripped']
    assert stripped, 'the strip happened and the report said nothing about it'
    assert any(entry.endswith('.oracle') for entry in stripped), stripped
    assert any('withheld key' in n for n in rep['blind_audit']['notes'])


def test_a_thin_playbook_carries_its_content_status_into_the_report(
        tmp_path, monkeypatch):
    """`content_status` is the qualification that has to travel next to every
    number the run produces — a thin playbook must not later be read as a weak
    model. It arrives as a `ScrubReport` warning, so an empty default drops it."""
    rep = _run(tmp_path, monkeypatch,
               playbook=_playbook(content_status='guidance text unavailable: '
                                                 'egress blocked'))
    assert any('content_status' in n for n in rep['blind_audit']['notes']), \
        rep['blind_audit']['notes']


def test_clean_inputs_are_reported_clean_because_they_were_looked_at(report):
    """The other half. `bug_report_clean: True` has to mean the reports were read
    and were clean, not that no report was passed."""
    scrub = report['blind_audit']['input_scrub']
    assert scrub['bug_report_clean'] is True
    assert scrub['playbook_clean'] is True
    assert scrub['keys_stripped'] == []
    assert scrub['value_pattern_hits'] == []


# ---------------------------------------------------------------------------
# run.agent — the loop knobs the run actually ran under
# ---------------------------------------------------------------------------

def test_the_report_states_the_round_budget_the_run_ran_under(report):
    """Without these a v3 row cannot say how hard the run was allowed to try,
    which is the parameter that changed when the fix phase became measured."""
    agent = report['run']['agent']
    assert agent['reconcile_rounds'] == 5
    assert agent['characterise_rounds'] == 3
    assert agent['runner'] == 'fake'


def test_the_policy_block_is_reported_as_v3_behaves_not_as_the_config_reads(report):
    """v3's dispatcher never opens `cfg['policy']`. The fixture config sets
    `require_probe: true`, `on_exhausted: revert` and `regression_net: own_only`,
    and the run honoured none of them — copying them into the row would be a
    false claim about how the run was measured."""
    agent = report['run']['agent']
    assert agent['require_probe'] is False
    assert agent['on_exhausted'] == 'keep_best'
    assert agent['regression_net'] == 'related'


def _agent_block_schema():
    with open(os.path.join(os.path.dirname(__file__), '..', 'contracts',
                           'patcher-report.schema.json')) as fh:
        schema = json.load(fh)
    return schema['properties']['run']['properties']['agent']


def test_every_key_in_the_agent_block_is_named_by_the_report_contract(report):
    """`patcher-report.schema.json` is `additionalProperties: false` here, so a
    key the code writes and the contract does not name makes the report
    schema-INVALID rather than merely undocumented. Nothing validates at runtime,
    so the first symptom would otherwise be a contract check against a run that
    has already been paid for."""
    named = set(_agent_block_schema()['properties'])
    assert set(report['run']['agent']) <= named, set(report['run']['agent']) - named


def test_the_contract_names_every_denial_counter_the_guard_emits(report):
    """`blind_audit.runtime_denials` is `additionalProperties: false`, and the
    producer grew three counters the contract never learned about
    (`out_of_tree_incidental`, `seed_denylist`, `git_history`). A reader checking
    a real report against the schema would have called a valid report invalid,
    and the three that were missing are exactly the ones whose whole purpose is
    to be counted without voiding the run."""
    import blind_guard
    with open(os.path.join(os.path.dirname(__file__), '..', 'contracts',
                           'patcher-report.schema.json')) as fh:
        schema = json.load(fh)
    named = set(schema['properties']['blind_audit']['properties']
                ['runtime_denials']['properties'])
    emitted = set(blind_guard._AUDIT_COUNTER_KEYS) | {'total'}
    assert emitted <= named, emitted - named
    assert set(report['blind_audit']['runtime_denials']) <= named


def test_the_real_runners_description_is_also_inside_the_contract(tmp_path):
    """The fake runner describes itself in two keys, so a report built from it
    cannot detect this. `ClaudeCliRunner.describe()` additionally returns
    `effort` and `reasoning` — recorded there because the runtime never echoes
    them back, so no invocation record can reconstruct what a run was set to —
    and the contract named neither. Every v1 AND v3 report was therefore invalid
    against its own schema, and only a paid run uses this runner."""
    import agent as agent_mod
    runner = agent_mod.ClaudeCliRunner({'agent': {'effort': 'high'}},
                                       str(tmp_path / 'sandbox'))
    named = set(_agent_block_schema()['properties'])
    desc = runner.describe()
    assert {'effort', 'reasoning'} <= set(desc)
    assert set(desc) <= named, set(desc) - named
