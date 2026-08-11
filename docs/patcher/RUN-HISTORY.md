# Patcher run history

One section per evaluated patcher run. The machine-readable record is
`results/eval-history/patcher.jsonl`, which is **append-only** — never rewrite a
row; annotate it. This file is the readable companion: what ran, what it scored,
why it scored that, and what changed as a result.

**Aggregate only.** No challenge identifier, and no pairing of a bug id or a file
with a found/not-found outcome. `CLAUDE.md` records a prior incident where eval
analysis leaked precisely because the useful conclusions are naturally phrased in
terms of locations. The located per-case evidence for every run below lives in
the answer-key repo; look there if you are scoring, not here.

---

## `patch-run-subset-04` — 2026-08-10

**NEFR 0.50 (5/10).** First scored patcher run against a subset whose two oracle
halves were both verified by measurement before admission.

### Result

| | |
|---|---|
| NEFR (closed **and** intact) | **0.50** — 5/10 |
| VRR (closed by any means) | 0.50 |
| **Destructive-fix gap (VRR − NEFR)** | **0.00** |
| WPR | 1.00 — 0 regressions / 865 blocks |
| Scoreable cases | 10 / 10, `oracle_blind_rate` 0.00 |
| Verdicts | 5 `EFFECTIVE_FIX`, 5 `NO_FIX`, 0 `DESTRUCTIVE_FIX`, 0 `HARMFUL_NO_FIX`, 0 `BUILD_FAILED` |

The destructive-fix gap is the number to look at first. It is **zero**: not once
did the patcher buy remediation by breaking the product. That is the single
failure mode the two-axis design exists to catch, and it did not occur.

### Run

| | |
|---|---|
| Model | opus, `--effort high --thinking enabled` |
| Engine | v2 waves — `task_granularity: file`, `task_concurrency: 2` |
| Wall clock | 2 h 29 m (8980 s), of which 79 s was gates |
| Cost | **$41.61** over 15 invocations |
| Shape | 5 units, 10 bugs, 3 waves, **0 merge conflicts** |
| Dispositions | 4 `fixed`, 1 `abandoned` |
| `rounds_to_green` | `{0: 3, 1: 1, never: 1}` — median 0 |
| Probe coverage | 1.00 — every task demonstrated its defect before fixing it |
| Blast radius | 4 files, +159 / −9; 0 net-deletion, 0 out-of-boundary writes |

Paced one wave per session with a checkpoint between each, so an interruption
costs the wave in flight and never one already paid for.

### Why the five failed

Two distinct causes, and neither is the patcher reasoning badly. In all five it
produced a defensible change.

**Three of ten: a correct fix was deleted by the harness.** One unit's exploit
probe was blocked and its workflow test green on every one of five rounds — the
defect was closed on the first attempt and stayed closed. Its regression net
contained tests that assert *attack-dependent* behaviour: they require the
payload to still be acted upon, so any correct fix necessarily fails them. Under
`policy.on_exhausted: revert` the whole unit was then discarded. Cost of that
deletion: 5 rounds and roughly half the run's spend, on work that was right.

The anti-oracle detector (`tools/patcher/src/antioracle.py`) *did* fire on this
unit and excused two other rows. It recognises tests carrying an attack payload
in their own text. The two that killed the unit carry none — they request an
ordinary-looking URL — so no text classifier can see them.

**Two of ten: the fix did not match what the oracle measures.** Both shipped and
passed every in-sandbox gate, including a blocked probe; the sighted oracle did
not register remediation. Of the 7 bugs actually shipped, 2 did not close the
defect — a **29 % false-confidence rate on shipped work**. That number is only
visible because the sighted oracle disagreed with the sandbox, and it is the most
safety-critical signal the run produced: the agent writes its own probe and grades
itself against it, so a probe narrower or wider than the real acceptance
criterion lets it be confident and wrong.

The structural gap behind both: the subset's admission bar vetted the **scoring**
workflow oracle. The patcher's own regression net is assembled at run time by
`tools/patcher/src/testmap.py` from the agent's named files unioned with a static
scan, and **nothing vets that set**. Both failure modes entered through it.

### Qualifications that travel with these numbers

1. **The bug report was wider than it is now.** This run's report carried
   `vulnerability` and `reproduction` prose. Both were removed afterwards
   (commit `28695a4`); the agent now gets file, line and class only. **No run
   made after that commit is comparable with this one.**
