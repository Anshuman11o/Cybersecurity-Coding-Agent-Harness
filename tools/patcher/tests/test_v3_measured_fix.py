"""v3's fix phase, measured: the reconcile loop, actually driven.

v3's architecture always specified this loop -- fix, verify, hand the failure
back, up to `loop.reconcile_rounds`. What its first three runs implemented was
that loop written into a prompt with nothing enforcing it: the dispatcher spent
one call, read `attestation.json`, and wrote down what it said, including
`rounds_used`, a number the agent types about itself. That is an
under-implementation of the architecture, and nothing in the record could
distinguish these two runs:

  * an agent that patched the defect, found its workflow test red, spent four
    rounds looking for the version of the fix that satisfies both axes, and
    finished green;
  * an agent that patched the defect, found its workflow test red, decided in
    prose that the assertion was illegitimate, wrote `"rounds_used": 4`, and
    stopped after one.

The second is not a hypothetical failure mode; it is the cheapest way to finish,
and the prompt's own anti-oracle escape sat structurally upstream of the
reconcile step, so an agent that found the escape never reached the loop at all.
A reconcile budget that the party being measured reports about itself is not a
budget.

So the fix phase runs through `task_loop.run_fix_loop` -- the same orchestrator
loop v1 uses, with the same three machine-checked exits: measured green, the
round budget, the wall clock. An anti-oracle claim is not one of them. The
dispositions that come out of it are `disposition_basis: measured`, and
`measured.rounds_used` is what this process counted.

What the orchestrator owns is the ROUND BOUNDARY: it invokes, it measures, it
hands the failure back. It does not write code, choose the fix, or self-verify in
the agent's place -- the agent still runs its own typecheck, workflow test, probe
and net inside its turn, and is still the only party deciding what to change.

What is pinned here is the wiring, because every one of these is a way to hook a
loop up that still passes a green-path test:

  * the loop's `max_rounds` is a TOTAL and includes round 0, so a caller whose
    budget is `reconcile_rounds` must pass one more than that. Passing it raw
    silently buys one round fewer than the config asks for.
  * `baseline_outcomes` has to be collected BEFORE the fix. Without it every
    already-red row in the regression net is charged to this task, and a task
    with one pre-existing failure anywhere in its net is labelled `vuln_only` no
    matter what the agent does -- a measurement reporting damage that was there
    before the patcher arrived.
  * the loop never restores the tree. It hands back the best round's snapshot and
    the caller keeps or reverts; a caller that forgets leaks one tar per task and
    ships whichever round happened to run last.
  * an attestation is recorded, never believed -- not its `rounds_used`, and not
    its account of which assertions do not count.

The cost is real: the gates run once per round per task, so wall time per task
rises and `loop.chunk_timeout_s` may need raising before a run.

The fake application is the v3 fixture's: `Script` writes a workflow test that
passes unless the source carries BROKE_FEATURE, and a probe that prints
NOT_PROVEN once the source carries `// fixed <bug id>`. Between them every square
of the 2x2 the labels are drawn from is reachable by one line of scripted intent.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import task_loop  # noqa: E402
import workspace  # noqa: E402
from v3 import dispatcher  # noqa: E402

from test_v3_dispatcher import (BUGS, CFG, Script, _build, _map_doc,  # noqa: E402
                                _read, _write)

TOTAL_ROUNDS = CFG['loop']['reconcile_rounds'] + 1

# A related test that is red before the patcher touches anything: the shape the
# baseline sweep exists for.
ALREADY_RED_REL = 'test/api/b.test.ts'
ALREADY_RED = '''\
import sys
# exercises lib/b.ts
print("not ok 1 - b already fails")
sys.exit(1)
'''


def _tasks(rep):
    return {t['bug_id']: t for t in
            (t for p in rep['phases'] for c in p['chunks'] for t in c['tasks'])}


class _PerBug(Script):
    """`Script`, with the behaviour of ONE bug overridden per round.

    `plan[bug_id]` is a list of `(fix, break_feature)` pairs, one per round; the
    last entry repeats. Every other bug keeps the well-behaved default, so a test
    that is about one square of the 2x2 does not have to describe the other four.
    """

    def __init__(self, plan, *, related=(), **kw):
        super().__init__(**kw)
        self.plan = plan
        self.related = list(related)
        self.rounds: dict = {}          # bug_id -> rounds seen so far

    def __call__(self, prompt, phase, task_id, cwd):
        import re
        m = re.search(r'## This step: (\w+) bug (\S+) \(([^:]+):', prompt)
        step, bug_id, rel = m.group(1), m.group(2), m.group(3)

        if step == 'characterise':
            ok = super().__call__(prompt, phase, task_id, cwd)
            if self.related:
                path = os.path.join(cwd, workspace.scratch_rel(task_id),
                                    'characterisation.json')
                doc = json.load(open(path))
                doc['related_test_files'] = self.related
                _write(path, json.dumps(doc))
            return ok

        if bug_id not in self.plan:
            return super().__call__(prompt, phase, task_id, cwd)

        n = self.rounds.get(bug_id, 0)
        self.rounds[bug_id] = n + 1
        fix, break_feature = self.plan[bug_id][min(n, len(self.plan[bug_id]) - 1)]
        # Recorded on the base class's ledger too, so `steps()` still sees it.
        self.calls.append((step, bug_id, rel, cwd))
        self.prompts.append(prompt)
        src = os.path.join(cwd, rel)
        with open(src, 'a') as fh:
            if fix:
                fh.write(f'// fixed {bug_id}\n')
            if break_feature:
                fh.write('// BROKE_FEATURE\n')
            if not fix and not break_feature:
                fh.write(f'// hardening for {bug_id}\n')
        _write(os.path.join(cwd, workspace.scratch_rel(task_id), 'attestation.json'),
               json.dumps({'bug_id': bug_id, 'status': 'fixed', 'confidence': 0.9,
                           'rounds_used': 1}))
        return True

    def fix_rounds(self, bug_id):
        return sum(1 for s, b, _r, _c in self.calls if s == 'fix' and b == bug_id)


# ---------------------------------------------------------------------------
# Label -> disposition, one square at a time
# ---------------------------------------------------------------------------

def test_green_gates_are_a_measured_fixed(tmp_path):
    d, _t, _r = _build(tmp_path, Script())
    rec = _tasks(d.run())['BUG-001']
    assert rec['measured']['label'] == 'green'
    assert rec['disposition'] == 'fixed'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert 'Measured by the orchestrator, not attested' in rec['disposition_reason']


def test_the_defect_closed_over_a_red_workflow_is_fixed_workflow_red(tmp_path):
    """`vuln_only`: the path is demonstrably closed and a gate is demonstrably
    red. The disposition was previously produced from the agent's own list; it is
    now the output of a measurement, and the claim sits beside it rather than
    deciding it."""
    d, _t, _r = _build(tmp_path, _PerBug({'BUG-003': [(True, True)]}))
    rec = _tasks(d.run())['BUG-003']
    assert rec['measured']['label'] == 'vuln_only'
    assert rec['disposition'] == 'fixed_workflow_red'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert rec['measured']['final_gates'] == {
        'typecheck': 'pass', 'workflow': 'fail', 'probe_blocked': 'pass',
        'no_regression': 'skipped'}


def test_a_clean_tree_with_the_probe_unclosed_is_fixed_workflow_only(tmp_path):
    """`workflow_only`. Here the probe never demonstrated the defect at all, so
    V3 was skipped rather than passed -- a skipped remediation gate is not a
    closed vulnerability, and the two are never summed."""
    d, _t, _r = _build(tmp_path, Script(probe={'BUG-003': 'NOT_PROVEN'}))
    rec = _tasks(d.run())['BUG-003']
    assert rec['measured']['label'] == 'workflow_only'
    assert rec['disposition'] == 'fixed_workflow_only'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert rec['measured']['final_gates']['probe_blocked'] == 'skipped'


def test_neither_axis_with_work_on_disk_is_partial(tmp_path):
    """`neither`, and the work is kept: v3 submits a chunk whole, so a per-task
    revert would also drop the tasks around it. The record says which gates were
    red rather than leaving `partial` to be read as a near miss."""
    d, _t, _r = _build(tmp_path, _PerBug({'BUG-003': [(False, True)]}))
    rec = _tasks(d.run())['BUG-003']
    assert rec['measured']['label'] == 'neither'
    assert rec['disposition'] == 'partial'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert 'V3_probe_blocked=fail' in rec['disposition_reason']
    assert rec['diff_stats']['files_touched']


def test_a_task_that_changed_nothing_is_abandoned_whatever_the_label_says(tmp_path):
    """An unchanged tree cannot have fixed anything, and the empty-diff branch
    therefore sits AHEAD of the label mapping.

    The agent here edits nothing at all, so the workflow test still passes and
    the net is still clean: the label is `workflow_only`, which maps to
    `fixed_workflow_only`. Taking that mapping would put a task with no diff into
    a bucket whose name starts with `fixed`. The diff is the measurement that
    wins, and the agent's `fixed` claim is recorded as the overclaim it is.
    """
    d, _t, _r = _build(tmp_path, Script(edit=False))
    rec = _tasks(d.run())['BUG-001']
    assert rec['measured']['label'] == 'workflow_only'
    assert rec['disposition'] == 'abandoned'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert 'nothing was patched' in ' '.join(rec['disposition_reason'].split())
    assert rec['diff_stats']['files_touched'] == []
    assert rec['attestation_delta']['kind'] == 'overclaim'


def test_no_usable_invocation_is_agent_failed_and_says_what_was_measured(tmp_path):
    """`agent_failed` outranks the gates, and must not be read as "revert because
    the tree is bad": it can be reached with green gates and a missing
    attestation. So the reason carries the gate result that is being thrown
    away, and the revert is a separate, stated decision -- a change nobody can
    describe is not submittable, whatever it measured."""
    d, trunk, _r = _build(tmp_path, Script(fail={('fix', 'BUG-005')}))
    rec = _tasks(d.run())['BUG-005']
    assert rec['measured']['label'] == 'agent_failed'
    assert rec['disposition'] == 'agent_failed'
    assert rec['disposition_basis'] == dispatcher.MEASURED
    assert 'V1_typecheck' in rec['disposition_reason']
    assert rec['diff_stats']['files_touched'] == []
    assert 'fixed BUG-005' not in _read(trunk, 'routes/c.ts')


def test_a_missing_attestation_is_agent_failed_even_over_green_gates(tmp_path):
    d, _t, _r = _build(tmp_path, Script(no_attestation={'BUG-003'}))
    rec = _tasks(d.run())['BUG-003']
    assert rec['measured']['label'] == 'agent_failed'
    assert rec['measured']['final_gates']['probe_blocked'] == 'pass'   # it worked
    assert rec['disposition'] == 'agent_failed'
    assert 'attestation.json' in rec['disposition_reason']


def test_every_fix_phase_disposition_is_measured(tmp_path):
    """The whole point, asserted over a mixed run rather than one record.

    `already_remediated` is the one that stays attested: it is decided before the
    fix phase, from `characterisation.json` alone, and no gate is run for it.
    """
    doc = _map_doc()
    doc['brackets'][0]['chunks'][0]['tasks'][1]['line'] = 1       # same file:line
    bugs = [dict(b) for b in BUGS]
    bugs[1] = dict(bugs[1], location={'file': 'lib/a.ts', 'line': 1})
    d, _t, _r = _build(tmp_path, Script(probe={'BUG-002': 'NOT_PROVEN'}),
                       doc=doc, bugs=bugs, reuse_characterisation=False)
    rep = d.run()
    recs = _tasks(rep)

    assert recs['BUG-002']['disposition'] == 'already_remediated'
    assert recs['BUG-002']['disposition_basis'] == dispatcher.ATTESTED
    for bug_id, rec in recs.items():
        if bug_id == 'BUG-002':
            continue
        assert rec['disposition_basis'] == dispatcher.MEASURED, bug_id
    assert rep['disposition_basis'] == {'measured': 4, 'attested': 1}


# ---------------------------------------------------------------------------
# The round budget: a total, not a reconcile count
# ---------------------------------------------------------------------------

def test_the_loop_is_given_one_more_round_than_the_reconcile_budget(
        tmp_path, monkeypatch):
    """`loop.reconcile_rounds` counts RECONCILES; `run_fix_loop`'s `max_rounds`
    counts every round including round 0, the fix itself. Passing the config
    value raw would give the agent one fewer attempt than the run was configured
    for, and nothing in the record would say so -- the round table would simply
    be shorter."""
    seen = {}
    real = task_loop.run_fix_loop

    def spy(**kw):
        seen.update(kw)
        return real(**kw)

    monkeypatch.setattr(task_loop, 'run_fix_loop', spy)
    d, _t, _r = _build(tmp_path, Script())
    d.run(phases=[0])

    assert d.max_rounds == CFG['loop']['reconcile_rounds']
    assert seen['max_rounds'] == CFG['loop']['reconcile_rounds'] + 1 == TOTAL_ROUNDS
    # And the number the agent is TOLD is still the reconcile budget, which is
    # what it has always been told.
    assert f'up to {d.max_rounds}\n   rounds' in seen['build_prompt'](0, None, '')


def test_an_agent_that_never_goes_green_is_invoked_for_the_whole_budget(tmp_path):
    script = _PerBug({'BUG-003': [(False, True)]})
    d, _t, _r = _build(tmp_path, script)
    rec = _tasks(d.run())['BUG-003']
    assert script.fix_rounds('BUG-003') == TOTAL_ROUNDS
    assert rec['measured']['rounds_used'] == TOTAL_ROUNDS
    assert [r['round'] for r in rec['measured']['rounds']] == list(range(TOTAL_ROUNDS))
    assert rec['measured']['gates_run'] == TOTAL_ROUNDS


def test_the_loop_stops_the_moment_it_measures_green(tmp_path):
    """The budget is a ceiling, not a quota: a green round 0 costs one call."""
    script = _PerBug({'BUG-003': [(True, False)]})
    d, _t, _r = _build(tmp_path, script)
    rec = _tasks(d.run())['BUG-003']
    assert script.fix_rounds('BUG-003') == 1
    assert rec['measured']['rounds_used'] == 1
    assert rec['measured']['rounds_to_green'] == 0


# ---------------------------------------------------------------------------
# The claim is recorded and acted on by nothing
# ---------------------------------------------------------------------------

class _ClaimsAntiOracle(_PerBug):
    """Closes the defect, breaks the feature, and explains on round 0 that the
    failing assertion is an anti-oracle and the residual risk is accepted."""

    def __call__(self, prompt, phase, task_id, cwd):
        ok = super().__call__(prompt, phase, task_id, cwd)
        path = os.path.join(cwd, workspace.scratch_rel(task_id), 'attestation.json')
        if phase in ('fix', 'reconcile') and os.path.isfile(path):
            doc = json.load(open(path))
            if doc.get('bug_id') in self.plan:
                doc.update({
                    'residual_risk': 'the assertion cannot be satisfied by a correct '
                                     'fix, so it is left red',
                    'workflow_red': ['workflow.test.ts :: feature still works'],
                    'antioracle_claims': [
                        {'test': 'workflow.test.ts',
                         'it_title': 'feature still works',
                         'why': 'it asserts the attack still lands'}],
                    'rounds_used': 1})
                _write(path, json.dumps(doc))
        return ok


def test_an_antioracle_claim_on_round_zero_does_not_end_the_loop(tmp_path):
    """The failure this wiring exists to prevent. Every word of the claim may be
    true; none of it is measured, so it buys no early exit. The budget is spent,
    the label is what the gates said, and the claim is on the record for a
    human."""
    script = _ClaimsAntiOracle({'BUG-003': [(True, True)]})
    d, _t, _r = _build(tmp_path, script)
    rec = _tasks(d.run())['BUG-003']

    assert script.fix_rounds('BUG-003') == TOTAL_ROUNDS        # invoked again, and again
    assert rec['measured']['label'] == 'vuln_only'
    assert rec['disposition'] == 'fixed_workflow_red'
    assert rec['attested']['antioracle_claims'] == [
        {'test': 'workflow.test.ts', 'it_title': 'feature still works',
         'why': 'it asserts the attack still lands'}]
    assert rec['attested']['workflow_red'] == ['workflow.test.ts :: feature still works']


def test_a_lying_rounds_used_never_reaches_the_measured_record(tmp_path):
    """`attested.rounds_used` is kept, because the delta between what the agent
    claims about its own effort and what the loop counted is itself a finding.
    What must never happen is the claim landing in `measured`."""
    script = _ClaimsAntiOracle({'BUG-003': [(True, True)]})
    d, _t, _r = _build(tmp_path, script)
    rec = _tasks(d.run())['BUG-003']

    assert rec['attested']['rounds_used'] == 1                 # the claim
    assert rec['measured']['rounds_used'] == TOTAL_ROUNDS      # what was run
    assert len(rec['measured']['rounds']) == TOTAL_ROUNDS


# ---------------------------------------------------------------------------
# The baseline
# ---------------------------------------------------------------------------

def test_a_test_that_was_already_red_is_not_charged_to_this_task(tmp_path):
    """Without `baseline_outcomes` the gate has no "before", so every red row in
    the net counts as damage this task did. A task with one pre-existing failure
    would then be `vuln_only` -- and therefore `fixed_workflow_red` -- no matter
    what the agent wrote, which is a measurement reporting damage that predates
    the patcher."""
    script = _PerBug({}, related=[ALREADY_RED_REL])
    d, trunk, _r = _build(tmp_path, script)
    _write(os.path.join(trunk, ALREADY_RED_REL), ALREADY_RED)

    rec = _tasks(d.run())['BUG-003']

    assert rec['related_test_files'] == [ALREADY_RED_REL]       # it was in the net
    assert rec['measured']['final_gates']['no_regression'] == 'pass'
    assert rec['measured']['label'] == 'green'
    assert rec['disposition'] == 'fixed'
    # And it is on the record as pre-existing, not silently dropped.
    assert rec['measured']['characterisation']['baseline_failures'] == [
        f'{ALREADY_RED_REL}: b already fails']


def test_the_workflow_test_is_swept_pre_fix_so_a_broken_oracle_is_visible(tmp_path):
    """G1, measured. The workflow test runs once against the untouched tree, so a
    task whose own oracle was already red is identifiable afterwards instead of
    having every later V2 failure attributed to its fix."""
    d, _t, _r = _build(tmp_path, Script())
    rec = _tasks(d.run())['BUG-001']
    assert rec['measured']['characterisation']['workflow_green_pre_fix'] is True
    # The probe is NOT swept pre-fix; that verdict stays the agent's.
    assert rec['measured']['characterisation']['probe_proven_pre_fix'] is None
    assert rec['attested_characterisation']['probe_proven_pre_fix'] is True


class _PreBrokenOracle(Script):
    """Writes a workflow test that is red before anything is patched."""

    def __call__(self, prompt, phase, task_id, cwd):
        ok = super().__call__(prompt, phase, task_id, cwd)
        if phase == 'characterise' and 'BUG-003' in prompt:
            _write(os.path.join(cwd, workspace.scratch_rel(task_id),
                                'workflow.test.ts'),
                   'import sys\nprint("not ok 1 - broken from the start")\n'
                   'sys.exit(1)\n')
        return ok


def test_a_workflow_test_that_was_red_before_the_fix_says_so_in_the_reason(tmp_path):
    """The gate cannot excuse it -- V2 has no baseline comparison, and inventing
    one would let an agent buy a green gate by shipping a broken oracle. What the
    record can do is refuse to let the failure read as damage from this change."""
    d, _t, _r = _build(tmp_path, _PreBrokenOracle())
    rec = _tasks(d.run())['BUG-003']
    assert rec['measured']['characterisation']['workflow_green_pre_fix'] is False
    assert rec['disposition'] == 'fixed_workflow_red'
    assert 'ALREADY RED against the unmodified tree' in rec['disposition_reason']


# ---------------------------------------------------------------------------
# The snapshot the loop hands back
# ---------------------------------------------------------------------------

def _snapshots(tree):
    d = os.path.join(tree, '.patcher-snapshots')
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


def test_the_best_round_is_restored_not_the_last_one(tmp_path):
    """Preservation outranks remediation, and the loop only SELECTS -- restoring
    is the caller's job and is easy to leave out, because the green path never
    needs it.

    Round 0 hardens without closing the path and breaks nothing. Round 1 closes
    the path by destroying the feature. Round 1 is the more recent tree and the
    worse one; what must be on disk at the end is round 0's.
    """
    script = _PerBug({'BUG-003': [(False, False), (True, True)]})
    d, trunk, _r = _build(tmp_path, script)
    rec = _tasks(d.run())['BUG-003']

    assert script.fix_rounds('BUG-003') == TOTAL_ROUNDS
    assert rec['measured']['label'] == 'workflow_only'        # the SELECTED round
    assert rec['measured']['rounds'][1]['gates']['V2_workflow'] == 'fail'
    src = _read(trunk, 'lib/b.ts')
    assert 'hardening for BUG-003' in src
    assert 'BROKE_FEATURE' not in src and 'fixed BUG-003' not in src


def test_no_snapshot_is_left_behind_by_any_task(tmp_path):
    """One tar per round per task, in the tree being submitted. A caller that
    takes the best snapshot and never discards it leaks them for the length of a
    chunk and puts them in the merge queue's way."""
    d, trunk, _r = _build(tmp_path, _PerBug({'BUG-003': [(False, True)]}))
    d.run()
    for chunk_id in ('A01', 'A02', 'B01', 'C01'):
        assert _snapshots(d.chunk_tree(chunk_id)) == [], chunk_id
    assert _snapshots(trunk) == []


