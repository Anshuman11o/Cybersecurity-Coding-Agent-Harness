import OpenAI from 'openai'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProvider, clientConfigFor, modelFor, outputTokenCap, samplingParams, transportFor } from '../../shared/provider.js'
import { runPath, REPO_ROOT } from '../../shared/run-paths.js'
import { getRunContext } from '../../shared/run-context.js'
import { readCorpusFile } from '../../shared/read-guard.js'
import { assertUpstream, writeMeta } from '../../shared/meta.js'
import { cacheRoot } from '../../shared/playbook-cache.js'
import { CLASS_SELECTION_FILE, PLAYBOOK_STAGE, type ClassRegistry, type SignalClassMap } from '../../shared/playbook-overlay.js'
import { runPlaybookAgent, type AgentOptions, type ReconInput, type SourceExcerpt, type SourceExcerpts, type UsageCall } from './agent.js'
import { API_PROFILE_FILE, readApiProfile } from '../../shared/api-profile.js'
// Relative across packages: the contract has no runtime dependencies.
import { FILE_INVENTORY_FILE, type FileInventoryArtifact, type InventoryEntry } from '../../stage0-recon/src/recon-contract.js'
import { PlaybookMeter } from './meter.js'

function writeJson(file: string, data: unknown) {
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n')
  renameSync(file + '.tmp', file)
}

