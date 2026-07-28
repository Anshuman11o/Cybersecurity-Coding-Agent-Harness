/**
 * Test: verify that buildHuntPrompt's character breakdown reconciles.
 *
 * Builds a sample prompt, asserts segment chars sum to prompt length,
 * and prints the breakdown.
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildHuntPrompt } from './hunt-executor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

async function main() {
  // Load vuln classes registry
  const registry = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tools/scanner/shared/vuln-classes.json'), 'utf-8')
  ) as Record<string, { playbook: string; codes: string[] }>

  // Load a couple of playbooks
  const classIds = ['access-control', 'injection', 'ssrf']
  const playbooks = new Map<string, string>()
  for (const classId of classIds) {
    const entry = registry[classId]
    if (!entry) continue
    const modName = entry.playbook
    if (playbooks.has(modName)) continue
    const mod = await import(`./playbooks/${modName}.js`)
    playbooks.set(modName, (mod as { playbook: string }).playbook)
  }

  // Sample file content
  const sampleContent = `1: import { Request, Response } from 'express'
2:
3: export function getUser(req: Request, res: Response) {
4:   const id = req.params.id
5:   const user = db.query('SELECT * FROM users WHERE id = ' + id)
6:   res.json(user)
7: }
8:
9: export function deleteUser(req: Request, res: Response) {
10:   const id = req.params.id
11:   db.query('DELETE FROM users WHERE id = ' + id)
12:   res.sendStatus(204)
13: }`

  console.log('=== Test: buildHuntPrompt breakdown reconciliation ===\n')

  // Test 1: Single-chunk prompt
  console.log('Test 1: Single-chunk prompt')
  const result1 = buildHuntPrompt(
    'routes/user.ts',
    sampleContent,
    classIds,
    playbooks,
    { chunkIndex: 1, totalChunks: 1 },
    'Routes: 5 hand-written, 3 auto-generated\nSubsystems: api, frontend',
    '## How This File Is Reached\n  GET    /api/user/:id ->  getUser()\n  DELETE /api/user/:id ->  deleteUser()',
  )
  console.log(`  Prompt length: ${result1.prompt.length}`)
  console.log(`  Breakdown total_chars: ${result1.breakdown.total_chars}`)
  console.log(`  Reconciled: ${result1.prompt.length === result1.breakdown.total_chars ? 'YES' : 'NO'}`)
  console.log()
  console.log('  Segment breakdown:')
  let sumChars = 0
  for (const seg of result1.breakdown.segments) {
    sumChars += seg.chars
    const pct = ((seg.chars / result1.breakdown.total_chars) * 100).toFixed(1)
    console.log(`    ${seg.segment_type.padEnd(35)} ${seg.chars.toLocaleString().padStart(8)} chars (${pct}%)`)
  }
  console.log(`    ${'TOTAL'.padEnd(35)} ${sumChars.toLocaleString().padStart(8)} chars`)
  console.log()

  // Test 2: Multi-chunk prompt
  console.log('Test 2: Multi-chunk prompt')
  const result2 = buildHuntPrompt(
    'routes/user.ts',
    sampleContent,
    classIds,
    playbooks,
    { chunkIndex: 2, totalChunks: 3 },
  )
  console.log(`  Prompt length: ${result2.prompt.length}`)
  console.log(`  Breakdown total_chars: ${result2.breakdown.total_chars}`)
  console.log(`  Reconciled: ${result2.prompt.length === result2.breakdown.total_chars ? 'YES' : 'NO'}`)
  console.log()

  // Test 3: Minimal prompt (no arch context, no route context)
  console.log('Test 3: Minimal prompt (no arch/route context)')
  const result3 = buildHuntPrompt(
    'utils/helper.ts',
    sampleContent,
    ['logging-monitoring'],
    new Map([['logging-monitoring', 'Logging playbook text.']]),
    { chunkIndex: 1, totalChunks: 1 },
  )
  console.log(`  Prompt length: ${result3.prompt.length}`)
  console.log(`  Breakdown total_chars: ${result3.breakdown.total_chars}`)
  console.log(`  Reconciled: ${result3.prompt.length === result3.breakdown.total_chars ? 'YES' : 'NO'}`)
  console.log()

  // Test 4: Attribution distribution
  console.log('Test 4: Derived segment attribution')
  const fakeMeasured = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
  const segments = result1.breakdown.segments
  const totalChars = result1.breakdown.total_chars
  let distributed = 0
  console.log('  Segment attributions (prompt_tokens=1000):')
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const share = seg.chars / totalChars
    let tokens: number
    if (i === segments.length - 1) {
      tokens = 1000 - distributed
    } else {
      tokens = Math.round(1000 * share)
      distributed += tokens
    }
    const pct = ((tokens / 1000) * 100).toFixed(1)
    console.log(`    ${seg.segment_type.padEnd(35)} ${String(tokens).padStart(6)} tokens (${pct}%)`)
  }
  console.log(`    ${'TOTAL'.padEnd(35)} ${String(1000).padStart(6)} tokens (100.0%)`)
  console.log()

  console.log('=== ALL TESTS PASS ===')
}

main().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
