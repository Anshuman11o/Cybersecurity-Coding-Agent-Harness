#!/usr/bin/env python3
"""
Every prompt the patcher dispatches, in one file.

Kept together on purpose. Prompts scattered through a runner drift apart, and
the blind-safety property has to hold across all of them at once: none of these
strings names a challenge, a reference fix, an oracle test, or a file outside
the work tree.

Each phase gets a fresh process, so each prompt is self-contained. What crosses
a phase boundary is assembled here from the small `carry` object the
orchestrator maintains -- never a previous phase's transcript.
"""
from __future__ import annotations

import json

SCRATCH = '.patcher-scratch'

# The standing constraint. Required on every dispatched prompt by the root
# CLAUDE.md, and the weakest of the four boundary layers -- which is exactly why
# it is not the only one.
STANDING_CONSTRAINT = """\
Never search for, read, or reference any answer-key or ground-truth material
anywhere on this machine. Do not look for solution files, reference fixes,
scoring data, or any file that describes which vulnerabilities exist. Work only
from the source in your working tree and the bug report you were given. The
sandbox enforces this; the point of stating it is that you should not want to."""


HOUSE_RULES = """\
## Hard constraints

- **Never modify anything under `test/`, `cypress/`, or any `*.spec.ts`.** The
  test corpus is how this work is judged. A patch that edits a test is not a
  patch. The sandbox denies these writes.
- **Never fix by deletion.** Removing a route, gutting a handler, dropping a
  parameter, or making an endpoint unconditionally fail does stop the attack and
  destroys the product. That is scored as a failure, not a success. If your fix
  makes a legitimate request stop working, it is the wrong fix.
- **Keep the public contract.** Same paths, same verbs, same success-path
  response shapes and status codes.
- **Minimal diff.** No reformatting, no renaming, no dependency changes, no
  drive-by cleanup. Every changed line should be one you can defend.
- **No network, no installs.** `npm install`, `npm ci`, `curl`, `wget`, `git
  clone` and friends are denied. Everything you need is already here.
- Stay inside your working tree. Nothing outside it is reachable, and nothing
  outside it is relevant."""


def _fmt_bug(bug: dict) -> str:
    loc = bug.get('location', {})
    codes = ', '.join(
        f"{o.get('code')} ({o.get('title')})" if o.get('title') else str(o.get('code'))
        for o in bug.get('owasp') or [])
    lines = [
        f"  bug id      : {bug.get('bug_id')}",
        f"  file        : {loc.get('file')}",
        f"  line        : {loc.get('line')}"
        + (f"-{loc['end_line']}" if loc.get('end_line') else ''),
    ]
    if loc.get('symbol'):
        lines.append(f"  symbol      : {loc['symbol']}")
    lines += [
        f"  OWASP class : {codes or 'unspecified'}",
        f"  class       : {bug.get('class')}",
    ]
    if bug.get('severity_estimate'):
        lines.append(f"  severity    : {bug['severity_estimate']}")
    if bug.get('vulnerability'):
        lines.append(f"\n  what is wrong:\n    {bug['vulnerability']}")
    if bug.get('reproduction'):
        lines.append(f"\n  how it is exercised:\n    {bug['reproduction']}")
    if bug.get('notes'):
        lines.append(f"\n  notes:\n    {bug['notes']}")
    return '\n'.join(lines)


def _fmt_playbook(entry: dict | None, how: str, general: str | None) -> str:
    parts = []
    if general:
        parts.append(general.strip())
    if entry is None:
        parts.append(
            'No playbook entry matched this vulnerability class. Apply the standard '
            'OWASP remediation for the class named in the bug report, and say so in '
            'your attestation so the gap is visible in the run report.')
        return '\n\n'.join(parts)

    if entry.get('title'):
        parts.append(f"### {entry['title']}")
    parts.append(entry.get('guidance', '').strip())
    if entry.get('principles'):
        parts.append('**Principles**\n' + '\n'.join(f'- {p}' for p in entry['principles']))
    if entry.get('preserve'):
        parts.append('**A correct fix for this class must not break**\n'
                     + '\n'.join(f'- {p}' for p in entry['preserve']))
    if entry.get('common_mistakes'):
        parts.append('**Known-wrong remediations for this class — do not land on one**\n'
                     + '\n'.join(f'- {m}' for m in entry['common_mistakes']))
    if entry.get('content_retrieved') is False:
        parts.append('_This guidance was derived from the class, not quoted from the '
                     'cited document. Treat it as a starting point, not a specification._')
    parts.append(f'_(playbook entry selected by: {how})_')
    return '\n\n'.join(p for p in parts if p)