# ---------------------------------------------------------------------------
# The record and the contract
# ---------------------------------------------------------------------------

def _schema(name):
    with open(os.path.join(os.path.dirname(__file__), '..', 'contracts', name)) as fh:
        return json.load(fh)


def test_every_field_a_v3_record_carries_is_in_the_task_record_contract(tmp_path):
    """`task-record.schema.json` is `additionalProperties: false` at every level
    that matters, so a field the code records and the contract does not name
    makes the record schema-INVALID rather than merely undocumented. Nothing
    validates at runtime, so the first symptom would otherwise be a contract test
    on a run that has already been paid for."""
    d, _t, _r = _build(tmp_path, _PerBug({'BUG-003': [(True, True)]}))
    rec = _tasks(d.run())['BUG-003']
    schema = _schema('task-record.schema.json')

    def names(node):
        return set(node['properties'])

    assert set(rec) <= names(schema)
    measured = schema['properties']['measured']
    assert set(rec['measured']) <= names(measured)
    assert set(rec['measured']['characterisation']) <= \
        names(measured['properties']['characterisation'])
    for rnd in rec['measured']['rounds']:
        assert set(rnd) <= names(measured['properties']['rounds']['items'])
        # Including the bare `V1`..`V4` duplicates `verify.VerifyResult.fail`
        # writes beside the long names. They are in the record, so they are in
        # the contract; nothing that renders a gate list for a human reads them.
        assert set(rnd['gates']) <= names(
            measured['properties']['rounds']['items']['properties']['gates'])
    assert rec['measured']['label'] in \
        schema['properties']['measured']['properties']['label']['enum']
    assert rec['disposition_basis'] in \
        schema['properties']['disposition_basis']['enum']


