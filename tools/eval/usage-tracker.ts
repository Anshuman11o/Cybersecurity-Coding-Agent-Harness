/**
 * Usage Tracker — Predicted vs Actual token consumption for v2 per-file lanes.
 *
 * This module defines the contract between the cost model (Part A) and the
 * Stage 2 hunt-lanes-perfile executor. It provides:
 *   1. LaneUsageRecord — the per-lane data shape (predicted + actual fields)
 *   2. emitLaneUsage() — called by Stage 2 after each lane completes
 *   3. aggregateUsage() — reads all records and produces a predicted-vs-actual report
 *
 * USAGE BY STAGE 2:
 *   import { emitLaneUsage, LaneUsageRecord } from '../../eval/usage-tracker.js'
 *
 *   // After each lane finishes:
 *   emitLaneUsage(outputDir, {
 *     laneId: 'file-0042',
 *     targetFile: 'routes/login.ts',
 *     sizeBucket: '8-24 KB',
 *     categories: ['A03: Injection (SQL)'],
 *     categoryBasis: 'route_table',
 *     predictedInputTokens: 4500,
 *     predictedOutputTokens: 3800,
 *     predictedTotalTokens: 8300,
 *     actualInputTokens: 4820,     // from LLM API usage.total_tokens - output
 *     actualOutputTokens: 3650,    // from LLM API
 *     actualTotalTokens: 8470,
 *     wallClockSeconds: 12.4,
 *     chunkCount: 1,
 *     findingCount: 2,
 *     ceilingHit: false,
 *     completedAt: new Date().toISOString(),
 *   })
 *
 * CONSTRAINTS:
 *   - No enforcement. This is pure measurement.
 *   - Do not modify tools/scanner/stage1-budget-governor/
 *   - Do not create files under tools/scanner/stage2-hunt-lanes-perfile/
 *   - target-apps/ is read-only
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Contract: Per-lane usage record ─────────────────────────────────────────

export interface LaneUsageRecord {
  /** Unique lane identifier (e.g. "file-0042") */
  laneId: string

  /** Target file path, relative to the scanned target directory */
  targetFile: string

  /** Size bucket label (e.g. "under 2 KB", "8-24 KB") */
  sizeBucket: string

  /** Categories assigned to this lane (by code, e.g. ["A03", "API1"]) */
  categories: string[]

  /** Why these categories were assigned (see PERFILE_LANE_CONTRACT.md) */
  categoryBasis:
    | 'route_table'
    | 'persistence'
    | 'client_render'
    | 'llm_surface'
    | 'model_definition'
    | 'universe_default'

  // ── Predicted (from cost model, Part A) ──
  predictedInputTokens: number
  predictedOutputTokens: number
  predictedTotalTokens: number

  // ── Actual (measured at runtime) ──
  actualInputTokens: number | null   // null if lane failed before LLM call
  actualOutputTokens: number | null
  actualTotalTokens: number | null
  wallClockSeconds: number | null    // null if not yet completed

  // ── Context ──
  chunkCount: number
  findingCount: number
  ceilingHit: boolean

  /** ISO-8601 timestamp when the lane completed */
  completedAt: string | null
}

// ── Emitter: called by Stage 2 after each lane ──────────────────────────────

/**
 * Write a single lane usage record to the output directory.
 * Each lane gets its own JSON file for append-friendly parallel writes.
 *
 * @param outputDir  The v2 stage2 output directory (e.g. tools/scanner/stage2-hunt-lanes-perfile/output/)
 * @param record     The populated usage record for this lane
 */
export function emitLaneUsage(outputDir: string, record: LaneUsageRecord): void {
  const usageDir = join(outputDir, 'usage')
  if (!existsSync(usageDir)) {
    mkdirSync(usageDir, { recursive: true })
  }

  // Sanitize laneId for filename
  const safeId = record.laneId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filePath = join(usageDir, `${safeId}.json`)

  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8')
}

/**
 * Emit a batch of lane usage records at once.
 * Useful for sequential executors that accumulate records before writing.
 */
export function emitLaneUsageBatch(outputDir: string, records: LaneUsageRecord[]): void {
  for (const r of records) {
    emitLaneUsage(outputDir, r)
  }
}

// ── Aggregator: reads all records and compares predicted vs actual ───────────

export interface LaneUsageAggregate {
  generatedAt: string
  totalLanes: number
  completedLanes: number
  skippedLanes: number   // lanes with disposition="skip"
  failedLanes: number    // lanes that started but errored (actualTotalTokens === null)

  // Per-scenario predicted totals
  predictedNarrowTotal: number
  predictedBroadTotal: number

  // Actual totals
  actualInputTotal: number
  actualOutputTotal: number
  actualTotalTokens: number
  totalWallClockSeconds: number

  // Accuracy metrics
  inputAccuracy: number | null    // actual / predicted (1.0 = perfect)
  outputAccuracy: number | null
  totalAccuracy: number | null
  overBudgetLanes: number         // lanes where actual > predicted
  underBudgetLanes: number

