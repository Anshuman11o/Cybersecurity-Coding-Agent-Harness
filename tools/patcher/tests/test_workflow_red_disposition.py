"""`fixed_workflow_red` -- a fix submitted over a workflow assertion left failing.

An agent finishes a task by writing `attestation.json`, and until now only
`status` reached the record. That made two very different outcomes into the same
row: a fix whose workflow test is green, and a fix shipped while a workflow
assertion is still red because the agent decided that assertion encodes the
vulnerable behaviour itself rather than legitimate behaviour -- an anti-oracle
claim. The second is a real and sometimes CORRECT thing to do; the problem is
that the justification lived in free-text `residual_risk`, which nothing parses,
so both dispositions read `fixed` and the difference surfaced only when a human
read the transcripts hours later, if ever.

So the claim is made structural. `workflow_red` and `antioracle_claims` are
fields with a shape, they survive normalisation, and a non-empty `workflow_red`
produces its own disposition.

AMENDED 2026-08. v3's fix phase is now driven by `task_loop.run_fix_loop`, as its
architecture always specified, so `fixed_workflow_red` is reached by a
MEASUREMENT -- the orchestrator ran the workflow test and the regression net at
the round boundary, one of them was red, and the probe had stopped proving the
defect. The agent's `workflow_red` and `antioracle_claims` no longer decide the
disposition; they are recorded beside the measurement, which is strictly more
than they were worth alone. Everything below about normalisation, counting and
the publishing boundary is unchanged; the one test that asserted the disposition
came off the agent's list now asserts that it does not.

Three properties this file pins, each of which is a way the change could go
wrong and be useful-looking anyway:

**It reports; it does not gate.** The tree still merges, and no anti-oracle claim
is ever accepted or rejected. A gate built on an agent's self-report would be a
gate the agent can open by omitting a line, which is worse than no gate because
it reads like one -- and that is exactly why the disposition was moved onto the
orchestrator's own gates rather than being given teeth on the agent's list.

**It is never summed with `fixed`.** From outside, a correct fix over a genuine
anti-oracle and a fix that broke the feature are indistinguishable -- that is
precisely what the record cannot say. Folding it into a success total would
restore the exact ambiguity the disposition exists to remove.

**Silence stays backwards-compatible.** Every attestation written before this
change lacks both fields, and must still dispose plain `fixed`. A default that
read a missing field as red would retroactively recolour every past run.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import archive_run  # noqa: E402
import prompts  # noqa: E402
import report as report_mod  # noqa: E402
import task_loop  # noqa: E402
import workspace  # noqa: E402
from v3 import dispatcher  # noqa: E402

from test_v3_dispatcher import BUGS, CFG, Script, _build, _write  # noqa: E402


# ---------------------------------------------------------------------------
# Normalisation -- the fields have to survive the whitelist to mean anything
# ---------------------------------------------------------------------------

def test_both_fields_survive_normalisation():
    att = task_loop._normalise_attestation({
        'status': 'fixed', 'confidence': 0.9,
        'workflow_red': ['w.test.ts :: keeps the basket private'],
        'antioracle_claims': [{'test': 'w.test.ts',
                               'it_title': 'keeps the basket private',
                               'why': 'it asserts the unauthorised read succeeds'}],
    })
    assert att['workflow_red'] == ['w.test.ts :: keeps the basket private']
    assert att['antioracle_claims'] == [{'test': 'w.test.ts',
                                         'it_title': 'keeps the basket private',
                                         'why': 'it asserts the unauthorised read '
                                                'succeeds'}]


def test_absent_fields_normalise_to_empty_lists_not_none():
    """The pre-existing attestation shape. `[]` and not `None`, so every consumer
    can iterate without a guard and none of them invents a red assertion."""
    att = task_loop._normalise_attestation({'status': 'fixed', 'confidence': 0.5})
    assert att['workflow_red'] == []
    assert att['antioracle_claims'] == []


def test_garbage_is_coerced_to_an_empty_list():
    """A string is as likely to be prose as a single entry, so it is dropped
    rather than wrapped -- guessing would invent a claim the agent did not make."""
    for junk in ('one failing test', 42, {'test': 'w.test.ts'}, None, True):
        att = task_loop._normalise_attestation({'status': 'fixed',
                                                'workflow_red': junk,
                                                'antioracle_claims': junk})
        assert att['workflow_red'] == [], junk
        assert att['antioracle_claims'] == [], junk


def test_workflow_red_entries_are_stripped_and_empties_dropped():
    att = task_loop._normalise_attestation({
        'status': 'fixed',
        'workflow_red': ['  w.test.ts :: a  ', '', '   ', 7, None,
                         {'test': 'w.test.ts'}, 'w.test.ts :: b'],
    })
    assert att['workflow_red'] == ['w.test.ts :: a', 'w.test.ts :: b']


def test_a_claim_is_reduced_to_its_three_keys():
    """Same forward-feed hygiene as `dispatcher.read_declarations`: these entries
    are carried into the run record and read downstream, so anything else the
    agent chose to write stops here."""
    att = task_loop._normalise_attestation({
        'status': 'fixed',
        'antioracle_claims': [
            {'test': 'w.test.ts', 'it_title': 'a', 'why': 'b',
             'severity': 'high', 'file': 'routes/x.ts', 'verdict': 'accepted'},
            'not a dict', 17, None,
        ],
    })
    assert att['antioracle_claims'] == [{'test': 'w.test.ts', 'it_title': 'a',
                                         'why': 'b'}]


def test_a_claim_missing_a_key_keeps_the_key_as_none():
    """A partial claim is still a claim. Dropping it would silently reduce the
    count of assertions the agent flagged, which is the number being reported."""
    att = task_loop._normalise_attestation({
        'status': 'fixed', 'antioracle_claims': [{'test': 'w.test.ts'}]})
    assert att['antioracle_claims'] == [{'test': 'w.test.ts', 'it_title': None,
                                         'why': None}]


# ---------------------------------------------------------------------------
# The disposition
# ---------------------------------------------------------------------------

class _RedScript(Script):
    """The well-behaved agent, plus a `workflow_red` list on chosen bugs."""

    def __init__(self, red, claims=None, **kw):
        super().__init__(**kw)
        self.red = red                    # bug_id -> [entry, ...]
        self.claims = claims or {}        # bug_id -> [claim dict, ...]

    def __call__(self, prompt, phase, task_id, cwd):
        ok = super().__call__(prompt, phase, task_id, cwd)
        path = os.path.join(cwd, workspace.scratch_rel(task_id), 'attestation.json')
        # Every round, not just round 0. The base script rewrites the attestation
        # on each invocation, and the loop reads the LAST one -- a claim written
        # only on the fix round would be silently overwritten by the reconciles.
        if phase not in ('fix', 'reconcile') or not os.path.isfile(path):
            return ok
        with open(path) as fh:
            doc = json.load(fh)
        bug_id = doc.get('bug_id')
        if bug_id in self.red:
            doc['workflow_red'] = self.red[bug_id]
            doc['antioracle_claims'] = self.claims.get(bug_id, [])
            _write(path, json.dumps(doc))
        return ok


def _dispositions(tmp_path, script):
    d, _trunk, _runner = _build(tmp_path, script)
    rep = d.run()
    return {t['bug_id']: t
            for p in rep['phases'] for c in p['chunks'] for t in c['tasks']}


def test_a_measured_red_workflow_splits_fixed_into_its_own_disposition(tmp_path):
    """The disposition, reached the way it is now reached: by running the test.

    The agent closes the defect -- its own probe stops printing `PROVEN` -- and
    breaks the legitimate path in the same edit. The orchestrator runs both gates
    every round, spends the whole budget, and lands on `vuln_only`, which is this
    disposition. The agent's list of red assertions is recorded next to it.
    """
    script = _RedScript(
        extra={'BUG-003': {'lib/b.ts': '// BROKE_FEATURE\n'}},
        red={'BUG-003': ['w.test.ts :: keeps the basket private',
                         'w.test.ts :: rejects a foreign token']},
        claims={'BUG-003': [{'test': 'w.test.ts',
                             'it_title': 'keeps the basket private',
                             'why': 'it asserts the unauthorised read succeeds'}]})
    recs = _dispositions(tmp_path, script)

    red = recs['BUG-003']
    assert red['disposition'] == 'fixed_workflow_red'
    # MEASURED now, not attested: these gates were run by this process.
    assert red['disposition_basis'] == dispatcher.MEASURED
    assert red['measured']['label'] == 'vuln_only'
    assert red['measured']['final_gates'] == {
        'typecheck': 'pass', 'workflow': 'fail', 'probe_blocked': 'pass',
        'no_regression': 'skipped'}
    # The budget was spent on it rather than the claim ending the loop early.
    assert red['measured']['rounds_used'] == CFG['loop']['reconcile_rounds'] + 1
    assert 'V2_workflow' in red['disposition_reason']
    assert 'adjudicated by nothing' in red['disposition_reason']
    # And the claim survives, unadjudicated, beside a measurement that agrees the
    # path is closed and disagrees about nothing else it can see.
    assert red['attested']['workflow_red'] == [
        'w.test.ts :: keeps the basket private',
        'w.test.ts :: rejects a foreign token']
    assert red['attested']['antioracle_claims'][0]['it_title'] == \
        'keeps the basket private'


def test_the_agents_own_list_no_longer_decides_the_disposition(tmp_path):
    """`workflow_red` over gates that measured green is `fixed`. Letting the list
    dispose would mean an agent could move its own task out of the success
    column, or -- far worse in the other direction -- keep it there by leaving
    the list empty."""
    script = _RedScript(red={'BUG-003': ['w.test.ts :: keeps the basket private']})
    recs = _dispositions(tmp_path, script)

    rec = recs['BUG-003']
    assert rec['disposition'] == 'fixed'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert rec['measured']['label'] == 'green'
    assert rec['attested']['workflow_red'] == ['w.test.ts :: keeps the basket private']


def test_an_attestation_without_the_field_still_disposes_fixed(tmp_path):
    """Backwards compatibility, and it is the whole population: every attestation
    written before this change lacks the field."""
    recs = _dispositions(tmp_path, Script())
    assert not any(r['disposition'] == 'fixed_workflow_red' for r in recs.values())
    # The unchanged baseline of the default script, asserted whole so the new
    # branch cannot quietly move a task out of some OTHER disposition either.
    counts = {}
    for r in recs.values():
        counts[r['disposition']] = counts.get(r['disposition'], 0) + 1
    assert counts == {'fixed': 4, 'fixed_workflow_only': 1}


def test_an_empty_workflow_red_is_a_claim_of_green(tmp_path):
    """`[]` is what the prompt asks for when the workflow test passes, and must
    read the same as saying nothing -- not as a red submission."""
    recs = _dispositions(tmp_path, _RedScript(red={'BUG-003': []}))
    assert recs['BUG-003']['disposition'] == 'fixed'


def test_a_red_workflow_does_not_disturb_the_other_branches(tmp_path):
    """The split happens inside the plain-`fixed` branch only. A task whose probe
    never demonstrated the defect is still `fixed_workflow_only`, because the
    unverified remediation axis is the more serious of the two facts."""
    script = _RedScript(red={'BUG-003': ['w.test.ts :: a']},
                        probe={'BUG-003': 'NOT_PROVEN'})
    recs = _dispositions(tmp_path, script)
    assert recs['BUG-003']['disposition'] == 'fixed_workflow_only'


def test_it_is_a_disposition_but_never_a_green_one():
    assert 'fixed_workflow_red' in dispatcher.DISPOSITIONS
    assert 'fixed_workflow_red' in report_mod.DISPOSITIONS
    assert 'fixed_workflow_red' not in dispatcher.GREEN_DISPOSITIONS


def test_the_two_contracts_know_about_it_too():
    """Both schemas close their disposition lists (`enum`, and an object with
    `additionalProperties: false`), so a new disposition that reaches a record
    without reaching them makes the record schema-INVALID rather than merely
    undocumented. Pinned as an equality against the code's own tuple, because the
    drift is silent: nothing at runtime validates, so the first symptom would be a
    contract test on a run that has already been paid for."""
    contracts = os.path.join(os.path.dirname(__file__), '..', 'contracts')
    with open(os.path.join(contracts, 'task-record.schema.json')) as fh:
        rec_schema = json.load(fh)
    with open(os.path.join(contracts, 'patcher-report.schema.json')) as fh:
        rep_schema = json.load(fh)

    assert set(rec_schema['properties']['disposition']['enum']) == \
        set(dispatcher.DISPOSITIONS)

    counts = rep_schema['properties']['totals']['properties']['dispositions']
    assert set(counts['properties']) == set(report_mod.DISPOSITIONS)

    # And the attestation's own two new fields, for the same reason.
    att = rec_schema['properties']['attested']['properties']
    assert 'workflow_red' in att and 'antioracle_claims' in att
    assert set(att['antioracle_claims']['items']['properties']) == {
        'test', 'it_title', 'why'}


def test_the_tree_still_merges():
    """Reporting only. Adding this to the revert set would throw away a fix that
    is very possibly correct, on the strength of an unadjudicated claim."""
    assert 'fixed_workflow_red' not in dispatcher.REVERT_DISPOSITIONS


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------

def _rec(bug_id, disposition, *, attested=None):
    return {
        'bug_id': bug_id, 'location': {'file': 'routes/a.ts', 'line': 1},
        'disposition': disposition, 'disposition_reason': None,
        'measured': {
            'characterisation': {'workflow_green_pre_fix': True,
                                 'probe_proven_pre_fix': True, 'attempts': 1,
                                 'related_test_files': []},
            'rounds': [], 'final_gates': {}, 'rounds_to_green': None,
            'wall_s': 1.0, 'cost_usd': 0.0, 'invocations': [],
        },
        'attested': attested,
        'attestation_delta': None,
        'diff_stats': {'files_touched': ['routes/a.ts'], 'lines_added': 4,
                       'lines_removed': 1, 'touched_outside_bug_file': False,
                       'net_deletion': False},
        'violations': [],
    }


CLEAN_AUDIT = {'contaminated': False, 'input_scrub': {}, 'runtime_denials': {},
               'notes': []}


def _agg(records):
    return report_mod.aggregate(records, run_meta={'run_id': 'r'},
                                blind_audit=CLEAN_AUDIT, agent_desc={'runner': 'fake'})


def test_aggregate_counts_it_in_its_own_bucket():
    att = {'status': 'fixed', 'workflow_red': ['w.test.ts :: a'],
           'antioracle_claims': []}
    r = _agg([_rec('A', 'fixed', attested={'status': 'fixed'}),
              _rec('B', 'fixed_workflow_red', attested=att),
              _rec('C', 'fixed_workflow_red', attested=att)])
    d = r['totals']['dispositions']
    assert d['fixed_workflow_red'] == 2
    # And nowhere else. `fixed` is the number a reader will quote.
    assert d['fixed'] == 1
    assert d['fixed_workflow_only'] == 0
    assert r['totals']['tasks'] == 3


def test_it_is_not_folded_into_any_green_total():
    """No total anywhere in the report may equal fixed + fixed_workflow_red."""
    r = _agg([_rec('A', 'fixed', attested={'status': 'fixed'}),
              _rec('B', 'fixed_workflow_red',
                   attested={'status': 'fixed', 'workflow_red': ['w.test.ts :: a']})])
    t = r['totals']
    assert t['dispositions']['fixed'] == 1
    # A red-workflow task is not reverted, so it must not appear there either.
    assert t['tasks_reverted'] == 0
    flat = json.dumps(t)
    assert '"fixed": 2' not in flat


def test_the_rendered_summary_names_it_separately():
    r = _agg([_rec('A', 'fixed_workflow_red',
                   attested={'status': 'fixed', 'workflow_red': ['w.test.ts :: a']})])
    text = report_mod.render_summary(r)
    assert 'workflow left red' in text


# ---------------------------------------------------------------------------
# The prompt has to ask for what the record reads
# ---------------------------------------------------------------------------

def test_the_v3_fix_prompt_asks_for_both_fields(tmp_path):
    """A field the record parses and the prompt never mentions is a field that is
    always empty, and an always-empty `workflow_red` reads as always-green."""
    script = Script()
    d, trunk, _runner = _build(tmp_path, script)
    a = d.assignments['A01']
    text = dispatcher.build_patch_prompt(
        a, BUGS[0], tree=trunk, cfg=CFG, cmap=d.cmap, playbook=None,
        scratch_rel='.patcher/x', reused_from=None, max_rounds=3)
    assert '"workflow_red"' in text
    assert '"antioracle_claims"' in text
    assert 'it_title' in text
    # Recorded, not adjudicated -- the prompt must not imply a verdict follows.
    assert 'adjudicated' in text


def test_the_v1_fix_prompt_asks_for_both_fields():
    text = prompts.build_fix(
        tree='/t', bug={'bug_id': 'BUG-001', 'class': 'AuthZ',
                        'location': {'file': 'routes/a.ts', 'line': 1},
                        'title': 't', 'description': 'd'},
        characterisation={'bug_id': 'BUG-001'}, playbook_entry=None,
        playbook_how='none', general_guidance=None,
        workflow_rel='w.test.ts', probe_rel='p.ts', probe_proven=True,
        workflow_cmd='c', probe_cmd='c', typecheck_cmd='c',
        attestation_path='a.json', round_no=0)
    assert '"workflow_red"' in text
    assert '"antioracle_claims"' in text
    assert 'adjudicated' in text


# ---------------------------------------------------------------------------
# The blind boundary
# ---------------------------------------------------------------------------

def test_a_workflow_red_string_can_never_reach_the_published_row():
    """Every `workflow_red` entry names a test file, and every anti-oracle claim
    pairs that file with the defect the agent believed it asserted. That is the
    located shape the publishing rule forbids, so the lists stay in the per-task
    record and only the bare disposition NAME is published."""
    for key in ('workflow_red', 'antioracle_claims'):
        try:
            archive_run.assert_publishable(
                {'run_id': 'r', 'in_sandbox': {key: ['w.test.ts :: a']}})
        except archive_run.ArchiveError:
            pass
        else:
            raise AssertionError(f'{key} was accepted into a published row')


def test_a_workflow_red_value_trips_the_source_path_guard():
    """Belt and braces: even mislabelled under an innocent key, the entry's own
    text carries a test file path and the value patterns catch it."""
    try:
        archive_run.assert_publishable(
            {'run_id': 'r', 'notes': 'left red: routes/basket.ts :: reads a basket'})
    except archive_run.ArchiveError:
        return
    raise AssertionError('a located workflow_red entry was accepted')


def test_the_bare_disposition_name_is_publishable():
    """The histogram key is a count under a name that locates nothing, and it has
    to get through -- a guard that rejected it would push the number out of the
    aggregate row, which is the only place it is durable."""
    archive_run.assert_publishable(
        {'run_id': 'r',
         'in_sandbox': {'dispositions': {'fixed': 3, 'fixed_workflow_red': 2}}})
