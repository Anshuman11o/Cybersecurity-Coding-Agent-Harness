/**
 * Analysis script: evaluates per-lane route context across all hunt lanes.
 *
 * Usage:  npx tsx src/analyze-route-context.ts
 *
 * Outputs:
 * - Rendered "## How This File Is Reached" for three specific lanes
 * - Route-match distribution stats across all 553 hunt lanes
 * - Prompt-size delta for lanes that match routes
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  extractExportedSymbols,
  matchRoutesForFile,
  renderRouteContext,
} from './hunt-executor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

// ── Paths ─────────────────────────────────────────────────────────────────

const LANE_ASSIGNMENTS_PATH = join(REPO_ROOT, 'tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json')
const ARCH_SUMMARY_PATH = join(REPO_ROOT, 'tools/scanner/stage0-recon/output/architecture-summary.json')

// ── Specific lanes to render ──────────────────────────────────────────────

const TARGET_LANES = [
  'routes/premiumReward.ts',
  'routes/basketItems.ts',
  'models/user.ts',
]

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Load lane assignments
  if (!existsSync(LANE_ASSIGNMENTS_PATH)) {
    console.error(`Lane assignments not found at ${LANE_ASSIGNMENTS_PATH}`)
    console.error('Has Stage 0.5 (per-file) run yet?')
    process.exit(1)
  }

  const assignments = JSON.parse(readFileSync(LANE_ASSIGNMENTS_PATH, 'utf-8'))
  const targetDir = assignments.target_dir
  console.log(`Loaded ${assignments.lanes.length} lanes from ${LANE_ASSIGNMENTS_PATH}`)
  console.log(`Target directory: ${targetDir}`)

  // Load architecture summary
  if (!existsSync(ARCH_SUMMARY_PATH)) {
    console.error(`Architecture summary not found at ${ARCH_SUMMARY_PATH}`)
    process.exit(1)
  }

  const archSummary = JSON.parse(readFileSync(ARCH_SUMMARY_PATH, 'utf-8'))
  const archContext = { route_table: archSummary.route_table }
  console.log(`Route table: ${archSummary.route_table.hand_written_routes.length} hand-written, ${archSummary.route_table.auto_crud_routes.length} auto-CRUD`)
  console.log()

  // ── Render specific lanes ──────────────────────────────────────────────

  console.log('=== Rendered "## How This File Is Reached" sections ===\n')

  for (const targetFile of TARGET_LANES) {
    const targetPath = join(targetDir, targetFile)
    if (!existsSync(targetPath)) {
      console.log(`--- ${targetFile} ---\n  [FILE NOT FOUND at ${targetPath}]\n`)
      continue
    }

    const content = readFileSync(targetPath, 'utf-8')
    const symbols = extractExportedSymbols(content)
    const routeCtx = matchRoutesForFile(targetFile, content, archContext)
    const rendered = renderRouteContext(routeCtx)

    console.log(`--- Lane: ${targetFile} (${symbols.size} exported symbols) ---`)
    if (rendered) {
      console.log(rendered)
    } else {
      console.log('  [No matching routes]')
    }
    console.log()
  }

  // ── Route-match distribution across all hunt lanes ─────────────────────

  const huntLanes = assignments.lanes.filter((l: any) => l.disposition === 'hunt')
  console.log(`Analyzing ${huntLanes.length} hunt lanes...\n`)

  const matchCounts: number[] = []
  const baselinePrompts: number[] = []
  const routeContextPrompts: number[] = []

  for (const lane of huntLanes) {
    const targetPath = join(targetDir, lane.target_file)
    if (!existsSync(targetPath)) {
      matchCounts.push(0)
      continue
    }

    const content = readFileSync(targetPath, 'utf-8')
    const routeCtx = matchRoutesForFile(lane.target_file, content, archContext)
    const hwCount = routeCtx.handWritten.length
    const acCount = routeCtx.autoCrud.length
    const totalMatched = hwCount + acCount
    matchCounts.push(totalMatched)

    // Measure prompt size impact
    const rendered = renderRouteContext(routeCtx)
    const baselineLen = content.length
    const withRouteLen = rendered ? content.length + rendered.length : content.length
    baselinePrompts.push(baselineLen)
    routeContextPrompts.push(withRouteLen)
  }

  // Distribution buckets
  const zero = matchCounts.filter(n => n === 0).length
  const one = matchCounts.filter(n => n === 1).length
  const twoToFive = matchCounts.filter(n => n >= 2 && n <= 5).length
  const sixToFifteen = matchCounts.filter(n => n >= 6 && n <= 15).length
  const moreThanFifteen = matchCounts.filter(n => n > 15).length
  const atLeastOne = matchCounts.filter(n => n > 0).length

  console.log('=== Route-match distribution ===')
  console.log(`Lanes matching ≥1 route: ${atLeastOne} / ${huntLanes.length} (${(atLeastOne / huntLanes.length * 100).toFixed(1)}%)`)
  console.log()
  console.log(`  0 routes:      ${zero} lanes`)
  console.log(`  1 route:       ${one} lanes`)
  console.log(`  2-5 routes:    ${twoToFive} lanes`)
  console.log(`  6-15 routes:   ${sixToFifteen} lanes`)
  console.log(`  >15 routes:    ${moreThanFifteen} lanes`)
  console.log()

  // Prompt size delta for lanes that match routes
  const lanesWithRoutes = matchCounts.map((n, i) => ({ n, base: baselinePrompts[i], withRc: routeContextPrompts[i] })).filter(x => x.n > 0)
  if (lanesWithRoutes.length > 0) {
    const deltas = lanesWithRoutes.map(x => x.withRc - x.base)
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length
    const minDelta = Math.min(...deltas)
    const maxDelta = Math.max(...deltas)
    const avgPct = deltas.reduce((s, d) => s + (d / lanesWithRoutes.find(x => true)!.base) * 100, 0) / deltas.length

    console.log('=== Prompt size impact (lanes with matched routes) ===')
    console.log(`Affected lanes: ${lanesWithRoutes.length}`)
    console.log(`Average added chars: ${avgDelta.toFixed(0)} (min ${minDelta}, max ${maxDelta})`)

    // Estimate token impact (~4 chars per token for English/TS)
    const avgTokens = avgDelta / 4
    console.log(`Average added tokens (est, ~4 chars/token): ~${avgTokens.toFixed(0)}`)
  }
}

main().catch(err => {
  console.error('Analysis failed:', err)
  process.exit(1)
})