2. **WPR 1.00 means "no damage within the vetted net", not "no damage".** An
   independent full-suite capture against the pristine base found 8 blocks lost
   in a unit test that pins a pre-fix value — outside the scorer's net, so the
   scorer cannot see it. `test:api` showed 0 regressions against 10 reds that
   pre-date the run.
3. **Dependencies are unpinned.** The target app sets `package-lock=false`, so
   `npm ci` is impossible. Safe within one run — every wave shares one immutable
   `node_modules` — but cross-run and cross-machine comparison is unsound until a
   lockfile is committed. See `docs/patcher/RUN-ENVIRONMENT.md`.
4. **The blind audit flagged this run contaminated. It was not.** The entire
   basis was one **denied** `npx --yes` package fetch. `out_of_tree` and
   `answer_key_pattern` were both 0 and nothing reached the network, so blindness
   held. `blind_guard.CONTAMINATING_KINDS` treats a denied `network_egress` as
   contaminating, which is inconsistent with its own treatment of a denied
   seed-denylist read ("the read did not happen, so the run stands"). **Not yet
   corrected.**

   > **Correction, 2026-08-11.** The classifier is now fixed (`ccb882c`);
   > `network_egress` has left `CONTAMINATING_KINDS` and a denied attempt is
   > counted and surfaced as a note. The qualification above still stands as
   > written for **this run's archived numbers**: the row in
   > `results/eval-history/patcher.jsonl` records `contaminated` as it was
   > measured at the time and is append-only, so it is not edited. A re-audit
   > against the run's guard log would now return `false`, but the run store it
   > would need lives outside this repository on ephemeral disk and is gone, so
   > no rescore row can be produced. Later runs are unaffected.

### Changed as a result

| Change | Where |
|---|---|
| `on_exhausted` → `keep_best`, so a fix whose defect is provably closed is no longer deleted over an anti-oracle | `tools/patcher/config/subset4.run-config.json` |
| Bug report narrowed to file, line and class; schema, guard and prompt renderer all enforce it | `contracts/bug-report.schema.json`, `src/blind_guard.py`, `src/prompts.py` |
| Post-wave gate now actually runs — it was reporting green while measuring nothing | `src/integrator.py` |
| Post-wave gate parallelised; wave-base snapshot read once instead of per unit | `src/integrator.py`, `src/workspace.py` |
| Effort and reasoning wired and validated at config load | `src/agent.py` |
| Seed denylist reaches the patcher, parsed from the scanner's single source of truth | `hooks/sandbox_guard.py`, `src/blind_guard.py` |
| Regression net delivered to the fix phase as runnable commands | `src/prompts.py` |
| A denied egress attempt is counted and noted, not treated as a leak; a test pins the deny-only premise it rests on | `src/blind_guard.py` |
| `keep_if_workflow_intact` no longer requires a green regression net; a task kept over a red net says so in its own reason | `src/task_loop.py` |

### Open, in priority order

1. **Vet the patcher's regression net** the way the scoring oracle is vetted. It
   is the common cause of both failure modes.
2. **Seed the anti-oracle detector from measurement, not from test text.** A
   round where the probe is blocked, the workflow test is green, and the same
   rows are red every time identifies an anti-oracle with high confidence. Store
   it keyed by `file:line` so no challenge name enters this repository.
3. **Give the agent the acceptance criterion.** One line per bug entry — what
   must stop working — removes the whole false-confidence class.
4. ~~**Correct the contamination classifier** so a *denied* egress attempt is
   recorded, not treated as a leak.~~ **Done, 2026-08-11** (`ccb882c`). What
   remains is a different question and is not this one: an egress channel
   `NETWORK_BINARIES` does not recognise is never logged as `network_egress` at
   all, so no audit rule can catch it. That is **hook coverage**, and it is open.
5. **`keep_best` has a sharp edge**: it will retain a round that fails typecheck,
   and a non-compiling tree poisons every task after it. The safer form is
   `keep_if_workflow_intact` with its no-regression clause dropped — keep a fix
   that builds and preserves the feature even if an existing test objects. See
   `_apply_exhausted_policy` in `src/task_loop.py`.

   **Half done, 2026-08-11** (`604cc32`): the no-regression clause is dropped, so
   `keep_if_workflow_intact` now banks a fix that builds and keeps the feature
   even when the net objects, and records that the net was red when it does.
   **`subset4.run-config.json` still selects `keep_best`, so no run executes this
   branch yet.** Switching the active policy changes what a run does and is a
   deliberate decision that has not been made — make it before the next run, not
   during one.
