/** Guidance provenance for the run record, including runs that stop before hunting. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlaybookRecord } from '../../shared/playbook-cache.js'

export function readRunPlaybooks(huntDir: string, agentDir: string, previous: PlaybookRecord[] = []): PlaybookRecord[] {
  const read = (file: string) => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }
  return read(join(huntDir, 'playbooks-used.json'))
    ?? read(join(agentDir, 'playbook-plan.json'))?.playbooks
    ?? previous
}