export function loadRecon(dir: string): ReconInput {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const mapFile = join(dir, 'repo-map.md')
  const map = existsSync(mapFile) ? readFileSync(mapFile, 'utf8') : ''
  return {
    architecture: read('architecture-summary.json'),
    category_applicability: read('category-applicability.json'),
    file_signals: read('file-signals.json'),
    dependency_manifests: map.match(/^## Dependency manifests\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '',
  }
}

/** Caps on the source decision calls receive: per file, then for the whole set. */
export const EXCERPT_FILE_BYTES = 12000
export const EXCERPT_TOTAL_BYTES = 200000

/** Inventoried languages whose files are not source unless recon flagged them. */
const UNFLAGGED_EXCLUDED_LANGUAGES = new Set(['css', 'json'])
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Source of the target's files, in two groups. First every file recon flagged with a signal other than dep_manifest,
 *  most distinct signals first, then by path. Then every other inventoried file that is not a test, oversize or empty,
 *  whose language is not css or json and whose signals are not only dep_manifest, by path, with no signals. A path
 *  appears once. Read through the corpus guard; a null read is skipped and counted. A file over the per-file cap is cut
 *  at its last newline within it; the set stops at the first file that would pass the total cap, and the rest are
 *  counted as omitted. */
export function collectSourceExcerpts(fileSignals: ReconInput['file_signals'], inventory: InventoryEntry[], targetDir: string,
  read: (relPath: string) => string | null = readCorpusFile): SourceExcerpts {
  const flagged = Object.entries(fileSignals.files)
    .filter(([, signals]) => signals.some(s => s !== 'dep_manifest'))
    .sort(([a, x], [b, y]) => new Set(y).size - new Set(x).size || byPath(a, b))
  const seen = new Set(flagged.map(([path]) => path))
  const unflagged: [string, string[]][] = []
  for (const entry of [...inventory].sort((a, b) => byPath(a.path, b.path))) {
    if (seen.has(entry.path) || entry.test || entry.oversize || entry.empty || UNFLAGGED_EXCLUDED_LANGUAGES.has(entry.language)) continue
    const signals = fileSignals.files[entry.path] ?? []
    if (signals.length > 0 && signals.every(s => s === 'dep_manifest')) continue
    seen.add(entry.path)
    unflagged.push([entry.path, []])
  }
  const candidates = [...flagged, ...unflagged]
  const files: SourceExcerpt[] = []
  let total = 0, unreadable = 0
  for (const [k, [path, signals]] of candidates.entries()) {
    const content = read(relative(REPO_ROOT, join(targetDir, path)))
    if (content === null) { unreadable++; continue }
    let bytes = Buffer.from(content)
    const truncated = bytes.length > EXCERPT_FILE_BYTES
    if (truncated) {
      // No newline within the cap (one long line): cut at the cap, backed off to a UTF-8 character boundary.
      const newline = bytes.lastIndexOf(0x0a, EXCERPT_FILE_BYTES - 1)
      let cut = newline >= 0 ? newline + 1 : EXCERPT_FILE_BYTES
      while (newline < 0 && cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
      bytes = bytes.subarray(0, cut)
    }
    if (total + bytes.length > EXCERPT_TOTAL_BYTES) return { files, omitted_files: candidates.length - k, unreadable_files: unreadable }
    total += bytes.length
    files.push({ path, signals, truncated, text: bytes.toString('utf8') })
  }
  return { files, omitted_files: 0, unreadable_files: unreadable }
}

/** The decision-loop switches. Read here so the agent itself reads no environment. */
export function loopOptions(env: NodeJS.ProcessEnv = process.env): NonNullable<AgentOptions['loop']> {
  const passes = env.SCANNER_PLAYBOOK_LOOP_PASSES
  const maxPasses = passes === undefined ? 1 : Number(passes)
  if (passes !== undefined && (!/^[1-9][0-9]*$/.test(passes) || !Number.isSafeInteger(maxPasses))) {
    throw new Error(`SCANNER_PLAYBOOK_LOOP_PASSES must be a positive integer, got ${JSON.stringify(passes)}`)
  }
  return { enabled: env.SCANNER_PLAYBOOK_LOOP !== '0', maxPasses }
}

export async function main(createResponse?: AgentOptions['create']): Promise<void> {
  const provider = resolveProvider('playbook')
  const model = modelFor(provider)
  const started = new Date().toISOString()
  const dir = runPath(provider, PLAYBOOK_STAGE)
  mkdirSync(dir, { recursive: true })
  const calls: UsageCall[] = []
  // Mark failure first: a crash must not leave old overlays looking current.
  writeMeta(provider, PLAYBOOK_STAGE, model, started, 1)
  writeJson(join(dir, 'usage.json'), { schema: 'secscan.playbook-usage/1', calls })
  // An earlier attempt's decision must never be read as this run's.
  rmSync(join(dir, 'class-decision.json'), { force: true })
  try {
    const loop = loopOptions()
    assertUpstream(provider, 'stage0-recon')
    const recon = loadRecon(runPath(provider, 'stage0-recon'))
    if (recon.file_signals.target_dir !== getRunContext().targetRoot) throw new Error('Recon target differs from this run')
    const inventory: FileInventoryArtifact = JSON.parse(readFileSync(join(runPath(provider, 'stage0-recon'), FILE_INVENTORY_FILE), 'utf8'))
    if (inventory.target_dir !== getRunContext().targetRoot) throw new Error('Recon inventory target differs from this run')
    const sourceExcerpts = collectSourceExcerpts(recon.file_signals, inventory.files, getRunContext().targetRoot)
    const shared = join(REPO_ROOT, 'tools/scanner/shared')
    const builtins: ClassRegistry = JSON.parse(readFileSync(join(shared, 'vuln-classes.json'), 'utf8'))
    const signals: SignalClassMap = JSON.parse(readFileSync(join(shared, 'signal-classes.json'), 'utf8'))
    const builtinTexts = new Map<string, string>()
    for (const entry of Object.values(builtins)) {
      const mod = await import(`../../stage2-hunt-lanes-perfile/src/playbooks/${entry.playbook}.js`)
      builtinTexts.set(entry.playbook, mod.playbook)
    }
    if (transportFor(provider) !== 'openai') throw new Error('Playbook agent requires Responses API with web_search')
    const config = clientConfigFor(provider)
    if (!createResponse) {
      if (!config.apiKey) throw new Error('No credential configured for the selected playbook model')
      const client = new OpenAI({ ...config, apiKey: config.apiKey, maxRetries: 0 })
      createResponse = request => client.responses.create(request)
    }
    const profile = readApiProfile(join(runPath(provider, 'stage0-recon'), API_PROFILE_FILE))
    const meter = new PlaybookMeter(provider, getRunContext(), config.baseURL ?? null, profile?.served_tier ?? null, createResponse)
    const { plan, overlay, selection } = await runPlaybookAgent({
      recon, builtins, builtinTexts, signals, model, cacheRoot: cacheRoot(), sourceExcerpts,
      allowedDomains: (process.env.SCANNER_PLAYBOOK_ALLOWED_DOMAINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
      maxOutputTokens: outputTokenCap(provider, 16000), sampling: samplingParams(provider), loop,
      create: (request, purpose) => meter.call(request, purpose),
      recordUsage: call => { calls.push(call); writeJson(join(dir, 'usage.json'), { schema: 'secscan.playbook-usage/1', calls }) },
      recordDecision: decision => {
        writeJson(join(dir, 'class-decision.json'), decision)
        console.log(`[playbook-agent] decision saved: ${decision.classes.length} classes ` +
          `(${decision.builtin.length} built-in, ${decision.added.length} additional)`)
      },
      recordResearchFailure: failure => {
        mkdirSync(join(dir, 'research-failures'), { recursive: true })
        writeJson(join(dir, 'research-failures', `${failure.class_id}.json`), failure)
        console.log(`[playbook-agent] ${failure.purpose} FAILED check=${failure.check} bytes=${failure.byte_size ?? '-'} ` +
          `(bounds ${failure.size_bounds.join('-')}) missing=${failure.missing_sections.join(', ') || '-'}`)
      },
      log: line => console.log(line),
    })
    writeJson(join(dir, 'playbook-plan.json'), plan)
    writeJson(join(dir, 'classes-overlay.json'), overlay)
    writeJson(join(dir, CLASS_SELECTION_FILE), selection)
    writeMeta(provider, PLAYBOOK_STAGE, model, started)
    const searches = calls.reduce((n, c) => n + c.web_search_calls, 0)
    console.log(`Playbook agent: ${selection.classes.length} class(es) selected (${selection.builtin.length} built-in, ` +
      `${selection.added.length} additional); turns=${plan.turns.length}; searches=${searches}`)
  } catch (error) {
    writeMeta(provider, PLAYBOOK_STAGE, model, started, 1)
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error('[playbook-agent]', error.message)
  process.exitCode = 1
})
