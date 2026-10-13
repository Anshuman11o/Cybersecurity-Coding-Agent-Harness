/** Human class review. All IO and effects are injected so CI sessions are testable. */
import { InputCancelled, type InputIO } from './inputs.js'
import { renderSummary, type ConfirmationSummary } from './confirm.js'
import { parseCost } from '../../stage1-budget-governor/src/limits.js'
import { usd } from './display.js'

export interface ReviewEditResult { ok: boolean; changed: boolean; message: string }
export interface ReviewCall { purpose: string; reservation_usd: number; class?: { id: string; codes: string[]; signals: string[] } }
export interface RoundTwoOptions {
  io: InputIO
  yes: boolean
  frozen: boolean
  requested?: { drop?: string[]; add?: string[] }
  summary(): ConfirmationSummary
  edit(action: 'add' | 'drop', input: string, confirm: (call: ReviewCall) => Promise<boolean>, rawInput?: string): Promise<ReviewEditResult>
  replan(): Promise<void>
  budget(value: number): Promise<void>
  editLimits(): Promise<void>
  save(): Promise<void>
}
export type RoundTwoResult = 'start' | 'quit' | 'failed'

export const ROUND_TWO_PROMPT = '[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit'

export async function roundTwo(opts: RoundTwoOptions): Promise<RoundTwoResult> {
  const { io } = opts
  const confirm = async (call: ReviewCall): Promise<boolean> => {
    if (opts.yes) return true
    if (call.class) io.write(`Agent: ${call.class.id} (${call.class.codes.join(', ')}), routed by signals: ${call.class.signals.join(', ')}`)
    io.write(`${call.purpose}: reserves up to ${usd(call.reservation_usd)} against the budget.`)
    return (await io.read('[Enter] go  [c] cancel: ')).trim() === ''
  }
  const apply = async (action: 'add' | 'drop', input: string, rawInput = input): Promise<boolean> => {
    const before = opts.summary().skip.by_reason['no selected class'] ?? 0
    const result = await opts.edit(action, input, confirm, rawInput)
    io.write(result.message)
    if (result.changed) {
      io.write('Re-planning … (no model calls)')
      await opts.replan()
      const skipped = (opts.summary().skip.by_reason['no selected class'] ?? 0) - before
      if (skipped > 0) io.write(`${skipped} files no longer have a class and will be skipped.`)
    }
    return result.ok
  }
  try {
    const requests = opts.requested
    if (opts.frozen && ((requests?.drop?.length ?? 0) + (requests?.add?.length ?? 0) > 0)) {
      io.write('Classes are frozen after the hunt starts; resume allows budget edits only.')
      return 'failed'
    }
    for (const action of ['drop', 'add'] as const) {
      for (const input of requests?.[action] ?? []) {
        const ok = await apply(action, input)
        // A requested class must never silently disappear in a CI run.
        if (!ok && opts.yes) return 'failed'
      }
    }
    for (;;) {
      const summary = opts.summary()
      io.write(renderSummary(summary))
      const gate = summary.budget_message
      if (opts.yes) {
        if (gate && !gate.can_start) return 'failed'
        if (gate?.requires_confirmation) io.write('Starting the low-budget scan (--yes).')
        return 'start'
      }
      io.write(opts.frozen ? '[Enter] start  [b] budget  [q] quit (classes and limits frozen after hunt started)' : ROUND_TWO_PROMPT)
      const answer = (await io.read('> ')).trim().toLowerCase()
      if (answer === 'q' || answer === 'quit') return 'quit'
      if (answer === '') {
        if (gate && !gate.can_start) { io.write(gate.text); continue }
        if (gate?.requires_confirmation) {
          const ok = (await io.read('Start with this low budget? [y/N] ')).trim().toLowerCase()
          if (ok !== 'y' && ok !== 'yes') continue
        }
        return 'start'
      }
      if (answer === 'b' || answer === 'budget') {
        for (;;) {
          const raw = (await io.read('New total budget in USD (Enter keeps it): ')).trim()
          if (!raw) break
          let budget: number
          try {
            budget = parseCost(raw, 'budget')
            const spent = opts.summary().estimate.breakdown?.spent_usd ?? 0
            if (budget <= spent) throw new Error(`New budget must exceed ${usd(spent)} already spent.`)
          } catch (e: any) { io.write(e.message); continue }
          await opts.budget(budget)
          break
        }
        continue
      }
      if (opts.frozen) { io.write('Resume allows budget edits only after the hunt starts.'); continue }
      if (answer === 's' || answer === 'save') { await opts.save(); continue }
      if (answer === 'e' || answer === 'edit') { await opts.editLimits(); continue }
      if (answer === 'a' || answer === 'add' || answer === 'd' || answer === 'delete') {
        const action = answer === 'a' || answer === 'add' ? 'add' : 'drop'
        let raw = (await io.read(action === 'add' ? 'Add a class (name, number or code): ' : 'Delete a class (row number or id): ')).trim()
        if (!raw) continue
        const rawInput = raw
        // Delete uses the displayed row number; add uses the stable catalog number.
        if (action === 'drop' && /^\d+$/.test(raw)) raw = opts.summary().classes?.[Number(raw) - 1]?.id ?? raw
        await apply(action, raw, rawInput)
        continue
      }
      io.write(`Unrecognised answer "${answer}".`)
    }
  } catch (e) {
    if (e instanceof InputCancelled) return 'quit'
    throw e
  }
}