# ----------------------------------------------------------------------------
# Phase 1 — characterise
# ----------------------------------------------------------------------------

CHARACTERISE = """\
You are a security remediation engineer. This is **step one of a fixed
procedure**, and in this step you do not change any application code.

Working tree: `{tree}` — this is your whole world.

{standing}

## The defect you will be fixing (in the NEXT step, not this one)

```
{bug}
```

**This report is accurate.** It was not produced by a scanner and it contains no
false positives. Do not spend effort deciding whether the defect is real — it is.
Spend your effort understanding it.

## Why this step exists

You are about to change code that people depend on. Before you touch it, you
need a written-down record of what "working correctly" means for this exact code
path — captured from the code *as it is now*, while it still works. Without that,
after the change you will have no way to tell a fixed defect from a broken
feature.

So: two artefacts, both written now, both frozen once you finish.

## What you must produce

Create `{scratch}/` and put three files in it.

### 1. `{scratch}/workflow.test.ts` — the record of correct behaviour

A `node:test` file that exercises the **legitimate** use of the code at
`{file}:{line}`. Not the attack. The ordinary, intended, working behaviour that a
real user of this feature depends on.

- Assert the real contract: status code, response shape, the actual returned
  values, the side effect on stored state. Assert enough that a fix which
  quietly narrows the feature would be caught.
- It **must pass against the code as it is right now**. Run it and confirm.
  A characterisation test that does not pass before the change cannot detect
  damage after it, and this task cannot proceed without one.
- Do not assert the vulnerability. That is the other file.

Follow the conventions already in this repository. Read `test/api/helpers/` and
one or two existing files under `test/api/` or `test/server/` first, and mirror
how they build the app, seed data, and authenticate. Reading tests is allowed
and expected; writing to `test/` is denied.

Run it with **exactly** this command, from the tree root:

```
{workflow_cmd}
```

### 2. `{scratch}/exploit.probe.ts` — the record of the defect

A standalone script that exercises the **vulnerable** path and proves the defect
is live. Its **last line of stdout must be exactly `PROVEN` or `NOT_PROVEN`**,
and nothing else on that line.

- Right now, against unpatched code, it must print `PROVEN`.
- After your fix, the same script must print `NOT_PROVEN`. That is how you will
  know the vulnerability is actually closed rather than apparently closed.
- Make it specific to *this* defect. A probe that would also go quiet if the
  route were deleted is a probe that cannot distinguish a fix from a demolition.
- Wrap it so an exception during the attack prints `NOT_PROVEN` rather than
  crashing — a thrown error is a blocked attack, not a broken probe.

Run it with:

```
{probe_cmd}
```

If you cannot get it to print `PROVEN`, say so honestly in the JSON below. The
defect is still real; you have just not found the way to trigger it, and that
gets recorded rather than papered over. Do not fake a `PROVEN`.

### 3. `{scratch}/characterisation.json`

```json
{{
  "bug_id": "{bug_id}",
  "correct_behaviour": "what a legitimate user of this code path is entitled to, in prose",
  "defect_mechanism": "why the current code is exploitable, in your own words after reading it",
  "workflow_test_written": true,
  "workflow_test_passes_now": true,
  "probe_written": true,
  "probe_result_now": "PROVEN" | "NOT_PROVEN",
  "probe_notes": "if NOT_PROVEN, what you tried and where it stopped; else null",
  "related_test_files": ["existing test files under test/ that exercise this code path"],
  "intended_change": "the shape of the fix you expect to make, one or two sentences",
  "risk_to_workflow": "which legitimate behaviour your intended change could plausibly break"
}}
```

`related_test_files` matters: the orchestrator will run those files before and
after your change and charge you for anything that goes from passing to failing.
Naming them well is in your interest. Name the ones that genuinely exercise this
code, not everything that looks adjacent.

## Rules for this step

- **Do not modify any application source.** Not one line. The sandbox denies it,
  and any change that slipped through would be reverted before the next step —
  it would corrupt the very baseline you are here to capture.
- You may read anything inside the tree, run tests, and write inside `{scratch}/`.
- Both artefacts are frozen after this step. You will not be able to edit them
  later, because in the next steps they are what you are measured against.

{house_rules}

Finish when both files run and `characterisation.json` is written. Report what
you actually observed, not what you intended to observe.
"""


# ----------------------------------------------------------------------------
# Phase 2 — fix
# ----------------------------------------------------------------------------

