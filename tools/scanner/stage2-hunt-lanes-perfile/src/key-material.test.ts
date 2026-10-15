import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanePrompts, sanitizeLaneContent, sanitizePemPrivateKey } from './hunt-executor.js'
import type { LaneAssignmentEntry } from './types.js'

const fixtures: [string, string][] = [
  ['secret.key', 'synthetic-non-pem-secret'],
  ['certificate.crt', '\x00\x01synthetic-binary-key\x02\xff'],
  ['private.pem', '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-body\n-----END PRIVATE KEY-----\n'],
  ['broken.PEM', '-----BEGIN PRIVATE KEY-----\r\nsynthetic-truncated-key'],
  ['certificate.CRT', 'certificate-format-is-not-assumed-safe\nsecond-secret-line'],
]
for (const [file, raw] of fixtures) {
  test(`all content of ${file} is withheld before chunk prompts are assembled`, () => {
    const sanitized = sanitizeLaneContent(file, raw)
    assert.equal(sanitized.split('\n').length, raw.split('\n').length)
    assert.ok(sanitized.includes('KEY-MATERIAL SUMMARY'))
    for (const line of raw.split('\n').filter(l => l.length > 0)) assert.ok(!sanitized.includes(line))
    const count = raw.split('\n').length
    const lane: LaneAssignmentEntry = {
      lane_id: 'synthetic-key-lane', target_file: file, disposition: 'hunt', skip_reason: null,
      categories: [], category_basis: null, file_bytes: Buffer.byteLength(raw), file_lines: count,
      estimated_prompt_tokens: 0,
      chunk_plan: { required: count > 1, total_chunks: count,
        chunks: Array.from({ length: count }, (_, i) => ({ index: i + 1, start_line: i + 1, end_line: i + 1 })) },
    }
    const prompts = buildLanePrompts(lane, raw, [], new Map())
    assert.equal(prompts.length, count)
    for (const [i, part] of prompts.entries()) {
      assert.match(part.line_numbered, new RegExp(`^${i + 1}: `))
      assert.equal(part.breakdown.total_chars, part.prompt.length)
      for (const line of raw.split('\n').filter(l => l.length > 0)) assert.ok(!part.prompt.includes(line))
    }
  })
}

test('ordinary source keeps PEM redaction and downstream line positions', () => {
  const source = 'before\n-----BEGIN PRIVATE KEY-----\nsynthetic-pem-body\n-----END PRIVATE KEY-----\nafter'
  const sanitized = sanitizeLaneContent('source.py', source)
  assert.equal(sanitized, sanitizePemPrivateKey(source))
  assert.equal(sanitized.split('\n').length, source.split('\n').length)
  assert.equal(sanitized.split('\n')[4], 'after')
  assert.ok(!sanitized.includes('synthetic-pem-body'))
})
