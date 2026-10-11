/**
 * Report stage (productization plan §2.9, Part 4).
 *
 * Deterministic: no model call. Reads Stage 2's findings, the Stage 0.5
 * coverage ledger and the usage record, and writes the Part 4.4 Option A
 * outputs:
 *
 *     report.html     one self-contained file
 *     report.md       same content; the GitHub job summary in Option B
 *     findings.json   the report model every other output is rendered from
 *     findings.sarif  SARIF 2.1.0 with stable fingerprints
 *
 * Where they go depends on the profile:
 *
 *   product    <store>/runs/<run-id>/, the top of the run, beside run.json (the
 *              run's manifest). Internals stay in work/. The store's index.json
 *              and `latest` pointer are refreshed afterwards (runs-store.ts).
 *   benchmark  <runs root>/<provider>/report/, beside the stages, as before.
 *
 * meta.json and the logs always sit in <runs root>/<provider>/report/, like
 * every other stage's. A summary goes to stdout. Given the same artifacts and
 * the same working copy the stage writes the same files; only timestamps move,
 * and SOURCE_DATE_EPOCH pins those too.
 *
 * Reads of the scanned repository go through the read guard, exactly as
 * Stage 2's do: the lane manifest names the file, the guard decides whether it
 * may be opened. Upstream artifacts are read by fixed name only.
 *
 * Inputs, under runs/<provider>/:
 *   stage2-hunt-lanes-perfile/candidate-findings.json   required
 *   stage05-lane-selector-perfile/lane-assignments.json required (lanes, ledger)
 *   stage2-hunt-lanes-perfile/budget-consumption.json   lane outcomes, tokens
 *   stage2-hunt-lanes-perfile/meta.json                 model, arm, timing
 *   stage1-budget-governor-perfile/usage-v2.json        reconciled cost
 *   stage1-budget-governor-perfile/budget-plan-v2.json  the estimate
 *   stage0-recon/{architecture-summary,file-signals}.json, meta.json
 *   stage2-hunt-lanes-perfile/logs/*.stdout.log         retry count
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { RUNS_ROOT, REPO_ROOT, runPath } from '../../shared/run-paths.js'
import { resolveProvider, labelFor, costUsd, priceAsOf } from '../../shared/provider.js'
import { assertUpstream } from '../../shared/meta.js'
import { readCorpusFile, guardStats } from '../../shared/read-guard.js'
import { getRunContext, describeRunContext } from '../../shared/run-context.js'
import { buildReport } from './build.js'
import { repoInfo } from './git.js'
import { renderHtml } from './render-html.js'
import { renderMarkdown } from './render-md.js'
import { toSarif } from './sarif.js'
import { renderTerminal } from './terminal.js'
import { RUN_FILES, refreshStore } from './runs-store.js'
import type {
  BenchmarkReference, InArchitecture, InAssignments, InConsumption, InFileSignals, InFinding, InMeta,
  InPlan, InUsage, ReportInputs,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(__dirname, '..')
const SHARED_DIR = join(REPO_ROOT, 'tools/scanner/shared')

/**
 * The report's artifact directory. Not (yet) a key in run-paths.ts STAGES,
 * which this stage does not own; it is built from the same RUNS_ROOT and the
 * already-validated provider, so it sits beside the stages it reads, inside
 * the same provider-isolated tree.
 */
