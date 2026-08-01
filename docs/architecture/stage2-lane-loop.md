# The Stage 2 per-lane agent loop

What it is, why each turn is worded the way it is, what it costs, and — the part
that matters most for reading any number it produces — how to tell a loop that
found the right line from a loop that cited more lines until it hit one.

Aggregate metrics only. Located evidence lives in the answer-key repo, per
`../protocols/blind-development.md`.

## 1. What a lane does now

Before, a lane was one structured completion per chunk. It still is when
`HUNT_LOOP=none`, which is the default and which every scored run to date used.

With a loop mode set, the lane **continues the same conversation**. That choice
is doing two jobs at once:

- It is what an agent loop actually is. The model can see what it already said
  and act on it, rather than being asked the same question again by a caller
  pretending to be a fresh user.
- It is the cheap option. The file, the playbooks, the architecture context and
  the route context are already in the transcript. A follow-up turn adds its own
  instruction and the assistant message and nothing else, so the second turn
  costs about 13% more input than the first rather than 100% more.

| mode | turns | what the follow-up asks |
|---|---|---|
| `none` | 1 | — (baseline, unchanged) |
| `trace` | 2+ | name the lines each finding's path actually passes through |
| `gap` | 2+ | report defects of the assigned classes the first turn did not |
| `reflect` | 2+ | both, in that order |
| `sweep` | 1 per class group | re-hunt the chunk with a narrower class list |

`HUNT_LOOP_PASSES` bounds the follow-up turns (default 1). The loop stops early
when a turn adds no finding and extends no trace: an unproductive turn is the
model saying it has nothing further, and the next one costs the same and returns
the same.

`HUNT_SWEEP_GROUP` sets the classes per group in `sweep` mode.

## 2. Findings are unioned, never replaced

`mergeFindings()` treats an incoming finding as a **revision** of an existing one
when it shares at least one cited line *and* at least one class; otherwise it is
new. A revision unions the trace and the class list. Nothing is ever removed.

Three consequences, all deliberate:

- **A later turn cannot lose a hit an earlier turn had.** Recall is the metric
  this loop exists to move, and union is the only merge rule with that property.
- **A later turn cannot retract a finding by not repeating it.** This is the
  run-4 lesson in code rather than in wording: making a second pass authoritative
  over the first cost 20 benchmark hits when a cheap early "absent" became a hard
  block on labelling. The follow-up prompts say the same thing in words, but the
  merge is what enforces it.
- **Precision falls, and v2 has nothing to recover it.** Stage 3 reads v1 output.
  Any change that raises emission lowers the precision proxy with no validator
  downstream — see `../protocols/eval-howto.md` §3.

When the merge adds a class to an existing finding it re-expands `categories`
from the merged class list. That line is load-bearing: `categories` is what
category-aware scoring reads, and it is otherwise computed once per turn, so a
class the loop correctly added would have carried no OWASP codes and the hit
would not have scored. This was a real defect, caught in review before it was
measured.

## 3. Why the follow-up turns are worded as they are

The wording is not decoration. Section 5 explains why it is the *only* control
that exists against a degenerate answer.

**The `trace` turn asks for addition, never relocation.** "Keep every finding and
keep the line you already chose for each step. Do not move a step to a different
line and do not drop one." An instruction to *move* a step to a narrower line was
measured on this platform and falsified — it broke four exact hits to fix three.
Completing a path the model has already drawn is a different request from
re-aiming it, and only the first survived measurement.

**Every added step must earn its place.** "Every line you add must be one the
value or the control decision actually passes through, and its description must
say what that line does to it. If you cannot say what a line does to the value,
it is not a step." The schema already requires a description per step, so this
attaches a cost to padding rather than merely discouraging it.

**A complete trace has a blessed exit.** Some findings are genuinely two lines —
a hardcoded constant, a weak algorithm chosen in one place, a single missing
check. Without an explicit way to say "this one is already complete", the only
compliant move is to invent a middle step.