def test_the_per_round_gate_detail_stays_out_of_a_published_row():
    """A round entry names the test files that failed, which is the located shape
    the publishing rule forbids. It belongs in the per-task record and the
    private store; what may be published is the count."""
    import archive_run
    try:
        archive_run.assert_publishable(
            {'run_id': 'r',
             'in_sandbox': {'rounds': [{'failures': [
                 {'test_file': 'test/api/b.test.ts'}]}]}})
    except archive_run.ArchiveError:
        pass
    else:
        raise AssertionError('per-round gate detail was accepted into a published row')

    archive_run.assert_publishable(
        {'run_id': 'r', 'in_sandbox': {'gates_run': 42, 'rounds_used_median': 2,
                                       'dispositions': {'fixed': 3}}})


def test_the_phase_names_are_still_the_ones_the_sandbox_hook_accepts():
    """The loop derives the phase from the round -- `fix` for round 0, `reconcile`
    after -- and both must stay in the hook's vocabulary, or the guard exits on
    argparse having written no decision and the whole of the fix phase's
    enforcement is silently absent. Same shape as the v2 denylist incident."""
    import sandbox_guard
    assert task_loop._phase_for_round(0) == dispatcher.PATCH_PHASE == 'fix'
    assert task_loop._phase_for_round(1) == 'reconcile'
    for phase in ('fix', 'reconcile'):
        oracle = sandbox_guard.check_path(
            f'{workspace.SCRATCH_DIRNAME}/A01-BUG-001/workflow.test.ts',
            '/tmp/tree', '/tmp/tree', writing=True, phase=phase,
            task='A01-BUG-001', extra_path_patterns=())
        assert not oracle.allow and oracle.kind == 'gate_artefact_edit', phase


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def _patch_prompt(d, **kw):
    return dispatcher.build_patch_prompt(
        d.assignments['A01'], BUGS[0], tree='/t', cfg=CFG, cmap=d.cmap,
        playbook=None, scratch_rel='.patcher/x', reused_from=None,
        max_rounds=3, **kw)