export const REPORT_STAGE = 'report'
export function reportDir(provider: string): string {
  return join(RUNS_ROOT, provider, REPORT_STAGE)
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch (err) {
    console.error(`  [WARN] unreadable JSON, ignored: ${path} (${(err as Error).message})`)
    return null
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

function gitShortSha(): string | null {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function generatedAt(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString()
  return new Date().toISOString()
}

async function main() {
  const started = new Date().toISOString()
  console.log('=== Report (deterministic) ===\n')
  const provider = resolveProvider('report')
  const ctx = getRunContext()

  const s2 = runPath(provider, 'stage2-hunt-lanes-perfile')
  const s05 = runPath(provider, 'stage05-lane-selector-perfile')
  const s1 = runPath(provider, 'stage1-budget-governor-perfile')
  const s0 = runPath(provider, 'stage0-recon')

  // Provenance first: a report built from another provider's lanes would look
  // entirely normal. assertUpstream tolerates a missing meta.json (older runs).
  assertUpstream(provider, 'stage05-lane-selector-perfile')
  assertUpstream(provider, 'stage2-hunt-lanes-perfile')

  const findings = readJson<InFinding[]>(join(s2, 'candidate-findings.json'))
  const assignments = readJson<InAssignments>(join(s05, 'lane-assignments.json'))
  if (!Array.isArray(findings) || !assignments?.lanes) {
    console.error(`ERROR: the report needs Stage 2 findings and the Stage 0.5 lane manifest under ${join(RUNS_ROOT, provider)}`)
    console.error(`  ${join(s2, 'candidate-findings.json')}: ${Array.isArray(findings) ? 'ok' : 'missing or unreadable'}`)
    console.error(`  ${join(s05, 'lane-assignments.json')}: ${assignments?.lanes ? 'ok' : 'missing or unreadable'}`)
    process.exit(1)
  }

  const consumption = readJson<InConsumption>(join(s2, 'budget-consumption.json'))
  // A bare array is the mid-run checkpoint shape from before the v2 object.
  const consumptionObj: InConsumption | null = Array.isArray(consumption)
    ? { legacy_entries: consumption as never }
    : consumption
  const usage = readJson<InUsage>(join(s1, 'usage-v2.json'))
  // usage-v2.json describes whichever Stage 2 run was last reconciled. Trust it
  // only when it postdates the consumption it should describe.
  const usageStale = !!usage && (
    !consumptionObj?.generated_at || !usage.generated_at ||
    Date.parse(usage.generated_at) < Date.parse(consumptionObj.generated_at) ||
    (usage.provider !== undefined && usage.provider !== provider))

  let retries: number | null = null
  const log = join(s2, 'logs', 'stage2-hunt-lanes-perfile.stdout.log')
  if (existsSync(log)) retries = (readFileSync(log, 'utf-8').match(/\[RETRY\]/g) ?? []).length

  const inputs: ReportInputs = {
    findings,
    assignments,
    consumption: consumptionObj,
    usage,
    plan: readJson<InPlan>(join(s1, 'budget-plan-v2.json')),
    stage2Meta: readJson<InMeta>(join(s2, 'meta.json')),
    stage0Meta: readJson<InMeta>(join(s0, 'meta.json')),
    architecture: readJson<InArchitecture>(join(s0, 'architecture-summary.json')),
    fileSignals: readJson<InFileSignals>(join(s0, 'file-signals.json')),
    classRegistry: readJson(join(SHARED_DIR, 'vuln-classes.json')) ?? {},
    signalClasses: readJson(join(SHARED_DIR, 'signal-classes.json')),
    retries,
    usageStale,
  }

  // The tree the lanes are relative to is the one Stage 0.5 recorded.
  let targetDir = assignments.target_dir
  if (!targetDir || !existsSync(targetDir)) {
    console.warn(`  [WARN] lane manifest target ${targetDir} does not exist; using the run context's ${ctx.targetRoot}`)
    targetDir = ctx.targetRoot
  } else if (targetDir !== ctx.targetRoot) {
    console.warn(`  [WARN] lane manifest target ${targetDir} differs from the run context's ${ctx.targetRoot}; reading the manifest's`)
  }

  const pkg = readJson<{ version: string }>(join(PACKAGE_DIR, 'package.json'))
  const report = buildReport(inputs, {
    provider,
    modelLabel: labelFor(provider),
    repo: repoInfo(targetDir),
    repoRoot: REPO_ROOT,
    // Same path form Stage 2 hands the guard, so the denylist matches alike.
    readTargetFile: (rel) => readCorpusFile(relative(REPO_ROOT, join(targetDir, rel))),
    costUsd: (i, o, c, w) => costUsd(provider, i, o, c, w),
    priceAsOf: priceAsOf(provider),
    benchmark: readJson<BenchmarkReference>(join(PACKAGE_DIR, 'benchmark-reference.json')),
    tool: { name: 'secscan', version: pkg?.version ?? '0.0.0', scannerGitSha: gitShortSha() },
    profile: ctx.profile,
    runId: ctx.runId,
    generatedAt: generatedAt(),
  })

  // Stage-shaped home for meta.json and the logs run.sh tees; the user-facing
  // files go to the top of the product run directory instead, when there is one.
  const metaDir = reportDir(provider)
  const outDir = ctx.profile === 'product' && ctx.runDir ? ctx.runDir : metaDir
  mkdirSync(metaDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  // Benchmark artifacts under tools/scanner/runs/ are committed, but the report
  // is derived from them and runs to tens of megabytes on a full run, so it
  // keeps itself out of git. The archive skills copy the directory regardless.
  // A product run needs nothing: the whole store is already ignored.
  if (ctx.profile === 'benchmark' && !existsSync(join(outDir, '.gitignore'))) {
    writeFileSync(join(outDir, '.gitignore'), '*\n')
  }
  const outputs = {
    'report.html': join(outDir, 'report.html'),
    'report.md': join(outDir, 'report.md'),
    'findings.json': join(outDir, 'findings.json'),
    'findings.sarif': join(outDir, 'findings.sarif'),
  }
  writeAtomic(outputs['findings.json'], JSON.stringify(report, null, 2) + '\n')
  writeAtomic(outputs['findings.sarif'], JSON.stringify(toSarif(report), null, 2) + '\n')
  writeAtomic(outputs['report.md'], renderMarkdown(report))
  writeAtomic(outputs['report.html'], renderHtml(report))

  // Same fields as shared/meta.ts writeMeta(), which takes only the stage keys
  // run-paths.ts lists.
  writeAtomic(join(metaDir, 'meta.json'), JSON.stringify({
    provider,
    model: 'deterministic',
    stage: REPORT_STAGE,
    git_sha: gitShortSha() ?? 'unknown',
    started,
    ended: new Date().toISOString(),
    exit_code: 0,
    blocked_reads: guardStats().blocked,
    degraded: false,
    report_status: report.status.state,
    findings: report.findings.length,
    run_context: describeRunContext(),
  }, null, 2) + '\n')

  // Product: the run's manifest, then the store's index and latest pointer.
  const shownExtra: Record<string, string> = {}
  if (ctx.profile === 'product' && ctx.runDir && ctx.outRoot && outDir === ctx.runDir) {
    writeAtomic(join(outDir, 'run.json'), JSON.stringify(
      runManifest(report, provider, ctx.runDir, inputs.usageStale), null, 2) + '\n')
    const index = refreshStore(ctx.outRoot, report.generated_at)
    shownExtra['run.json'] = join(outDir, 'run.json')
    shownExtra['index.json'] = join(ctx.outRoot, 'index.json')
    if (index.latest === ctx.runId) shownExtra['latest'] = join(ctx.outRoot, 'latest')
  }

  const shown: Record<string, string> = {}
  for (const [k, p] of Object.entries({ ...outputs, ...shownExtra })) {
    const rel = relative(process.env.INIT_CWD ?? process.cwd(), p)
    shown[k] = rel.startsWith('..') ? p : rel
  }
  console.log(renderTerminal(report, shown))
  if (guardStats().blocked > 0) {
    console.log(`\n  [GUARD] ${guardStats().blocked} file read(s) refused while building excerpts; those steps show no excerpt.`)
  }
}

const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * run.json: what this run was and what it produced, readable without opening
 * any stage artifact. Every path in it is relative to the run directory.
 * Built at report time from the stages' own meta.json files, so it records what
 * ran rather than what was asked for.
 */
function runManifest(
  report: ReturnType<typeof buildReport>, provider: string, runDir: string, usageStale: boolean,
): Record<string, unknown> {
  const work = join(RUNS_ROOT, provider)
  const stages = existsSync(work)
    // This stage's own meta.json is left out: its timestamps are this process,
    // and generated_at already records when the report was made.
    ? readdirSync(work).sort().filter((stage) => stage !== REPORT_STAGE).flatMap((stage) => {
        const m = readJson<InMeta>(join(work, stage, 'meta.json'))
        return m ? [{
          stage, model: m.model ?? null, git_sha: m.git_sha ?? null, started: m.started ?? null,
          ended: m.ended ?? null, exit_code: m.exit_code ?? null, blocked_reads: m.blocked_reads ?? null,
        }] : []
      })
    : []
  const hashes = (files: string[]) => Object.fromEntries(files
    .filter((f) => existsSync(join(runDir, f)))
    .map((f) => [f, sha256File(join(runDir, f))]))
  const rel = (p: string) => relative(runDir, p).split('\\').join('/')
  const started = stages.map((s) => s.started).filter((t): t is string => !!t).sort()[0] ?? null
  return {
    schema_version: '1.0',
    run_id: report.header.run_id,
    generated_at: report.generated_at,
    status: report.status.state,
    status_reasons: report.status.reasons,
    started,
    profile: report.header.profile,
    target_root: report.header.root,
    repo: { name: report.header.repo, commit: report.header.commit, branch: report.header.branch, github: report.header.github },
    tool: report.tool,
    provider,
    model: report.header.model,
    scope: report.header.scope,
    config_hash: report.header.config_hash,
    config: report.appendix.config,
    stages,
    inputs: hashes([
      'stage2-hunt-lanes-perfile/candidate-findings.json',
      'stage2-hunt-lanes-perfile/budget-consumption.json',
      'stage05-lane-selector-perfile/lane-assignments.json',
      'stage1-budget-governor-perfile/usage-v2.json',
      'stage1-budget-governor-perfile/budget-plan-v2.json',
    ].map((f) => rel(join(work, f)))),
    usage_record_ignored_as_stale: usageStale,
    outputs: hashes(RUN_FILES.filter((f) => f !== 'run.json')),
    summary: {
      findings: report.summary.total,
      by_severity: report.summary.by_severity,
      by_confidence_band: report.summary.by_confidence_band,
      files_scanned: report.coverage.files_scanned,
      files_total: report.coverage.files_total,
      cost_usd: report.run_stats.cost_usd,
      estimate_usd: report.run_stats.estimate_usd,
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Report failed:', err)
    process.exit(1)
  })
}
