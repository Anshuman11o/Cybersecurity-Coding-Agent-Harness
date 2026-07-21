# Methodology notes: install/run status per tool

This accompanies `scan-benchmark-summary.md`. All five tools were pointed at the
full working copy (`target-apps/juice-shop/`, checked out to `/tmp/juice-shop-work`
for this run) in scan-only mode; no tool's fix/remediation/patch mode was invoked.

## 1. VulnHunter (Capital One)

- Installed via `./install.sh` into `~/.claude/skills/{vulnhunt,vulnhunt-fix-verify,vulnhunter-fix}` — clean install, no issues.
- Ran via a nested `claude --model opus -p "/vulnhunt <path>"` session (bash-enabled mode: dependencies were already installed in the target, so exploit tests could run, not just static PoCs).
- Note: the repo's own README carries a "Cyber-safeguard disclaimer" about Anthropic's Cyber Verification Program for accounts running dual-use vulnerability discovery/exploitation work at scale; this run is explicitly authorized security testing of our own repo, but flagged here per the tool's own documentation.
- Did not run `harness/local_harness/benchmark/` (the repo's own pre-mapped Juice Shop benchmark) — our own scoring against the hand-verified ground truth is what counts per the brief, and running a second, differently-scoped harness on top wasn't necessary for that.

## 2. VVAH (Visa)

- Installed via `pip install .` into a dedicated venv — clean install.
- `vvaharness doctor` reported 0 blocking issues via the `via:cli` backend (uses this session's already-authenticated `claude` login; no `ANTHROPIC_SDK_API_KEY` needed).
- `vvaharness estimate --repo` reported 742 code files / ~4M input tokens of raw scope before the pipeline's own stages multiply that.
- Ran `vvaharness scan --repo <path> --stop-after s9` (mandatory flag — without it, S10 remediation edits source files).

## 3. security-audit-skill (Cloudflare)

- Installed via `npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit` — clean install (project-local `.agents/skills/security-audit`, symlinked for Claude Code).
- No patch mode exists for this tool, so no extra guardrail was needed.
- Run scoped to 5 parallel hunting lanes (injection; broken access control/auth; AI/LLM; client-side/XSS; server-side misc SSRF/SSTI/XXE) rather than the skill's full attack-class matrix, since this is one of five tools benchmarked in a single pass — see `results/security-audit-skill/REPORT.md` for the full methodology note on this scoping choice.

## 4. raptor (community)

- Installed via `pip install -r requirements.txt`, `pip install semgrep`, into a dedicated venv.
- `RAPTOR_MAX_COST=5.00` set per the kickoff brief.
- CodeQL is off by default for `/scan` (opt-in via `--codeql`); the brief's literal invocation (`/scan` with no flags) is therefore a Semgrep-only scan — CodeQL CLI was not separately installed since it wasn't required for the documented invocation.
- Ran via a nested `claude --model sonnet -p` session from inside the raptor repo (its CLAUDE.md/`.claude/commands` define the `/project`, `/understand`, `/scan` slash commands); did not run `/exploit`, `/patch`, or `/agentic`.

## 5. deepsec (Vercel Labs)

- Installed via `npx deepsec init` + `pnpm install` inside the working copy's `.deepsec/` directory — clean install.
- No `AI_GATEWAY_API_KEY` was configured; deepsec fell back to this session's authenticated `claude` CLI login, as its README documents (noting real/large scans generally need more headroom than a subscription provides — this run stayed within that headroom by using `--thinking-level medium` instead of the default `xhigh`).
- `INFO.md` was bootstrapped directly (the auditor already had detailed knowledge of this codebase) rather than delegated to a sub-agent survey.
- Pipeline run: `deepsec scan` (fast regex candidate pass: 404 candidates across 142 files) → `deepsec process --agent claude --thinking-level medium` (AI investigation) → `deepsec revalidate` → `deepsec export --format md-dir --out ./findings`.
- No patch mode exists for this tool.

## Guardrails honored

- No tool's fix/remediation/patch mode was invoked (VVAH's `--stop-after s9` was the one mandatory flag; the other four have no such mode or it wasn't triggered).
- `answer-key.json` was not opened, read, or referenced by any of the five tools or during their scans — only by the scoring script (`tools/scan-benchmark/score.py`) afterward, run separately from all five tool sessions.
