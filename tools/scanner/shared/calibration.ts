/**
 * Calibration — the estimate's two learned ratios, measured on this reports
 * folder's own earlier runs.
 *
 *   <reportsRoot>/calibration.json
 *
 *   R                output tokens per input token
 *   chars per token  prompt characters sent per prompt token billed
 *
 * The estimate prefers, in order: this run's recon (chars per token only),
 * this file, the registry's `calibration` seed, then a fixed fallback. Ratios
 * are token-weighted across runs — a 300-file run counts for more than a
 * 3-file one — and only runs of the same model and reasoning effort are mixed,
 * because effort moves R by a multiple.
 *
 * The file keeps the last MAX_RUNS runs across all models, so it stays small
 * and an old configuration ages out.
 *
 * Zero dependencies (node builtins only).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export const CALIBRATION_FILE = 'calibration.json'
export const CALIBRATION_SCHEMA = 'secscan.calibration/1'
/** Runs kept in the file. */
export const MAX_RUNS = 20

export interface CalibrationRun {
  run_id: string
  at: string
  model: string
  effort: string
  files: number
  calls: number
  input_tokens: number
  output_tokens: number
  chars_sent: number
  /** Prompt tokens over the calls that also recorded chars_sent. */
  prompt_tokens_for_chars: number
  ratio_R: number | null
  chars_per_token: number | null
}

interface CalibrationFile {
  schema: typeof CALIBRATION_SCHEMA
  runs: CalibrationRun[]
}

/** Every recorded run, oldest first; empty when the file is missing or unreadable. */
export function readCalibration(reportsRoot: string): CalibrationRun[] {
  const path = join(reportsRoot, CALIBRATION_FILE)
  if (!existsSync(path)) return []
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as CalibrationFile
    return f && f.schema === CALIBRATION_SCHEMA && Array.isArray(f.runs) ? f.runs : []
  } catch {
    return []
  }
}

/**
 * Record a finished run. A run already recorded under the same id (a resumed
 * run finishing again) is replaced, not counted twice. Keeps the last MAX_RUNS.
 */
export function recordCalibration(reportsRoot: string, run: CalibrationRun): void {
  const runs = readCalibration(reportsRoot).filter(r => r.run_id !== run.run_id)
  runs.push(run)
  const file: CalibrationFile = { schema: CALIBRATION_SCHEMA, runs: runs.slice(-MAX_RUNS) }
  mkdirSync(reportsRoot, { recursive: true })
  const path = join(reportsRoot, CALIBRATION_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n')
  renameSync(tmp, path)
}

/** Token-weighted R and chars per token over this model's runs at this effort; null where none measured. */
export function calibratedRatios(
  reportsRoot: string,
  model: string,
  effort: string,
): { ratio_R: number | null; chars_per_token: number | null; runs: number } {
  const runs = readCalibration(reportsRoot).filter(r => r.model === model && r.effort === effort)
  const sum = (f: (r: CalibrationRun) => number) =>
    runs.reduce((s, r) => s + (Number.isFinite(f(r)) && f(r) > 0 ? f(r) : 0), 0)
  const input = sum(r => r.input_tokens)
  const output = sum(r => r.output_tokens)
  const chars = sum(r => (r.prompt_tokens_for_chars > 0 ? r.chars_sent : 0))
  const promptForChars = sum(r => (r.chars_sent > 0 ? r.prompt_tokens_for_chars : 0))
  return {
    ratio_R: input > 0 && output > 0 ? output / input : null,
    chars_per_token: promptForChars > 0 && chars > 0 ? chars / promptForChars : null,
    runs: runs.length,
  }
}
