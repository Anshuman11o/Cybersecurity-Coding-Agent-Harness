# Dataset readiness & scanner→patcher handoff

Executable plan. Answers one question: **can the patcher be deployed against
`target-apps/juice-shop-blind` the moment the scanner finishes?**

**Verdict: no.** Three blockers, none of them about answer-key leakage. All three
are fixable in a day; none can be skipped, because each one invalidates the
baseline that every patcher metric is differenced against.

This document contains no answer-key material and is safe for any harness
session to read.

---

## 1. Readiness at a glance

```
  SCANNER ──────► candidate-findings.json ──►  ???  ──► PATCHER ──► ???
                  validated-findings.json       ▲                    ▲
                                                │                    │
                                          NO CONTRACT          NO BUILDABLE
                                          (blocker 3)          TREE (blocker 1)
                                                                     │
                                                          NO BASELINE (blocker 2)
```

| Component | State | Blocker |
|---|---|---|
| Source tree (`target-apps/juice-shop-blind`) | ✅ present, 865 source files | — |
| Node toolchain | ✅ v22.22.2 (`engines: 22 - 26`) | — |
| Test corpus | ✅ 149 backend test files + 120 frontend specs | — |
| In-memory test harness | ✅ `createTestApp({inMemoryDb:true})` | — |
| **Dependency tree** | ❌ not installed, **no lockfile anywhere** | **1** |
| **Known-good baseline** | ❌ never captured; suite has never been run | **2** |
| **Scanner→patcher contract** | ❌ does not exist | **3** |

---

## 2. Blocker 1 — dependency reproducibility

### Evidence

```
target-apps/juice-shop-blind/node_modules/           MISSING
target-apps/juice-shop-blind/frontend/node_modules/  MISSING
target-apps/juice-shop-blind/package-lock.json       MISSING
target-apps/juice-shop-blind/frontend/package-lock.json MISSING
```

Dependency counts: server 66 runtime + 51 dev; frontend 47 runtime + 16 dev.
**180 packages, zero pinned.** The only lockfile tracked anywhere under
`target-apps/` is `ftp/package-lock.json.bak`, which is a deliberate app artifact,
not a build input.

### Why it blocks everything

Every patcher metric is **differential** — baseline versus post-patch. Without a
lockfile, `npm install` resolves whatever is newest that hour, so:

- a test failing post-patch may be failing because a transitive dependency
  changed, not because the patch broke it — **FRR becomes unattributable**
- `npm audit` (verification technique V3) is unusable: CVE counts drift with
  resolution, so a "remediation" may be an upstream release
- the baseline is not reproducible, so no run compares to any other run

### Fix

```bash
cd target-apps/juice-shop-blind
npm install --package-lock-only          # generate, do not install yet
cd frontend && npm install --package-lock-only && cd ..
git add package-lock.json frontend/package-lock.json
git commit -m "Pin target-app dependency tree for reproducible patcher baselines"
```

Then install for real: `npm ci && cd frontend && npm ci`.

**Use `npm ci`, never `npm install`, from this point on.** `ci` installs exactly
the lockfile; `install` may silently update it.

### Acceptance

| Check | Expected |
|---|---|
| `git ls-files target-apps/juice-shop-blind/package-lock.json` | 1 result |
| `npm ci` in a clean clone | succeeds, no lockfile modification |
| `git status --short` after `npm ci` | empty |

### Note

`.gitignore` currently ignores nothing under `target-apps/`, so `node_modules/`
will show as untracked after install. Add `target-apps/*/node_modules/` and
`target-apps/*/frontend/node_modules/` to `.gitignore` in the same commit.

---

## 3. Blocker 2 — no measured baseline

### Evidence

The working copy's test suite **has never been run in this project**. Everything
in `docs/patcher/VERIFICATION-TECHNIQUES.md` is inferred from `package.json`
scripts, not observed.

Unknown, and each one is load-bearing:

| Unknown | Why it matters |
|---|---|
| Does `npm run build` succeed? | If not, every patch scores `BUILD_FAILED` |
| How many tests are already red? | Pre-existing failures read as patcher regressions |
| How long does a full suite take? | Sets the cost of every patch iteration |
| How flaky is Cypress here? | Flaky tests must be excluded from both metric legs |

### Fix — capture and freeze

