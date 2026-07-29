# Run 6 investigation — the model was the variable, and one bug was eating recall

Investigation 2026-07-29, on branch `claude/agent-localization-recall-debug-5cxqzb`.
Baseline: run 5 (`c9c2cf0`), recall 42/97 = 43.3%, localization 78/97 = 80.4%.

Aggregates only. Every located result lives in the answer-key repo under
`analysis/`. See `../protocols/eval-howto.md` for the split.

**Role note.** CLAUDE.md assigns scanner source edits to Qwen and reserves Claude
for architecture and verification. The user directed Claude to develop and test
the fixes directly for this investigation, so that split is suspended here by
instruction. Everything below was still verified against artifacts rather than
self-reported.

---

## 1. The starting hypothesis was wrong, in a useful way

The hypothesis under test: `crypto-auth` (a jump in `CATEGORY_MISS`) plus
`access-control` and `misconfiguration` (the most `LINE_MISS_FAR`) point at those
three playbooks.

The entry counts behind that reading are correct. The diagnosis is not — all
three are falsified:

- **`crypto-auth`'s `CATEGORY_MISS` is almost entirely hot-line variance.** 8 of
  its 9 are at a single high-multiplicity location whose own probe (6 repeats,
  unmodified prompt) produces the needed citation in 5 of 6 runs. The 9th is a
  defensible taxonomy disagreement. Cold `crypto-auth` `CATEGORY_MISS` is **one**
  entry. There is nothing for a playbook edit to fix.
- **The playbook already covers what it was suspected of missing.** `crypto-auth`
  names MD5 and SHA-1 explicitly.
- **`access-control` / `misconfiguration` `LINE_MISS_FAR` is real, and is not
  playbook content.** It decomposes into line attribution and missing route
  context.

**What the residual actually is.** Cold pools (hot lines separated, since they are
variance rather than signal):

| pool | n |
|---|---|
| `LINE_MISS_NEAR` — right code, within ±15, wrong exact line | **28** |
| localization misses, coverage-needed | 10 |
| localization misses, label-fixable | 9 |
| `CATEGORY_MISS` | 5 |

`LINE_MISS_NEAR` is the dominant pool and **no run has ever targeted it** — runs
3, 4 and 5 all acted on which class a finding carries. 25 of the 28 are within ±5
lines, and **no run-5 finding cites the exact ground-truth line for any of them**,
so it is line *selection*, not label attribution. 5 of the 28 have a
ground-truth line that is blank, punctuation-only or a comment and is therefore
not citable at all, which caps exact-line recall near 94%.

Misses are also **file-concentrated, not class-concentrated**: the top 3 files
carry 53% of localization misses and the top 5 carry 63%. That is why four
successive class-level interventions plateaued.

## 2. A measurement platform worth keeping

**All 97 reachable entries live in 40 of run 5's 541 hunt lanes**, and restricting
run 5's own findings to those 40 lanes reproduces its published metrics *exactly*
— 42/97 recall, 78/97 localization, 87/97 blind, on 94 of its 392 findings.
Verified, not assumed.

So a 40-lane arm is a complete, single-variable measurement of recall and
localization at **7.4% of a full run's lane count**. Arms are built by
`arm-build.mts` and scored by `arm-score.py` in the answer-key repo, using the
real `buildHuntPrompt`, the real playbooks, the assigned-class lists from run 5's
own manifest, and the executor's own arch-snippet construction. Prompt fidelity is
asserted per lane against run 5's recorded `prompt_breakdown.total_chars`: **39 of
40 lanes byte-identical**, the 40th differing only by the bug fix in §3.

That per-lane assertion is what caught §3. An earlier version of the arm builder
reimplemented the executor's read path and drifted by 9–108 characters per lane;
chasing the drift found the defect.

## 3. A line-number corruption that was eating recall — fixed

`sanitizePemPrivateKey()` replaced a PEM key body with `"\n[REDACTED…]\n"`,
turning a single-line key declaration into three lines.

The line count is load-bearing. Stage 0.5 counts lines and writes the chunk plan;
Stage 2 then redacts and numbers what it shows the model. Changing the count
desynchronises the numbers the model is told to cite, the file the scorer reads,
and the chunk plan's `end_line`.

Consequence in the corpus: the one file carrying a PEM key went 196 → 198 lines,
so **every line from the key onward was displayed 2 higher than its true number**,
and slicing to the manifest's `end_line` silently dropped that file's last 2
lines. The model was citing correct lines in shifted coordinates.

Re-scoring run 5 offline with the shift undone — deterministic, no inference:

| | recall | localization | blind |
|---|---|---|---|
| as scored | 42/97 = 43.3% | 78/97 = 80.4% | 89.7% |
| shift corrected | **45/97 = 46.4%** | 78/97 = 80.4% | 89.7% |

**+3 entries, and localization does not move.** That asymmetry is the signature of
this bug class: a 2-line shift is invisible to a ±15 window and fatal to
exact-line recall — precisely the "localization fine, recall stuck" shape of the
last three runs. Every run to date understates recall by those 3 entries.

Fixed by re-emitting exactly as many newlines as the removed body contained.
7 regression tests assert the invariant, including against the real corpus; the
guard suite is now 84 tests. Verified across all 541 hunt lanes: 0 line-count
changes and 0 chunk/content mismatches after, 1 of each before.

## 4. The inference model is the dominant variable — measured twice

### 4.1 A stronger model on identical lanes and identical prompts

Every scored run has used `luna`, the **cheapest tier of the GPT-5.6 family**.
`docs/Cybersecurity models pricing research` records why: it was "the smallest
step up available" from `qwen` on cost grounds. Model capability has therefore
never been isolated as a variable, while four runs tuned prompts against it.

