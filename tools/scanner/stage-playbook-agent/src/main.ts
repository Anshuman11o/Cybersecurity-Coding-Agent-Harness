import OpenAI from 'openai'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProvider, clientConfigFor, modelFor, outputTokenCap, samplingParams, transportFor } from '../../shared/provider.js'
import { runPath, REPO_ROOT } from '../../shared/run-paths.js'
import { getRunContext } from '../../shared/run-context.js'
import { assertUpstream, writeMeta } from '../../shared/meta.js'
import { cacheRoot } from '../../shared/playbook-cache.js'
import { CLASS_SELECTION_FILE, PLAYBOOK_STAGE, type ClassRegistry, type SignalClassMap } from '../../shared/playbook-overlay.js'
import { runPlaybookAgent, type AgentOptions, type ReconInput, type UsageCall } from './agent.js'
import { API_PROFILE_FILE, readApiProfile } from '../../shared/api-profile.js'
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
  try {
    assertUpstream(provider, 'stage0-recon')
    const recon = loadRecon(runPath(provider, 'stage0-recon'))
    if (recon.file_signals.target_dir !== getRunContext().targetRoot) throw new Error('Recon target differs from this run')
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
      recon, builtins, builtinTexts, signals, model, cacheRoot: cacheRoot(),
      allowedDomains: (process.env.SCANNER_PLAYBOOK_ALLOWED_DOMAINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
      maxOutputTokens: outputTokenCap(provider, 16000), sampling: samplingParams(provider),
      create: request => meter.call(request),
      recordUsage: call => { calls.push(call); writeJson(join(dir, 'usage.json'), { schema: 'secscan.playbook-usage/1', calls }) },
    })
    writeJson(join(dir, 'playbook-plan.json'), plan)
    writeJson(join(dir, 'classes-overlay.json'), overlay)
    writeJson(join(dir, CLASS_SELECTION_FILE), selection)
    writeMeta(provider, PLAYBOOK_STAGE, model, started)
    console.log(`Playbook agent: ${selection.classes.length} class(es) selected (${selection.builtin.length} built-in, ` +
      `${selection.added.length} additional); searched=${plan.searched}`)
  } catch (error) {
    writeMeta(provider, PLAYBOOK_STAGE, model, started, 1)
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error('[playbook-agent]', error.message)
  process.exitCode = 1
})
