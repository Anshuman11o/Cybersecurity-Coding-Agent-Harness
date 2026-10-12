/**
 * Spend ledger — one append-only JSONL file per run per model, one line per
 * model call, and the run's spend is the sum of its lines.
 *
 *   <runsRoot>/<provider>/spend-ledger.jsonl
 *
 * Recon and the hunt both append here, and a resume appends to the same file,
 * so the budget gate sees everything already spent — recon and earlier passes
 * included — rather than a per-stage figure that forgets the rest. A call that
 * returned no usage is booked at a reservation (basis 'reservation') so spend
 * is never under-counted by a response that did not say what it cost.
 *
 * Every attempt is a line, a failed one included: an attempt the endpoint
 * billed is spend whether or not it produced an answer.
 *
 * Crash safety: each append is a single appendFileSync of one complete line.
 * A crash can still leave a partial last line; it is ignored on read, and the
 * constructor terminates it so the next append starts on a line of its own
 * rather than fusing with it.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { assertProvider, type Provider } from './models.js'
import type { NormalizedUsage } from './pricing.js'

export const LEDGER_FILE = 'spend-ledger.jsonl'
export const LEDGER_SCHEMA = 'secscan.ledger/1'

export interface LedgerEntry {
  schema: typeof LEDGER_SCHEMA
  /** ISO time the entry was booked. */
  at: string
  source: 'recon' | 'hunt' | 'playbook'
  /** Stage key that made the call, e.g. 'stage0-recon'. */
  stage: string
  /** What the call was for, e.g. 'auth-mechanisms' or 'chunk 1 pass 1'. */
  label: string
  /** The hunt lane, or null for a recon call. */
  lane_id: string | null
  /** 1-based attempt number of this call. */
  attempt: number
  model: string
  served_tier: string | null
  usage: NormalizedUsage | null
  /** Characters of prompt text sent, for the chars-per-token calibration. */
  chars_sent: number
  /** Actual cost, or the reservation booked in its place. Null only for an unpriced model. */
  cost_usd: number | null
  basis: 'actual' | 'reservation'
  note?: string
}

export interface LedgerTotals {
  total_usd: number
  by_source: Record<string, number>
  /** Entries booked, failed attempts included. */
  calls: number
  /** Entries booked at a reservation because the response carried no usage. */
  reserved_calls: number
  prompt_tokens: number
  completion_tokens: number
  chars_sent: number
  /** Prompt tokens over the entries that carry both chars_sent and prompt_tokens. */
  prompt_tokens_with_chars: number
  /** chars_sent over those same entries — the numerator matching prompt_tokens_with_chars. */
  chars_with_prompt_tokens: number
}

/** Where a run's ledger lives for one model. */
export function ledgerPathFor(runsRoot: string, provider: Provider): string {
  return join(runsRoot, assertProvider(provider), LEDGER_FILE)
}

function emptyTotals(): LedgerTotals {
  return {
    total_usd: 0, by_source: {}, calls: 0, reserved_calls: 0, prompt_tokens: 0,
    completion_tokens: 0, chars_sent: 0, prompt_tokens_with_chars: 0, chars_with_prompt_tokens: 0,
  }
}

function addEntry(t: LedgerTotals, e: LedgerEntry): void {
  const cost = typeof e.cost_usd === 'number' && Number.isFinite(e.cost_usd) ? e.cost_usd : 0
  t.total_usd += cost
  t.by_source[e.source] = (t.by_source[e.source] ?? 0) + cost
  t.calls++
  if (e.basis === 'reservation') t.reserved_calls++
  const prompt = e.usage?.prompt_tokens ?? null
  t.prompt_tokens += prompt ?? 0
  t.completion_tokens += e.usage?.completion_tokens ?? 0
  const chars = e.chars_sent > 0 ? e.chars_sent : 0
  t.chars_sent += chars
  if (chars > 0 && prompt != null && prompt > 0) {
    t.prompt_tokens_with_chars += prompt
    t.chars_with_prompt_tokens += chars
  }
}

/** Parse a ledger's text. Lines that are not a complete entry are skipped. */
function parseLedger(text: string): { entries: LedgerEntry[]; skipped: number } {
  const entries: LedgerEntry[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && e.schema === LEDGER_SCHEMA) entries.push(e as LedgerEntry)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { entries, skipped }
}

/** Totals of a ledger on disk. A missing file is zeros; a partial last line is ignored. */
export function readLedgerTotals(path: string): LedgerTotals {
  const t = emptyTotals()
  if (!existsSync(path)) return t
  for (const e of parseLedger(readFileSync(path, 'utf8')).entries) addEntry(t, e)
  return t
}

export class SpendLedger {
  readonly path: string
  private entries: LedgerEntry[] = []
  /** Lines on disk that were not a complete entry when the ledger was loaded. */
  readonly skippedLines: number = 0

  /** Loads any entries already on disk, so a resumed run continues the same total. */
  constructor(path: string) {
    this.path = path
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      const parsed = parseLedger(text)
      this.entries = parsed.entries
      this.skippedLines = parsed.skipped
      // A crash mid-append leaves a line without its newline. End it, so the
      // next entry is a line of its own instead of fusing with the fragment.
      if (text.length > 0 && !text.endsWith('\n')) appendFileSync(path, '\n')
    }
  }

  /** Book one call. One appendFileSync of one line. */
  append(entry: Omit<LedgerEntry, 'schema' | 'at'>): LedgerEntry {
    const full: LedgerEntry = { schema: LEDGER_SCHEMA, at: new Date().toISOString(), ...entry }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(full) + '\n')
    this.entries.push(full)
    return full
  }

  total(): number {
    return this.totals().total_usd
  }

  totals(): LedgerTotals {
    const t = emptyTotals()
    for (const e of this.entries) addEntry(t, e)
    return t
  }

  /** Every entry booked so far, oldest first. */
  list(): readonly LedgerEntry[] {
    return this.entries
  }

  /** Empty the ledger. The benchmark profile's recon starts each run fresh; a product run never calls this. */
  reset(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, '')
    this.entries = []
  }
}