```bash
cd target-apps/juice-shop-blind
npm run build                     2>&1 | tee ../../.baseline/build.log
npm run test:server               2>&1 | tee ../../.baseline/server.log
npm run test:api                  2>&1 | tee ../../.baseline/api.log
npm run test:frontend             2>&1 | tee ../../.baseline/frontend.log
npm run lint                      2>&1 | tee ../../.baseline/lint.log
bash test/smoke/smoke-test.sh     2>&1 | tee ../../.baseline/smoke.log
```

Run each suite **3×** and mark any `it()` with a non-unanimous result as flaky.

Emit `baseline-<targetSha>.json`:

```jsonc
{
  "baseline_id": "baseline-<targetSha>",
  "target_sha": "<git rev-parse HEAD>",
  "lockfile_sha256": "<sha of package-lock.json>",   // pairs with blocker 1
  "captured_at": "<ISO-8601>",
  "runs": 3,
  "build": { "passed": true, "duration_s": 0 },
  "suites": {
    "server":   { "total": 0, "passed": 0, "failed": 0, "flaky": 0, "duration_s": 0 },
    "api":      { "total": 0, "passed": 0, "failed": 0, "flaky": 0, "duration_s": 0 },
    "frontend": { "total": 0, "passed": 0, "failed": 0, "flaky": 0, "duration_s": 0 }
  },
  "it_results": [
    { "suite": "api", "file": "test/api/search.test.ts",
      "title": "<it() title>", "result": "pass", "flaky": false }
  ]
}
```

**Where it lives:** the full baseline is answer-key-adjacent (it enumerates test
titles that pair with challenges), so it belongs in the private run store, not
this repo. Write it to `/home/user/harness-private/baselines/`. A summary block
(counts, durations, flake count — no titles) may be committed here.

### Acceptance

| Check | Expected |
|---|---|
| `build.passed` | `true` — if false, **stop**, fix the tree first |
| every suite has non-zero `total` | true |
| flake count recorded | true, even if 0 |
| baseline references a committed lockfile sha | true |

---

## 4. Blocker 3 — no scanner→patcher contract

### Evidence — measured from the committed scanner outputs

| | Stage 2 `candidate-findings.json` | Stage 3 `validated-findings.json` |
|---|---|---|
| Count | 38 | 39 (10 `CONFIRMED`, 29 `REJECTED`) |
| Has `categories` | ✅ yes | ❌ **no — field does not exist** |
| Has `trace[]` | ✅ | ✅ |
| Identity field | `finding_id` | `consolidated_id` + `original_finding_ids[]` |
| Confidence | `confidence` | `validator_evidence` (prose) |

**Both candidate sources are unusable as-is, for opposite reasons:**

- **Stage 2** carries `categories`, but the v2 per-file lanes assign **all 26
  codes to 98.7% of lanes** (546 of 553), and `hunt-executor.ts` sets
  `f.categories = lane.categories`. A finding tagged with every category tells
  the patcher nothing about what to fix.
- **Stage 3 drops `categories` entirely.** A patcher consuming validated
  findings receives **no vulnerability class at all** — only a title, a prose
  description, and a trace.

Either way the patcher cannot know what class of bug it is being asked to fix.
This is currently tracked as a scanner scoring defect; it is equally a patcher
blocker.

### Fix, part A — make the scanner name the class it found

Two changes in `tools/scanner/stage2-hunt-lanes-perfile/`:

1. `src/hunt-executor.ts` — stop assigning `f.categories = lane.categories`.
   Require the model to name the class actually found, and validate it is a
   member of the lane's assigned list.
2. The hunt prompt must add `categories` to its required-output list. It
   currently never asks.

Then in `tools/scanner/stage3-validate/src/validator-orchestrator.ts`: carry
`categories` through consolidation. When several findings merge, union their
category lists and record provenance.

### Fix, part B — the handoff contract

New file, written by a thin adapter, consumed by the patcher.
**`tools/scanner/stage4-handoff/output/patch-queue.json`**

