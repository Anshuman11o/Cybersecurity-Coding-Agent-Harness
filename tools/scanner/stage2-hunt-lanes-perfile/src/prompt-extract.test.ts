/**
 * Tests for the prompt extraction: buildLanePrompts must produce, chunk for
 * chunk, exactly the prompt huntLane built inline before it was extracted, and
 * followUpTemplateBytes must be the byte length of the follow-up the loop
 * actually sends. Stage 1 sizes the plan and the reservation unit from these,
 * so a drift here is a plan priced against text the hunt never sends.
 *
 *   npx tsx --test src/prompt-extract.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLanePrompts, buildHuntPrompt, buildFollowUpTurn, followUpTemplateBytes, DEFAULT_LOOP_MODE,
  loadPlaybooksForClasses, lineNumberContent, sanitizePemPrivateKey,
  matchRoutesForFile, renderRouteContext, renderRegistrarRouteContext,
} from './hunt-executor.js'
import type { LaneAssignmentEntry } from './types.js'

const CONTENT = [
  "import { Request, Response } from 'express'",
  '',
  'export function getUser(req: Request, res: Response) {',
  '  const id = req.params.id',
  "  const user = db.query('SELECT * FROM users WHERE id = ' + id)",
  '  res.json(user)',
  '}',
  '',
  'export function deleteUser(req: Request, res: Response) {',
  '  const id = req.params.id',
  "  db.query('DELETE FROM users WHERE id = ' + id)",
  '  res.sendStatus(204)',
  '}',
].join('\n')

function lane(chunks: { index: number; start_line: number; end_line: number }[]): LaneAssignmentEntry {
  return {
    lane_id: 'file-0001', target_file: 'routes/user.ts', disposition: 'hunt', skip_reason: null,
    categories: [], category_basis: null, file_bytes: CONTENT.length, file_lines: 13, estimated_prompt_tokens: 0,
    chunk_plan: { required: chunks.length > 1, total_chunks: chunks.length, chunks },
  }
}

const ARCH = {
  route_table: {
    hand_written_routes: [
      { method: 'GET', path: '/api/user/:id', file: 'server.ts', line: 40, auth: 'none', handler: 'getUser()' },
      { method: 'DELETE', path: '/api/user/:id', file: 'routes/user.ts', line: 9, auth: 'jwt', handler: 'deleteUser()' },
    ],
    auto_crud_routes: [],
  },
}

/** The assembly huntLane did inline before the extraction, reproduced from its public parts. */
function inlineReference(
  l: LaneAssignmentEntry, classIds: string[], playbooks: Map<string, string>,
  snippet?: string, arch?: typeof ARCH,
): string[] {
  const sanitized = sanitizePemPrivateKey(CONTENT)
  let route = renderRouteContext(arch ? matchRoutesForFile(l.target_file, CONTENT, arch) : { handWritten: [], autoCrud: [] })
  const registrar = arch ? renderRegistrarRouteContext(l.target_file, arch.route_table) : undefined
  if (registrar) route = route ? `${registrar}\n\n${route}` : registrar
  return l.chunk_plan.chunks.map(c => buildHuntPrompt(
    l.target_file,
    lineNumberContent(sanitized.split('\n').slice(c.start_line - 1, c.end_line).join('\n'), c.start_line),
    classIds, playbooks, { chunkIndex: c.index, totalChunks: l.chunk_plan.total_chunks }, snippet, route,
  ).prompt)
}

test('buildLanePrompts equals the inline assembly, chunk for chunk', async () => {
  const classIds = ['access-control', 'injection']
  const playbooks = await loadPlaybooksForClasses(classIds)
  const multi = lane([{ index: 1, start_line: 1, end_line: 8 }, { index: 2, start_line: 7, end_line: 13 }])
  const snippet = 'Routes: 2 hand-written\nSubsystems: api'

  const built = buildLanePrompts(multi, CONTENT, classIds, playbooks, snippet, ARCH)
  assert.equal(built.length, 2)
  assert.deepEqual(built.map(b => b.chunk_index), [1, 2])
  assert.deepEqual(built.map(b => b.prompt), inlineReference(multi, classIds, playbooks, snippet, ARCH))
  // The route context actually reached the prompt, so the comparison covers it.
  assert.ok(built[0].prompt.includes('/api/user/:id'))
  assert.ok(built[1].prompt.includes('Chunk 2 of 2'))
  // Each breakdown reconciles with its own prompt.
  for (const b of built) assert.equal(b.breakdown.total_chars, b.prompt.length)

  // No architecture summary: no route context at all, still identical.
  const single = lane([{ index: 1, start_line: 1, end_line: 13 }])
  const plain = buildLanePrompts(single, CONTENT, classIds, playbooks)
  assert.deepEqual(plain.map(b => b.prompt), inlineReference(single, classIds, playbooks))
  assert.equal(plain[0].route_context_section, undefined)

  // Pure: the same inputs give the same text.
  assert.deepEqual(buildLanePrompts(multi, CONTENT, classIds, playbooks, snippet, ARCH), built)
  assert.deepEqual(buildLanePrompts(lane([]), CONTENT, classIds, playbooks), [])
})

test('followUpTemplateBytes is the builder\'s own empty-index follow-up, in bytes', () => {
  // The shipped arm loops; under it the template is the trace follow-up with nothing reported.
  if (DEFAULT_LOOP_MODE === 'none' || DEFAULT_LOOP_MODE === 'sweep' || process.env.HUNT_LOOP) return
  const expected = Buffer.byteLength(buildFollowUpTurn(DEFAULT_LOOP_MODE, [], []), 'utf8')
  assert.equal(followUpTemplateBytes(), expected)
  assert.ok(expected > 500)
  assert.ok(buildFollowUpTurn(DEFAULT_LOOP_MODE, [], []).includes('(nothing yet)'))
})