`terra` and `sol` are the same family on the same endpoint and the same API key —
one registry entry each, exactly as `models.json` intends. Both PASS `preflight`
including the `json_schema` round-trip. Added to the registry.

A 129-lane arm selected by a manifest property only (Stage 0.5 assigned ≥8
classes — never anything ground-truth derived), sharing luna's Stage 0 so arch
context is byte-identical, run through the **real unmodified Stage 2**:

| arm | findings | recall | localization | blind loc |
|---|---|---|---|---|
| `luna` (run 5, same lanes) | 197 | 36/82 = 43.9% | 69/82 = 84.1% | 90.2% |
| **`terra`** | 221 | **50/82 = 61.0%** | 67/82 = 81.7% | **96.3%** |

**+14 entries of recall, +17.1 points, on the same prompts.** 16 gained, 2 lost.
Category-blind localization rises 90.2% → 96.3%; category-aware localization dips
2.4 points, so terra finds and positions more while labelling slightly worse.

Clean execution: 129/129 lanes, 0 retries, 0 fatal, 0 blocked reads,
`degraded: false`, 1,330,522 tokens, **$5.54**.

### 4.2 An upper bound from a different model family

The 40-lane arm answered by Claude subagents as the inference model, on prompts
verified byte-identical to run 5's:

| | recall | localization | blind loc |
|---|---|---|---|
| run 5 (`luna`) | 42/97 = 43.3% | 78/97 = 80.4% | 89.7% |
| run 5 + §3 fix | 45/97 = 46.4% | 78/97 = 80.4% | 89.7% |
| **Claude, same prompts** | **66/97 = 68.0%** | **90/97 = 92.8%** | 96.9% |

Both standing targets are met by the model alone: localization ≥90% and recall in
the 60–70% band, with no prompt, playbook or lane-topology change.

**Read this as an upper bound, not a forecast.** The arm answers through an agent
loop rather than one structured HTTP completion, so it can re-read and self-check
in ways a single Stage 2 call cannot; there is no `ANTHROPIC_API_KEY` in this
environment, so it was not run through the real provider path. The contrast is
model-matched, the absolute level will not transfer unchanged. §4.1 is the result
measured through the real pipeline.

### 4.3 `sol` is rate-limit-bound at this concurrency — not measured

`sol` was launched on the same 129-lane manifest and **abandoned**: 205 retries
and **35 fatal lanes** by lane 39 at `HUNT_CONCURRENCY=8`, which luna and terra
both cleared with 0 of each. Its rate limit is far below theirs. The partial
output is degraded and **is not cited anywhere**; its checkpoint was moved out of
the run tree so no later run can resume it. Sol needs a much lower concurrency and
a fresh run.

## 5. What was tested and rejected

**Trace-specificity instruction — FALSIFIED.** The prompt says nothing about which
line to cite for a defect, only "use these line numbers EXACTLY", which forbids
inventing a number and is silent on choosing among real ones. Given §1's
mechanism, an instruction to cite the innermost statement rather than the
enclosing construct looked like the obvious lever.

Matched A/B, 40 lanes, both arms same model, only the appended block differing:

| arm | findings | recall | localization | blind loc | hedging | precision |
|---|---|---|---|---|---|---|
| control | 325 | 72/97 = 74.2% | 94/97 = 96.9% | 97.9% | 2.298 | 46.2% |
| + specificity | 346 | 70/97 = 72.2% | 91/97 = 93.8% | 99.0% | 2.052 | 40.2% |

Transitions: **3 improved, 7 worsened** — `HIT → LINE_MISS_NEAR` ×3,
`HIT → LINE_MISS_FAR` ×1. It pushes the model off lines it already had right, and
precision falls 6 points. **Reverted from source; retained as an arm variant.**

Caveat stated plainly: this control sits at 96.9% localization, so headroom is
thin and the result does not prove the instruction would fail on a weaker model.
But it did not shrink the near-miss pool (21 → 20) while breaking 4 hits, which is
evidence against it even so. (Both arms in this pair predate the §3 fix and ran on
prompts with an unredacted key; they are identical to each other, so the contrast
holds while the absolute levels are inflated.)

**Registrar route context — implemented, not yet measured.**
`matchRoutesForFile()` matches routes to a file by that file's exported symbols,
which serves handler files and starves the file that *declares* the routes — it
exports none of the handlers it mounts, so it matches nothing and received zero
characters of route context in run 5, where only 70 of 541 lanes got any at all.
Stage 0 already records all 148 registrations with a declaring file, an exact
line, and auth middleware; 88 carry no guard. `renderRegistrarRouteContext()`
turns that judgement question into a lookup. It is additive — it does not touch
`matchRoutesForFile()` or `renderRouteContext()`, so every lane that already had
route context gets byte-identical text. **In the tree, unmeasured; do not claim it
works.**

## 6. Recommendation for run 6

1. **Ship the §3 line-number fix.** A correctness bug, +3 entries, no cost, no
   behavioural risk, regression-tested.
2. **Make run 6 a model-tier change: `terra`, full 541 lanes.** One registry entry,
   already reachable, measured at +17.1 recall points on a real 129-lane
   pipeline run. Projected cost ~$14 at run 5's token volume — the largest
   measured effect in the project's history, for less than the price of run 4.
3. **Keep it single-variable.** Do not bundle the registrar route context; it is
   unmeasured, and run 4's lesson was that two variables destroy attribution.
   Measure it after, on the 40-lane platform.
4. **Do not ship the specificity instruction.**
5. **Re-run `sol` separately** at much lower concurrency, once terra is scored.

Everything the last four runs were tuning — playbook coverage, class labelling,
lane topology — was being tuned against the family's cheapest tier. That is the
finding.