**The `gap` turn cannot suppress.** It restates that nothing overrides the first
pass, keeps the low confidence band open ("I cannot confirm this from this file
alone" is a 0.1–0.3 finding, not silence), restates the required trace shape
(which the JSON schema does not encode and the validator silently drops findings
for violating), and distinguishes a repeat from a distinct defect at the same
lines. It also names the assigned classes that no finding yet carries, which is
computed from the lane's own state rather than asked for.

## 4. Cost

Measured on the 40-lane benchmark-bearing arm, `gpt-5.6-luna`, and projected to
541 lanes by scaling each leg separately against run 5's own per-lane records
(the arm lanes are output-heavy — 1,664 output tokens per lane against 663
across all 541 — so a flat 541/40 scaling would badly overstate a full run):

| arm | turn 1 in | turn 1 out | turn 2 in | turn 2 out | arm $ | projected full run |
|---|---|---|---|---|---|---|
| `none`, default effort | 337,530 | 66,554 | — | — | $0.74 | **$5.73** |
| `trace`, default effort | 337,530 | 68,998 | 380,557 | 80,043 | $1.61 | $12.45 |
| `none`, effort `high` | 337,530 | 265,487 | — | — | $1.93 | $12.59 |
| `trace`, effort `high` | 337,530 | 269,176 | 403,047 | 201,049 | $3.56 | $23.75 |

The projection reproduces run 5's published $5.73 exactly on the `none`
default-effort row, which is the check that the scaling is sound.

A follow-up turn adds only **+13% input** — the file, playbooks and context are
already in the transcript — and roughly doubles output. Reasoning effort is the
more expensive axis on its own: it multiplies output about fourfold.

## 5. How to read any number this produces

**Every ground-truth-denominated metric is monotone non-decreasing in trace
length.** A finding matches an entry when *some* step of its trace is on the
entry's line, so citing more lines can only help; and the precision proxy is
per-finding and within ±15 lines, so padding raises that too. A single finding
whose trace enumerated every line of its file would score near-perfectly on
recall, localization, file-level and precision alike.

So a loop that asks for more trace steps **must** raise recall to some degree
whether or not it understood anything, and the published table cannot tell the
two apart. Two things are therefore mandatory alongside any loop result:

1. **The line budget** — distinct lines cited, and that as a share of the arm's
   corpus lines.
2. **A budget-matched null.** Take the loop-free control's own findings and
   inflate their traces mechanically to the same number of distinct cited lines,
   nearest-to-an-already-cited-line first, with no model involved. Whatever
   recall that buys is the part of the loop's gain that line count alone
   explains. `loop-null-model.py` in the answer-key repo does this.

The null is generous by construction — nearest-first is where a blind procedure's
money is best spent, because near-misses cluster within a few lines of a line the
control already cited. Beating it is a real claim.

**Localization is the harder metric to fake and should be read first.** A ±15
window is barely moved by adding lines adjacent to ones already cited: in the
measured nulls localization moves by at most a point. A loop that raises
localization has changed *which* lines are cited, not how many.

**This test changed the conclusion, and it is the reason it is mandatory here.**
Read plainly, the arm table says the loop helps at both reasoning efforts. Read
against the null it says something narrower and more useful: at the endpoint's
default effort the loop beats a same-budget mechanical inflation by 7.2 points
of recall and 7.2 of localization, and at effort `high` it does not beat it on
recall at all. The loop and the reasoning effort turn out to be substitutes for
one another rather than additive — see `../run-history.md` for the numbers.

## 6. Nondeterminism floor

Re-running the loop-free control on prompts verified byte-identical to a previous
scored run moved 17 of 84 entries — 12 gained, 5 lost, net +7. That is the noise
on identical input, and it is large relative to the effects being chased.

Two rules follow. Do not treat a net difference under about 7 entries as a
result. And read the **transition asymmetry**, not just the net: noise moves
entries in both directions in roughly a 2:1 ratio, so an arm that gains 13 and
loses 1 is saying something the noise floor does not, even when its net is
similar.