  // Per-bucket breakdown
  bucketBreakdown: BucketAggregate[]

  // Individual lane records (for detailed inspection)
  lanes: LaneUsageRecord[]
}

export interface BucketAggregate {
  bucket: string
  laneCount: number
  predictedTotal: number
  actualTotal: number
  accuracy: number | null
  avgWallClockSeconds: number | null
}

/**
 * Read all lane usage records from the output directory and produce
 * a predicted-vs-actual comparison report.
 *
 * @param outputDir  The v2 stage2 output directory containing the usage/ subdirectory
 */
export function aggregateUsage(outputDir: string): LaneUsageAggregate {
  const usageDir = join(outputDir, 'usage')

  if (!existsSync(usageDir)) {
    return {
      generatedAt: new Date().toISOString(),
      totalLanes: 0,
      completedLanes: 0,
      skippedLanes: 0,
      failedLanes: 0,
      predictedNarrowTotal: 0,
      predictedBroadTotal: 0,
      actualInputTotal: 0,
      actualOutputTotal: 0,
      actualTotalTokens: 0,
      totalWallClockSeconds: 0,
      inputAccuracy: null,
      outputAccuracy: null,
      totalAccuracy: null,
      overBudgetLanes: 0,
      underBudgetLanes: 0,
      bucketBreakdown: [],
      lanes: [],
    }
  }

  const files = readdirSync(usageDir).filter(f => f.endsWith('.json'))
  const lanes: LaneUsageRecord[] = []

  for (const f of files) {
    const content = readFileSync(join(usageDir, f), 'utf-8')
    lanes.push(JSON.parse(content) as LaneUsageRecord)
  }

  lanes.sort((a, b) => a.laneId.localeCompare(b.laneId))

  const completed = lanes.filter(l => l.completedAt !== null)
  const skipped = lanes.filter(l => l.sizeBucket === 'skip')
  const failed = completed.filter(l => l.actualTotalTokens === null)
  const successful = completed.filter(l => l.actualTotalTokens !== null)

  // Totals
  const actualInputTotal = successful.reduce((s, l) => s + (l.actualInputTokens ?? 0), 0)
  const actualOutputTotal = successful.reduce((s, l) => s + (l.actualOutputTokens ?? 0), 0)
  const actualTotalTokens = successful.reduce((s, l) => s + (l.actualTotalTokens ?? 0), 0)
  const totalWallClockSeconds = successful.reduce((s, l) => s + (l.wallClockSeconds ?? 0), 0)

  // Predicted totals
  const predictedNarrowTotal = lanes.reduce((s, l) => s + l.predictedTotalTokens, 0)
  // Broad prediction = narrow - narrow playbook + broad playbook
  // Simplified: use a ratio estimate (21 categories / 1.5 avg = 14x playbook cost)
  const narrowPlaybook = lanes.reduce((s, l) => s + l.predictedOutputTokens * 0.15, 0) // rough estimate
  const predictedBroadTotal = predictedNarrowTotal + narrowPlaybook * 13

  // Accuracy
  const predictedInputTotal = successful.reduce((s, l) => s + l.predictedInputTokens, 0)
  const predictedOutputTotal = successful.reduce((s, l) => s + l.predictedOutputTokens, 0)
  const predictedTotalForCompleted = successful.reduce((s, l) => s + l.predictedTotalTokens, 0)

  const inputAccuracy = predictedInputTotal > 0 ? actualInputTotal / predictedInputTotal : null
  const outputAccuracy = predictedOutputTotal > 0 ? actualOutputTotal / predictedOutputTotal : null
  const totalAccuracy = predictedTotalForCompleted > 0 ? actualTotalTokens / predictedTotalForCompleted : null

  // Over/under budget
  const overBudgetLanes = successful.filter(l =>
    (l.actualTotalTokens ?? 0) > l.predictedTotalTokens
  ).length
  const underBudgetLanes = successful.filter(l =>
    (l.actualTotalTokens ?? 0) <= l.predictedTotalTokens
  ).length

  // Per-bucket breakdown
  const bucketMap = new Map<string, LaneUsageRecord[]>()
  for (const l of successful) {
    const bucket = l.sizeBucket
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, [])
    bucketMap.get(bucket)!.push(l)
  }

  const bucketBreakdown: BucketAggregate[] = []
  for (const [bucket, bucketLanes] of bucketMap.entries()) {
    const bPredicted = bucketLanes.reduce((s, l) => s + l.predictedTotalTokens, 0)
    const bActual = bucketLanes.reduce((s, l) => s + (l.actualTotalTokens ?? 0), 0)
    const bAccuracy = bPredicted > 0 ? bActual / bPredicted : null
    const bWallClock = bucketLanes.reduce((s, l) => s + (l.wallClockSeconds ?? 0), 0)
    const bAvgWallClock = bucketLanes.length > 0 ? bWallClock / bucketLanes.length : null

    bucketBreakdown.push({
      bucket,
      laneCount: bucketLanes.length,
      predictedTotal: bPredicted,
      actualTotal: bActual,
      accuracy: bAccuracy,
      avgWallClockSeconds: bAvgWallClock,
    })
  }

  bucketBreakdown.sort((a, b) => a.bucket.localeCompare(b.bucket))

  return {
    generatedAt: new Date().toISOString(),
    totalLanes: lanes.length,
    completedLanes: completed.length,
    skippedLanes: skipped.length,
    failedLanes: failed.length,
    predictedNarrowTotal: predictedNarrowTotal,
    predictedBroadTotal: predictedBroadTotal,
    actualInputTotal,
    actualOutputTotal,
    actualTotalTokens,
    totalWallClockSeconds,
    inputAccuracy,
    outputAccuracy,
    totalAccuracy,
    overBudgetLanes,
    underBudgetLanes,
    bucketBreakdown,
    lanes,
  }
}