def test_the_only_exception_left_in_the_self_check_is_a_pre_existing_failure(tmp_path):
    """The anti-oracle escape used to sit in step 2, structurally upstream of the
    reconcile loop, so an agent that found it never reached step 3. One exception
    remains, and a test that appears to require the attack is explicitly routed
    into the loop instead of out of it."""
    d, _t, _r = _build(tmp_path, Script())
    text = _patch_prompt(d)
    assert 'One exception, and it is the only one' in text
    assert 'ALREADY FAILING before' in text
    assert 'is **not** an exception' in text
    assert 'It is an input to step 3' in text


def test_the_hardest_case_is_named_as_the_hardest_case_not_an_exemption(tmp_path):
    d, _t, _r = _build(tmp_path, Script())
    text = _patch_prompt(d)
    assert 'HARDEST case of this step, not an exemption' in text
    assert 'closes the path AND leaves that assertion green' in text
    assert 'not on round one' in text


def test_the_exit_tells_the_agent_to_keep_the_fix_and_that_it_is_being_measured(
        tmp_path):
    """Both halves matter. Without the first an agent under a red gate reverts its
    own correct fix to buy a green one; without the second the measurement is a
    gotcha, and an agent that does not know the rounds are counted has no reason
    to spend them."""
    d, _t, _r = _build(tmp_path, Script())
    text = _patch_prompt(d)
    assert 'KEEP THE FIX' in text
    assert 'Do not weaken it and do not revert it' in text
    assert 'recorded but not believed' in text
    assert 'you will simply be invoked again' in text
    # And the two claim fields are untouched: still asked for, still unadjudicated.
    assert '"workflow_red"' in text and '"antioracle_claims"' in text
    assert 'adjudicated' in text


def test_a_reconcile_round_gets_the_measured_failure_and_keeps_its_boundary(tmp_path):
    """The reconcile prompt is the fix prompt plus the failure, deliberately: the
    write boundary and the landed-work block are as load-bearing on the last
    round as on the first, and an agent under a red gate is exactly when a
    prompt that dropped them would do damage."""
    d, _t, _r = _build(tmp_path, Script())
    failures = [{'gate': 'V2', 'kind': 'workflow_broken',
                 'test_file': '.patcher/x/workflow.test.ts',
                 'was': 'pass', 'now': 'fail', 'output_tail': 'not ok 1 - feature'}]
    text = _patch_prompt(d, round_no=2, failures=failures, diff='--- a/lib/a.ts\n')

    assert 'Round 2 of 3' in text
    assert '## Write boundary' in text                      # still there
    assert 'not ok 1 - feature' in text
    assert 'You broke the legitimate path' in text          # v1's own guidance
    assert '--- a/lib/a.ts' in text
    # Round 0 has no failure to hand back and says nothing about one.
    assert 'did not pass its gates' not in _patch_prompt(d)