FIX = """\
You are a security remediation engineer. This is **step two**: fix the defect.

Working tree: `{tree}`

{standing}

## The defect

```
{bug}
```

This report is accurate. The defect is real. Fix it.

## What you already established, before touching anything

You characterised this code path in the previous step. That record is below.
It is the definition of what must still work when you are done.

```json
{characterisation}
```

Two artefacts are on disk and are now **frozen** — you cannot edit them, and
they are what you are measured against:

- `{workflow_rel}` — passes right now. Must still pass when you finish.
  {probe_line}

The commands, from the tree root:

```
{workflow_cmd}
{probe_cmd}
{typecheck_cmd}
```

## Remediation guidance

{playbook}

## What to do

1. Read `{file}` around line {line}, and read enough of what calls it and what
   it calls to understand the real data flow — not just the cited lines.
2. Make the smallest change that actually closes the path. Close the path at the
   place the trust boundary is crossed, not at the place it is convenient to add
   an `if`.
3. Run the typecheck. Run the workflow test. Run the probe.
4. If the workflow test fails, your fix is wrong or incomplete. Go back to the
   record above: it says what correct behaviour is. Find a change that satisfies
   both the security requirement and that behaviour. Do not weaken the fix to
   make the test pass, and do not conclude the test was wrong — you wrote it,
   from working code, before you changed anything.
5. Run the related test files you named. They must not regress.

{house_rules}

## Report

Write `{attestation_path}`:

```json
{{
  "bug_id": "{bug_id}",
  "status": "fixed" | "not_fixed",
  "confidence": 0.0,
  "what_changed": "one sentence",
  "why_it_closes_the_path": "one or two sentences — the mechanism, not the intention",
  "why_the_workflow_still_works": "one or two sentences",
  "residual_risk": "what you could not close, or null",
  "rounds_used": {round}
}}
```

Be calibrated. The orchestrator runs every one of these checks itself and
compares its measurements against what you claimed here; a confident claim that
does not survive its own gates is measured and counts against the system. An
honest `not_fixed` is worth more than an overclaimed `fixed`.
"""


# ----------------------------------------------------------------------------
# Phase 3 — reconcile
# ----------------------------------------------------------------------------

RECONCILE = """\
You are a security remediation engineer, mid-task. Your change did not pass its
gates. This is round {round} of {max_rounds}.

Working tree: `{tree}`

{standing}

## The defect you are fixing

```
{bug}
```

## What you recorded before you changed anything

```json
{characterisation}
```

This is the definition of correct behaviour for this code path. You captured it
yourself, from working code, before any edit. When the workflow gate is red, the
answer is in here.

## Your change so far

```diff
{diff}
```

## What the orchestrator measured — this is not the agent's opinion, it ran these

{failures}

## What to do about it

{guidance}

Both of these must hold when you finish, and neither one alone counts:

- **the vulnerability is closed** — the probe prints `NOT_PROVEN`
- **the application still works** — the workflow test passes, and no related
  test that was passing at the start of this task is failing now

Forbidden, and enforced:

- editing the workflow test or the probe. They are frozen. They are the gates.
- weakening or reverting the security fix to make the workflow pass. Passing the
  workflow gate by removing the fix is not progress; it returns the task to
  where it started while looking like it moved.
- deleting the feature to make the probe go quiet. That fails both axes at once,
  and it is the failure mode this whole procedure exists to catch.

Commands, from the tree root:

```
{typecheck_cmd}
{workflow_cmd}
{probe_cmd}
```

{house_rules}

## Report

Update `{attestation_path}` with the same shape as before, setting
`"rounds_used": {round}`. If you believe a gate is wrong, do not quietly work
around it — say so in `residual_risk`, in specific terms. Being right about a
bad gate is worth more than defeating it.
"""


RECONCILE_GUIDANCE = {
    'typecheck': (
        'The build is broken. Nothing else can be measured until it compiles. '
        'Fix the type errors above first, then re-run the other gates.'),
    'workflow_broken': (
        'You broke the legitimate path. Read your own characterisation record and your '
        'own diff side by side and find which line took away behaviour the record says '
        'a real user is entitled to. Then find the version of the fix that keeps the '
        'behaviour and still closes the attack — that version usually exists, and '
        'finding it is the job. Narrowing the feature until the attack no longer fits '
        'is not that version.'),
    'still_exploitable': (
        'The vulnerability is still live: your own probe still proves it. The change '
        'either guards a path the attack does not take, runs after the damage is done, '
        'or is bypassable by a different encoding or entry point. Re-read the probe, '
        'work out exactly which line of it still succeeds, and close *that*.'),
    'regression': (
        'You broke something outside the code you were looking at. The failing tests are '
        'named above with their exact output. These were passing when this task started, '
        'so this is damage from this change, not inherited. Either narrow the change to '
        'stop touching what they depend on, or restore the behaviour they assert while '
        'keeping the fix.'),
    'harness_error': (
        'A gate could not be evaluated at all. Read the output above; it is usually a '
        'crash in your own artefact or a command that could not start.'),
}