// ── Report formatter ────────────────────────────────────────────────────────

export function formatUsageReport(agg: LaneUsageAggregate): string {
  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('USAGE TRACKER — Predicted vs Actual Token Consumption')
  lines.push('='.repeat(80))
  lines.push('')
  lines.push(`Generated: ${agg.generatedAt}`)
  lines.push(`Total lanes:       ${agg.totalLanes}`)
  lines.push(`Completed:         ${agg.completedLanes}`)
  lines.push(`Skipped:           ${agg.skippedLanes}`)
  lines.push(`Failed:            ${agg.failedLanes}`)
  lines.push('')
  lines.push('PREDICTED vs ACTUAL')
  lines.push('-'.repeat(80))
  lines.push(`  Predicted (NARROW): ${agg.predictedNarrowTotal.toLocaleString()} tokens`)
  lines.push(`  Predicted (BROAD):  ${agg.predictedBroadTotal.toLocaleString()} tokens`)
  lines.push('')
  lines.push(`  Actual input:       ${agg.actualInputTotal.toLocaleString()} tokens`)
  lines.push(`  Actual output:      ${agg.actualOutputTotal.toLocaleString()} tokens`)
  lines.push(`  Actual total:       ${agg.actualTotalTokens.toLocaleString()} tokens`)
  lines.push(`  Wall clock:         ${agg.totalWallClockSeconds.toFixed(1)}s`)
  lines.push('')

  if (agg.totalAccuracy !== null) {
    lines.push(`  Accuracy (total):   ${(agg.totalAccuracy * 100).toFixed(1)}% of predicted`)
    lines.push(`  Accuracy (input):   ${agg.inputAccuracy !== null ? (agg.inputAccuracy * 100).toFixed(1) + '%' : 'N/A'} of predicted`)
    lines.push(`  Accuracy (output):  ${agg.outputAccuracy !== null ? (agg.outputAccuracy * 100).toFixed(1) + '%' : 'N/A'} of predicted`)
    lines.push('')
    lines.push(`  Over budget lanes:  ${agg.overBudgetLanes}`)
    lines.push(`  Under budget lanes: ${agg.underBudgetLanes}`)
  } else {
    lines.push('  No completed lanes yet — accuracy cannot be computed.')
  }

  lines.push('')
  lines.push('PER-BUCKET BREAKDOWN')
  lines.push('-'.repeat(80))
  lines.push(
    `${'Bucket':<20} ${'Lanes':>5} ${'Predicted':>12} ${'Actual':>12} ${'Accuracy':>10} ${'Avg Wall(s)':>12}`
  )
  lines.push('-'.repeat(80))

  for (const b of agg.bucketBreakdown) {
    const acc = b.accuracy !== null ? `${(b.accuracy * 100).toFixed(1)}%` : 'N/A'
    const wall = b.avgWallClockSeconds !== null ? b.avgWallClockSeconds.toFixed(1) : 'N/A'
    lines.push(
      `${b.bucket:<20} ${b.laneCount:>5} ${b.predictedTotal:>12,} ${b.actualTotal:>12,} ${acc:>10} ${wall:>12}`
    )
  }

  lines.push('')
  lines.push('='.repeat(80))
  return lines.join('\n')
}

// ── CLI entry point (for re-aggregation after a run) ────────────────────────

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Usage: node usage-tracker.js <output-dir>')
    console.log('')
    console.log('Aggregates lane usage records from <output-dir>/usage/')
    console.log('and prints a predicted-vs-actual comparison report.')
    process.exit(0)
  }

  const outputDir = args[0]
  const agg = aggregateUsage(outputDir)
  console.log(formatUsageReport(agg))

  // Also write JSON
  const jsonPath = join(outputDir, 'usage-aggregate.json')
  const dir = dirname(jsonPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(agg, null, 2), 'utf-8')
  console.log(`\nAggregate written to ${jsonPath}`)
}

// Only run main when executed directly (not imported)
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1])
if (isMain) {
  main().catch(err => {
    console.error('Error:', err)
    process.exit(1)
  })
}
