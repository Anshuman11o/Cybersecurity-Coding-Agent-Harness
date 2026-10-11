/**
 * List and prune a product run store.
 *
 *   npm --prefix tools/scanner/report run runs -- --target DIR [--out DIR] list
 *   npm --prefix tools/scanner/report run runs -- --target DIR [--out DIR] prune [--keep N] [--work] [--yes]
 *
 * prune is a dry run unless --yes is given: it prints what it would remove and
 * how much space that frees. --keep N keeps the newest N runs; --work drops the
 * work/ directory (internals, checkpoints, logs) of every kept run except the
 * newest, which leaves their reports in place but means those runs can no
 * longer be resumed or re-reported. The newest run is never touched.
 *
 * Relative paths resolve against the directory the command was typed in
 * (npm's INIT_CWD), not this package.
 */
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { applyPrune, listRunIds, planPrune, refreshStore } from './runs-store.js'

function mb(b: number): string {
  return b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`
}

export function main(argv: string[], cwd = process.env.INIT_CWD ?? process.cwd()): number {
  const args = [...argv]
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    if (i < 0) return undefined
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    args.splice(i, 2)
    return v
  }
  const flag = (f: string) => {
    const i = args.indexOf(f)
    if (i >= 0) args.splice(i, 1)
    return i >= 0
  }

  const target = resolve(cwd, take('--target') ?? process.env.SCANNER_TARGET ?? '.')
  const out = take('--out') ?? process.env.SCANNER_OUT
  const store = out ? resolve(cwd, out) : join(target, '.secscan')
  const keepRaw = take('--keep')
  const work = flag('--work')
  const yes = flag('--yes')
  const cmd = args[0] ?? 'list'

  if (!existsSync(join(store, 'runs'))) {
    console.log(`No runs under ${store}.`)
    return 0
  }

  if (cmd === 'list') {
    const index = refreshStore(store, new Date().toISOString())
    console.log(`Run store: ${store}  (${index.runs.length} run(s); latest: ${index.latest ?? 'none'})\n`)
    console.log(`${'run'.padEnd(22)}${'status'.padEnd(12)}${'findings'.padStart(9)}${'cost'.padStart(9)}${'size'.padStart(10)}  report`)
    for (const r of index.runs) {
      console.log(
        r.run_id.padEnd(22) + r.status.padEnd(12) +
        String(r.findings ?? '-').padStart(9) +
        (r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : '-').padStart(9) +
        mb(r.size_bytes).padStart(10) + '  ' +
        (r.report ? join(store, r.report) : '(none)') + (r.has_work ? '' : '  [work pruned]'))
    }
    return 0
  }

  if (cmd === 'prune') {
    if (keepRaw === undefined && !work) {
      console.error('prune needs --keep N, --work, or both')
      return 2
    }
    const keep = keepRaw === undefined ? undefined : Number(keepRaw)
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
      console.error('--keep must be a whole number of at least 1')
      return 2
    }
    const plan = planPrune(store, { keep, work })
    const newest = listRunIds(store)[0]
    console.log(`Run store: ${store}  (newest run ${newest} is never touched)`)
    for (const id of plan.deleteRuns) console.log(`  delete run   runs/${id}/`)
    for (const id of plan.dropWork) console.log(`  drop work    runs/${id}/work/  (report kept; no resume or re-report after this)`)
    if (plan.deleteRuns.length + plan.dropWork.length === 0) {
      console.log('  nothing to remove')
      return 0
    }
    if (!yes) {
      console.log(`\nDry run: would free ${mb(plan.bytes)}. Re-run with --yes to remove.`)
      return 0
    }
    applyPrune(store, plan)
    refreshStore(store, new Date().toISOString())
    console.log(`\nRemoved. Freed ${mb(plan.bytes)}.`)
    return 0
  }

  console.error(`unknown command '${cmd}' (list | prune)`)
  return 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    console.error((err as Error).message)
    process.exit(2)
  }
}