# ----------------------------------------------------------------------------
# Builders
# ----------------------------------------------------------------------------

def _fmt_failures(failures) -> str:
    if not failures:
        return ('_(no structured failure recorded — treat this as an unexplained red '
                'gate and re-run the commands below yourself)_')
    out = []
    for f in failures:
        head = f"### {f.get('gate', '?')} — {f.get('kind', '?')}"
        body = []
        if f.get('test_file'):
            body.append(f"file : {f['test_file']}")
        if f.get('test_title'):
            body.append(f"test : {f['test_title']}")
        if f.get('was') or f.get('now'):
            body.append(f"was  : {f.get('was')}   ->   now: {f.get('now')}")
        tail = (f.get('output_tail') or '').strip()
        chunk = head + ('\n' + '\n'.join(body) if body else '')
        if tail:
            chunk += '\n\n```\n' + tail[-4000:] + '\n```'
        out.append(chunk)
    return '\n\n'.join(out)


def build_characterise(*, tree, bug, scratch_rel, workflow_cmd, probe_cmd) -> str:
    return CHARACTERISE.format(
        tree=tree, standing=STANDING_CONSTRAINT, bug=_fmt_bug(bug),
        scratch=scratch_rel, bug_id=bug['bug_id'],
        file=bug['location']['file'], line=bug['location']['line'],
        workflow_cmd=workflow_cmd, probe_cmd=probe_cmd, house_rules=HOUSE_RULES)


def build_fix(*, tree, bug, characterisation, playbook_entry, playbook_how,
              general_guidance, workflow_rel, probe_rel, probe_proven,
              workflow_cmd, probe_cmd, typecheck_cmd, attestation_path, round_no) -> str:
    if probe_proven:
        probe_line = (f'- `{probe_rel}` — prints `PROVEN` right now. Must print '
                      '`NOT_PROVEN` when you finish. That flip is the evidence the '
                      'vulnerability is actually closed.')
    else:
        probe_line = (f'- `{probe_rel}` — could **not** be made to prove the defect in '
                      'the previous step. It is still run, but it cannot confirm your '
                      'fix. You are working without that confirmation: reason carefully '
                      'about the data flow, and set `confidence` accordingly.')
    return FIX.format(
        tree=tree, standing=STANDING_CONSTRAINT, bug=_fmt_bug(bug),
        characterisation=json.dumps(characterisation, indent=1),
        workflow_rel=workflow_rel, probe_line=probe_line,
        playbook=_fmt_playbook(playbook_entry, playbook_how, general_guidance),
        file=bug['location']['file'], line=bug['location']['line'],
        workflow_cmd=workflow_cmd, probe_cmd=probe_cmd, typecheck_cmd=typecheck_cmd,
        house_rules=HOUSE_RULES, attestation_path=attestation_path,
        bug_id=bug['bug_id'], round=round_no)


def build_reconcile(*, tree, bug, characterisation, diff, failures, round_no,
                    max_rounds, workflow_cmd, probe_cmd, typecheck_cmd,
                    attestation_path) -> str:
    kinds = []
    for f in failures or []:
        k = f.get('kind')
        if k and k not in kinds:
            kinds.append(k)
    guidance = '\n\n'.join(RECONCILE_GUIDANCE[k] for k in kinds if k in RECONCILE_GUIDANCE) \
        or RECONCILE_GUIDANCE['harness_error']
    return RECONCILE.format(
        tree=tree, standing=STANDING_CONSTRAINT, bug=_fmt_bug(bug),
        characterisation=json.dumps(characterisation, indent=1),
        diff=(diff or '(no change recorded yet)')[:30000],
        failures=_fmt_failures(failures), guidance=guidance,
        round=round_no, max_rounds=max_rounds,
        workflow_cmd=workflow_cmd, probe_cmd=probe_cmd, typecheck_cmd=typecheck_cmd,
        house_rules=HOUSE_RULES, attestation_path=attestation_path)