```jsonc
{
  "queue_id": "patch-queue-2026-07-29-a",
  "generated_at": "<ISO-8601>",
  "target_sha": "<commit of the working copy>",
  "target_dir": "target-apps/juice-shop-blind",
  "lockfile_sha256": "<must match the baseline>",
  "source": {
    "stage": "stage3-validate",
    "verdict_filter": ["CONFIRMED"],
    "input_findings": 39,
    "emitted": 10
  },

  "items": [
    {
      "item_id": "pq-0001",
      "source_finding_ids": ["find-0007"],

      "location": {
        "file": "routes/orderHistory.ts",   // TARGET-RELATIVE, prefix stripped
        "line": 25,
        "sink_line": 31
      },

      "vulnerability_class": ["A01"],       // REQUIRED, non-empty, <= 3 codes
      "class_confidence": 0.9,

      "title": "…",
      "description": "…",
      "trace": [
        { "kind": "entrypoint",   "file": "routes/orderHistory.ts", "line": 25, "description": "…" },
        { "kind": "propagation",  "file": "routes/orderHistory.ts", "line": 28, "description": "…" },
        { "kind": "sink",         "file": "routes/orderHistory.ts", "line": 31, "description": "…" }
      ],

      "severity_estimate": "critical",
      "scanner_confidence": 1.0,
      "validator_evidence": "…"
    }
  ]
}
```

### Design decisions, with reasoning

| Decision | Choice | Why |
|---|---|---|
| Source stage | **Stage 3 `CONFIRMED` only** | Patching a rejected finding wastes tokens on a non-bug. Costs recall — only 10 of 38 survive validation — but that loss is the scanner's to fix, and both denominators are reported so it stays visible. |
| Path form | **target-relative** | Stage 2 emits `target-apps/juice-shop-blind/routes/…`. The patcher works *inside* the target, so the prefix must be stripped once, here, not by every consumer. |
| `vulnerability_class` | **required, ≤3 codes** | Hard cap forces the scanner to commit. A 26-code list fails schema validation, which turns the blanket-category defect into a loud failure instead of a silent one. |
| Unit of work | **one item per finding**, not per file | Two findings in one file are two patches with two verdicts. Merging them makes attribution impossible and breaks the shared-line rule. |
| `lockfile_sha256` | **required** | Pins the queue to the exact tree the baseline was captured against. Mismatch = refuse to run. |

### The patcher's outputs

Already specified. Mirrored into this repo as the agent-facing contract:

- `docs/patcher/contracts/patch-submission.schema.json`
- `docs/patcher/contracts/verifier-report.schema.json`

Both contain no challenge, file, or line reference. The authoritative copies
live with the scorer; these are mirrors — if they diverge, the scorer's copy
wins.

### Acceptance

| Check | Expected |
|---|---|
| Every `items[].vulnerability_class` | non-empty, ≤3 codes, all valid |
| Every `items[].location.file` | resolves under `target_dir`, no prefix |
| `lockfile_sha256` | matches the baseline's |
| Round-trip | a patch-submission validates against its schema and every `source_finding_id` exists in the queue |

---

## 5. Execution plan

```
 STEP 1  Pin lockfiles ────────────────┐
         + .gitignore node_modules     │  independent, do first
                                       │
 STEP 2  npm ci, run every suite 3x ◄──┘
         record failures + flake
                                       ──► depends on 1
 STEP 3  Fix category assignment
         (stage2 executor + prompt,
          stage3 carry-through)           independent of 1 & 2

 STEP 4  Build stage4-handoff adapter  ──► depends on 3

 STEP 5  Contamination cleanup           independent, changes the tree
         (see answer-key repo)

 STEP 6  FREEZE BASELINE                ──► depends on 1, 2, 5
```

**Step 6 must come last.** Steps 1, 3, 4 and 5 all change the working copy or
its dependency tree, and the baseline keys on both. Freezing earlier means
discarding it.

| Step | Est. effort | Blocks |
|---|---|---|
| 1 Lockfiles | 30 min | everything |
| 2 Baseline measurement run | 2–4 h (mostly waiting) | FRR |
| 3 Category assignment | half day | patcher usefulness |
| 4 Handoff adapter | half day | patcher deployment |
| 5 Contamination cleanup | half day | metric validity |
| 6 Freeze | 2–4 h | — |

## 6. Definition of ready

The patcher may be deployed when **all** hold:

- [ ] `package-lock.json` committed for server and frontend; `npm ci` clean
- [ ] `npm run build` passes and is recorded
- [ ] Every suite run 3×, failures and flakes recorded in a frozen baseline
- [ ] Baseline references a committed lockfile sha
- [ ] Scanner emits ≤3 real category codes per finding
- [ ] `patch-queue.json` exists, schema-validates, paths are target-relative
- [ ] Contamination cleanup landed
- [ ] Baseline frozen **after** all of the above

Until every box is ticked, any patcher number produced is uninterpretable —
not wrong, but not attributable to the patcher.
