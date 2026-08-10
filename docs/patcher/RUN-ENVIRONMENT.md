# Patcher run environment

What a patcher run needs on the machine before it can start, what is installed
here as of **2026-08-10**, and exactly how to rebuild it somewhere else.

Companion to `docs/patcher/SUBSET-04-RUN.md`, which describes the run itself.
That document's "Preflight status as of 2026-08-10" section records the two
environmental failures this work was done to clear.

---

## 1. What preflight actually demands

`preflight()` in `tools/patcher/src/run_patcher.py` raises two environmental
problems. Neither is a configuration defect; both are machine state.

**a. The shared `node_modules`** — `target.node_modules` in the run config must
be an existing directory. `workspace.prepare()`
(`tools/patcher/src/workspace.py`) tar-copies the base tree into the work tree
with `--exclude=node_modules --exclude=.git`, then **symlinks** the shared
install in at `<work_tree>/node_modules`. So the install must live outside any
tree, be shared by every work tree and every per-unit wave tree, and never
appear in a diff or a tree hash. The patcher deliberately never runs `npm`
itself.

**b. Six startup files in the base tree** — this is the "6 required startup
files missing" message, and the list is literal, not a guess. From
`run_patcher.py`:

| # | Path (relative to `base_tree`) | Produced by |
|---|---|---|
| 1 | `build/server.js` | `npm run build:server` (`tsc`, `outDir: ./build`) |
| 2 | `frontend/dist/frontend/index.html` | `npm run build:frontend` (`ng build --configuration production`) |
| 3 | `frontend/dist/frontend/styles.css` | same |
| 4 | `frontend/dist/frontend/main.js` | same |
| 5 | `frontend/dist/frontend/polyfills.js` | same |
| 6 | `frontend/dist/frontend/hacking-instructor-*.js` (glob — the name is content-hashed) | same |

Five of the six are Angular output, so **the frontend build is not optional**,
even though subset 4 touches no frontend file. The API suite boots the
application through `createApp()` (`test/api/helpers/setup.ts` →
`server.ts`), and the application refuses to start without its build output.
Skipping the build would redden every API gate for a reason unrelated to any
patch.

`build/` and `frontend/dist/` are **not** excluded by
`workspace.prepare()`'s tar, so a work tree inherits both from the base tree.
Building the base once is enough; no work tree needs its own build.

---

## 2. What is installed on this machine

Everything lives under `/home/user/patcher-work/`, outside the repository.
Nothing inside `target-apps/juice-shop-blind/` was modified — verified below.

```
/home/user/patcher-work/
├── node_modules/                      427 MB, 1241 distinct   <- target.node_modules
│                                              name@version
├── base/juice-shop-blind/             501 MB total            <- built base tree
│   ├── (source)                        30 MB, byte-identical to the repo checkout
│   ├── build/                         2.7 MB  (tsc output)
│   ├── frontend/dist/                  25 MB  (Angular production output)
│   ├── frontend/node_modules/         445 MB  (needed only to REBUILD the frontend;
│   │                                           excluded from every work tree copy)
│   └── node_modules -> /home/user/patcher-work/node_modules
├── pinned/                            1.1 MB  (see §4)
├── logs/                              install and build logs
└── subset4.run-config.builtbase.json  local preflight proof only, see §3
```

Total: **928 MB**. Container disk after the work: `9.2 GB` used, `28 GB`
reported available.

Toolchain: `node v22.22.2`, `npm 10.9.7`. The app declares
`engines: {"node": "22 - 26"}`, so the installed node is in range.

### Why the base tree is a copy and not the repo checkout

`target-apps/juice-shop-blind/` is the pristine tree every run is copied from,
`build/` is not gitignored there, and several agents share the checkout.
Building in place would leave ~2.7 MB of untracked compiler output in a
repository somebody is about to commit, and would silently change the tree all
future runs start from. So the base was copied to
`/home/user/patcher-work/base/juice-shop-blind` and built there.

Verified equivalence — the built base differs from the repo checkout only by
build output and the `node_modules` symlink:

```
$ diff -rq --exclude=node_modules --exclude=build --exclude=dist \
    /home/user/Cybersecurity-Coding-Agent-Harness/target-apps/juice-shop-blind \
    /home/user/patcher-work/base/juice-shop-blind
SOURCE IDENTICAL to repo tree
```

---

## 3. Preflight status now — and the one config change still required

**The committed config still fails preflight, by one problem, and I could not
fix it because I do not own the config file.** `target.base_tree` points at the
in-repo checkout, which is deliberately unbuilt:

```
$ python3 tools/patcher/src/run_patcher.py \
    --config tools/patcher/config/subset4.run-config.json --check
[12:28:13]   ok   bug report: 10 task(s), 5 file(s)
[12:28:13]   ok   playbook: 7 entry/entries
[12:28:13]   ok   sandbox hook: verified — denies out-of-tree access
[12:28:13]   ok   execution: waves, up to 2 chain(s) at a time
[12:28:13]   ok   post-wave gate: up to 2 unit gate(s) at a time
[12:28:13]   FAIL /home/user/Cybersecurity-Coding-Agent-Harness/target-apps/juice-shop-blind is not built: 6 file(s) the application requires at startup are missing (build/server.js, frontend/dist/frontend/index.html, frontend/dist/frontend/styles.css ...). The API suite boots the app, so every API gate would fail at load regardless of any patch. Point base_tree at a built tree, or build it.
[12:28:13] 1 problem(s). Nothing was run and nothing was spent.
```

Exit code 2. The `node_modules` failure is gone.

### Recommended change (config owner)

One line in `tools/patcher/config/subset4.run-config.json`:

```json
  "target": {
-   "base_tree": "target-apps/juice-shop-blind",
+   "base_tree": "/home/user/patcher-work/base/juice-shop-blind",
    "work_tree": "/home/user/patcher-work/subset4/tree",
    "node_modules": "/home/user/patcher-work/node_modules"
  }
```

Nothing else changes. `run-config.example.json` deserves the same treatment,
and its `_comment` should say that the base tree must be a *built* tree outside
the repository.

Proof that this is the only remaining problem — the identical config with only
`base_tree` redirected, saved at
`/home/user/patcher-work/subset4.run-config.builtbase.json`:

```
$ python3 tools/patcher/src/run_patcher.py \
    --config /home/user/patcher-work/subset4.run-config.builtbase.json --check
[12:28:23]   ok   bug report: 10 task(s), 5 file(s)
[12:28:23]   ok   playbook: 7 entry/entries
[12:28:23]   ok   sandbox hook: verified — denies out-of-tree access
[12:28:23]   ok   execution: waves, up to 2 chain(s) at a time
[12:28:23]   ok   post-wave gate: up to 2 unit gate(s) at a time
[12:28:23] preflight clean.
```

Exit code 0.

That file is a **proof artefact, not a run config**. Launch the run from the
committed config once it carries the `base_tree` change; do not fork configs.

---

## 4. The lockfile situation — read this before quoting any differential metric

**There is no lockfile, and the application actively prevents one from being
created.** Both `target-apps/juice-shop-blind/.npmrc` and
`target-apps/juice-shop-blind/frontend/.npmrc` contain exactly:

```
package-lock=false
```

`git ls-files` finds no `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`
anywhere in the target tree. (`ftp/package-lock.json.bak` is application
content, not a lockfile.) So **`npm ci` is impossible** — it requires a
lockfile — and `docs/patcher/SUBSET-04-RUN.md`'s instruction to install "with
`npm ci` against the committed lockfile" cannot be followed as written. What
ran instead:

```
CYPRESS_INSTALL_BINARY=0 npm install --no-audit --no-fund
```

**What that means for the numbers.** The dependency set is whatever the
registry resolved on 2026-08-10. Two consequences a reader of any result must
be told:

1. A test that fails after a patch *could* be a dependency change rather than
   the patch — the usual reason for pinning. Within a single run this is
   harmless: every wave, every unit tree and every gate shares one immutable
   `/home/user/patcher-work/node_modules`, so the differential (before-patch vs
   after-patch) is measured against a fixed dependency set. The risk is
   **across** runs and **across** machines.
2. A run reproduced on another machine, or on this one after a reinstall, is
   not guaranteed to have the same dependency tree. Cross-run comparison of
   pass/fail counts therefore carries the same caveat that a ground-truth
   correction carries: state it next to the number.

**Mitigation applied.** The resolved set was captured after the fact:

| File under `/home/user/patcher-work/pinned/` | What it is |
|---|---|
| `installed-root.txt` | 1241 lines, `name@version`, read out of the shared `node_modules` — the exact set this environment runs |
| `installed-frontend.txt` | 800 lines, same, for the frontend install that produced `frontend/dist` |
| `package-lock.json` | 651 KB, generated with `npm install --package-lock-only --package-lock=true`; npm reported `up to date`, i.e. it describes the installed tree |
| `frontend-package-lock.json` | 434 KB, same for `frontend/` |

These were generated **today**, and pin to what resolved **today**. They are
kept outside the application tree so the base tree stays byte-identical to the
repo checkout. To make future runs reproducible, the honest fix is to commit
`package-lock.json` into `target-apps/juice-shop-blind/` and remove
`package-lock=false` from its `.npmrc` — a change inside the pristine tree,
which is a decision for whoever owns that tree, not something this work did.

Until that happens, a run reinstalled from scratch can at best be made
*consistent* by installing from `pinned/package-lock.json`:

```bash
cp /home/user/patcher-work/pinned/package-lock.json \
   /home/user/patcher-work/base/juice-shop-blind/package-lock.json
cd /home/user/patcher-work/base/juice-shop-blind
CYPRESS_INSTALL_BINARY=0 npm ci --package-lock=true --no-audit --no-fund
```

That path is **untested here** — the environment was built before the lockfile
existed. Do not assume it works without trying it.

---

## 5. Reproducing this on a fresh machine

Scripted: `tools/patcher/setup/prepare_env.sh` (`--verify` re-checks an existing
install; `--force` discards and rebuilds the base copy). It is idempotent and
refuses to clobber an existing base tree without `--force`. By hand:

```bash
# 1. copy the pristine tree out of the repository — never build in place
mkdir -p /home/user/patcher-work/{base,logs,pinned}
cd /home/user/Cybersecurity-Coding-Agent-Harness/target-apps
tar -cf - --exclude=node_modules --exclude=.git juice-shop-blind \
  | tar -C /home/user/patcher-work/base -xf -

# 2. install + build. The root `postinstall` does the whole chain:
#      cd frontend && npm install
#      && npm run build:frontend      (ng build --configuration production + sbom)
#      && npm run build:server        (tsc -> build/)
cd /home/user/patcher-work/base/juice-shop-blind
CYPRESS_INSTALL_BINARY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npm install --no-audit --no-fund

# 3. move the install out of the tree, symlink it back so the base can rebuild
mv node_modules /home/user/patcher-work/node_modules
ln -s /home/user/patcher-work/node_modules node_modules
rm -rf frontend/.angular          # regenerable build cache; would ride into every work tree

# 4. check the six files
tools/patcher/setup/prepare_env.sh --verify
```

Wall time on this machine, from the logs: the successful root install reported
`added 860 packages, and audited 861 packages in 39s` — but with a warm npm
cache, because a first attempt had already downloaded everything before dying
at Cypress (see below); budget ~3 min cold, including an `sqlite3` `node-gyp`
build from source. Frontend install `added 1427 packages in 2m`. Angular
production bundle `21.273 seconds`. `tsc` a few seconds. Roughly **8 minutes
end to end on a cold cache**.

(npm's "added N" counts tree nodes including nested duplicates; the de-duplicated
`name@version` sets recorded in `pinned/` are 1241 root and 800 frontend.)

### `CYPRESS_INSTALL_BINARY=0` is required, not an optimisation

The first `npm install` **failed outright**:

```
npm error path .../node_modules/cypress
npm error command sh -c node dist/index.js --exec install
npm error Installing Cypress (version: 15.20.0)
npm error ❯  Downloading Cypress
npm error Error: read ECONNRESET
```

The ~250 MB Cypress binary download dies through the outbound proxy and takes
the whole install with it — no `node_modules`, no build. Cypress is a
devDependency used only by `npm run test:e2e`, which no gate in any run config
invokes (`commands.full_suite` is `npm run test:server` + `npm run test:api`).
Setting `CYPRESS_INSTALL_BINARY=0` skips only the binary; the `cypress` package
itself is still installed, which is all `tsc` needs for `cypress.config.ts`.

No TLS verification was disabled and `HTTPS_PROXY` was left set.
`registry.npmjs.org` is in `no_proxy`, so package metadata and tarballs go
direct; only the Cypress CDN fetch was affected.

---

## 6. Gate sanity — can the run's gates actually execute?

A run whose gates cannot run is worse than no run, so each gate command from
`commands` in the run config was executed by hand against a throwaway work tree
built with the real `workspace.prepare()` (which proves the symlink shape works
too: `node_modules -> /home/user/patcher-work/node_modules`, and
`frontend/node_modules` correctly absent).

**V1 typecheck** — `npx tsc --noEmit -p tsconfig.json`

```
EXIT=0
```

Clean on the unpatched tree, so a red V1 during the run means the patch, not
the baseline.

**Server test file** —
`node --import ./test/server/helpers/test-env.mjs --import tsx --test --test-force-exit test/server/appVersion.unit.test.ts`

```
# tests 1
# suites 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 851.818029
EXIT=0
```

**API test file** (the important one — it boots the application, which is what
the six build files are for) —
`node --import ./test/api/helpers/test-env.mjs --import tsx --test --test-force-exit test/api/languages.test.ts`

```
# tests 1
# suites 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2985.624558
EXIT=0
```

The throwaway tree was deleted afterwards so it cannot be mistaken for a run
tree. `/home/user/patcher-work/subset4/tree` does not exist — phase 0 must be
launched **without** `--force` so it builds the tree itself.

---

## 7. What was NOT done, and known gaps

- **The committed run config was not edited.** Another agent owns
  `tools/patcher/config/`. Until the `base_tree` line in §3 lands, `--check`
  against the committed config exits 2. This is the one thing standing between
  here and a launchable run.
- **`npm ci` was not used, because no lockfile exists.** §4 in full. Every
  differential metric from this environment is pinned only by
  `/home/user/patcher-work/pinned/`, generated after the install, on
  2026-08-10.
- **The lockfile-based reinstall path in §4 is untested.**
- **The full suites were never run.** `npm run test:server` and
  `npm run test:api` (`commands.full_suite`, and `policy.final_full_suite` is
  `true`) take far longer than one file and were out of scope; only one file
  from each of the two harnesses was executed. A green single file proves the
  harness loads, the app boots and the shared `node_modules` resolves — it does
  not prove the whole suite is green at baseline. **Someone should run
  `npm run test:server` and `npm run test:api` once against the unpatched base
  before the run**, or the final full-suite gate has no baseline to be compared
  against and any red in it is unattributable.
- **The Cypress binary is absent**, so `npm run test:e2e` / `npm run
  cypress:run` will not work in this environment. No configured gate uses them.
- **`frontend/node_modules` (445 MB) lives inside the base tree.** It is
  excluded from every work tree copy by `prepare()`'s `--exclude=node_modules`,
  which matches at any depth. It is kept only so the frontend can be rebuilt
  without a full reinstall. Delete it first if disk runs short.
- **Disk projection.** Each work tree is ≈ 61 MB (source + `build/` +
  `frontend/dist/`). A wave with `task_concurrency: 2` adds two per-unit trees
  of the same size under the run directory, cleaned after the wave merges
  unless a unit is suspect, plus per-task source-only snapshot tars. Budget a
  few hundred MB on top of the 928 MB already used.
