/**
 * Spend gate: per-call holds against the run's cost cap.
 *
 * Before each model call — a file's first call, a follow-up turn or a retry —
 * the gate holds that call's own worst case (shared/pricing.ts
 * callReservationUsd: its actual prompt bound at the upper input rate plus the
 * output cap at the output rate, with the long-context, tier and region
 * multipliers). The hold is released the moment the call returns, in the same
 * synchronous step that books the call's real cost in the ledger. So, at every
 * point any other code can observe:
 *
 *   spent + sum(holds) <= cap
 *
 * and the cap cannot be passed even if every call costs its full worst case.
 *
 * Admission: a file starts when there is room for its first call's hold. That
 * hold is taken at admission (the file's "seed") and handed to the first call,
 * so an admitted file never stalls on its own first call. New files wait while
 * any in-flight call is queued for a hold: in-flight work goes first.
 *
 * Waiting: a call that cannot get its hold while anything else is held waits,
 * first come first served, for releases. It is refused for max_cost only when
 * nothing else is held — no release can come — and spent + hold > cap.
 *
 * Concurrency: files in flight are fitted to the remaining budget,
 * min(configured, max(1, floor(0.5 x (cap - spent) / maxCallHold))), so the
 * budget is not fragmented into holds that each leave too little for retries.
 * Stage 2 takes maxCallHold as the larger of the plan's first-call bound and
 * the largest hold any call has actually asked for (largestHoldUsd).
 *
 * No cap: every decision is "start" and every hold is granted at once, so an
 * uncapped run schedules exactly as it did before holds existed. An unpriced
 * hold under a cap is refused (max_cost): a cap cannot be enforced without one.
 */
export type GateDecision =
  | { action: 'start' }
  | { action: 'wait'; reason: 'max_cost' }
  | { action: 'stop'; reason: 'max_cost' | 'timeout'; detail: string }

export interface GateConfig {
  capUsd: number | null
  deadlineMs: number | null
  /** The run's ledger total, including recon and earlier passes. */
  ledgerTotal?: () => number
  now?: () => number
}

export interface GateSnapshot {
  spent_usd: number
  /** Files in flight. */
  in_flight: number
  /** Sum of every hold: calls in flight and admitted files' first-call seeds. */
  in_flight_projected_usd: number
  /** Calls holding budget now. */
  calls_in_flight: number
  /** Calls queued for a hold. */
  calls_waiting: number
  completed: number
  calibration: number
  cap_usd: number | null
  deadline_ms: number | null
}

/** One call's hold, returned by acquire() and passed back to release(). */
export interface CallHold {
  readonly id: number
  readonly laneId: string
  readonly usd: number
}

export type HoldResult =
  | { ok: true; hold: CallHold }
  | { ok: false; reason: 'max_cost'; detail: string }

/**
 * Files in flight the remaining budget supports:
 * min(configured, max(1, floor(0.5 x (cap - spent) / maxCallHold))).
 * The configured value when there is no cap or no priced hold.
 */
export function budgetConcurrency(
  configured: number,
  capUsd: number | null,
  spentUsd: number,
  maxCallHoldUsd: number | null,
): number {
  if (capUsd == null || maxCallHoldUsd == null || !(maxCallHoldUsd > 0)) return configured
  const fit = Math.floor((0.5 * (capUsd - spentUsd)) / maxCallHoldUsd)
  return Math.min(configured, Math.max(1, Number.isFinite(fit) ? fit : 1))
}

interface Waiter {
  laneId: string
  usd: number
  resolve: (r: HoldResult) => void
}

export class SpendGate {
  private readonly holds = new Map<number, CallHold>()
  /** First-call holds taken at admission, keyed by file. */
  private readonly seeds = new Map<string, number>()
  private readonly lanes = new Set<string>()
  private readonly waiters: Waiter[] = []
  private changeWaiters: (() => void)[] = []
  private nextId = 1
  private largest = 0
  private completed = 0
  private spent: number

  constructor(private readonly cfg: GateConfig, spentUsd = 0) {
    if (cfg.capUsd != null && !(cfg.capUsd > 0)) throw new Error(`spend cap must be positive, got ${cfg.capUsd}`)
    this.spent = spentUsd
  }

  /** Kept in the status format; holds are never calibrated. */
  calibration(): number { return 1 }

  get capped(): boolean { return this.cfg.capUsd != null }

  private reserved(): number {
    let sum = 0
    for (const h of this.holds.values()) sum += h.usd
    for (const s of this.seeds.values()) sum += s
    return sum
  }

  private fits(usd: number): boolean {
    return this.cfg.capUsd == null || this.spentUsd() + this.reserved() + usd <= this.cfg.capUsd
  }

  /** Anything held that a release could free. */
  private othersHeld(): boolean {
    return this.holds.size > 0 || this.seeds.size > 0
  }

  /** The largest hold any call has asked for so far (0 before the first). */
  largestHoldUsd(): number { return this.largest }

  /** Files in flight the remaining budget supports; see budgetConcurrency. */
  effectiveConcurrency(configured: number, maxCallHoldUsd: number | null): number {
    return budgetConcurrency(configured, this.cfg.capUsd, this.spentUsd(), maxCallHoldUsd)
  }

  /**
   * May a new file start? `firstCallHoldUsd` is the hold its first call needs —
   * the plan's bound on any file's first call, never a chunk total.
   */
  decide(firstCallHoldUsd: number | null): GateDecision {
    if (this.cfg.deadlineMs != null && (this.cfg.now ?? Date.now)() >= this.cfg.deadlineMs) {
      return { action: 'stop', reason: 'timeout', detail: 'the --timeout deadline passed' }
    }
    if (this.cfg.capUsd == null) return { action: 'start' }
    if (firstCallHoldUsd == null) {
      return { action: 'stop', reason: 'max_cost', detail: 'the call hold is unpriced, so a cost cap cannot be enforced' }
    }
    // Calls already in flight are served before any new file.
    if (this.waiters.length === 0 && this.fits(firstCallHoldUsd)) return { action: 'start' }
    if (this.lanes.size > 0 || this.othersHeld()) return { action: 'wait', reason: 'max_cost' }
    return {
      action: 'stop', reason: 'max_cost',
      detail: `next file's first call holds $${firstCallHoldUsd.toFixed(4)} and $${this.spentUsd().toFixed(4)} is spent of the $${this.cfg.capUsd.toFixed(2)} cap`,
    }
  }

  /** The file is in flight; its first call's hold is taken now and handed to that call. */
  begin(laneId: string, firstCallHoldUsd: number | null): void {
    this.lanes.add(laneId)
    if (this.cfg.capUsd != null) this.seeds.set(laneId, firstCallHoldUsd ?? 0)
  }

  /**
   * Hold `usd` for one call of `laneId`. Resolves at once when it fits; waits
   * for releases while anything else is held; refuses (max_cost) only when
   * nothing else is held and it still does not fit.
   */
  acquire(laneId: string, usd: number | null): Promise<HoldResult> {
    // The file's admission seed becomes this call's hold.
    const seeded = this.seeds.delete(laneId)
    if (usd != null) this.largest = Math.max(this.largest, usd)
    if (this.cfg.capUsd == null) return Promise.resolve({ ok: true, hold: this.grant(laneId, usd ?? 0) })
    if (usd == null) {
      if (seeded) this.pump()
      return Promise.resolve({ ok: false, reason: 'max_cost', detail: 'the call hold is unpriced, so a cost cap cannot be enforced' })
    }
    return new Promise<HoldResult>(resolve => {
      this.waiters.push({ laneId, usd, resolve })
      this.pump()
    })
  }

  private grant(laneId: string, usd: number): CallHold {
    const hold: CallHold = { id: this.nextId++, laneId, usd }
    this.holds.set(hold.id, hold)
    return hold
  }

  /** Serve queued calls in order; refuse the head only when nothing else can free budget. */
  private pump(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0]
      if (this.fits(head.usd)) {
        this.waiters.shift()
        head.resolve({ ok: true, hold: this.grant(head.laneId, head.usd) })
        continue
      }
      if (this.othersHeld()) break
      this.waiters.shift()
      head.resolve({
        ok: false, reason: 'max_cost',
        detail: `a call holding $${head.usd.toFixed(4)} would pass the $${this.cfg.capUsd!.toFixed(2)} cap ` +
          `with $${this.spentUsd().toFixed(4)} spent and nothing else in flight`,
      })
    }
    this.notifyChange()
  }

  /**
   * The call returned. `book` writes its real cost to the ledger in the same
   * synchronous step as the release, so no hold is granted on the strength of
   * budget the call has just spent. Without a ledger, the gate books
   * `actualUsd` itself (the hold when null).
   */
  release(hold: CallHold, actualUsd: number | null = null, book?: () => void): void {
    const held = this.holds.delete(hold.id)
    book?.()
    if (!held) return
    if (!this.cfg.ledgerTotal) this.spent += actualUsd ?? hold.usd
    this.pump()
  }

  /** The file finished; a seed it never used is released. Its calls are already booked. */
  finish(laneId: string): void {
    if (!this.lanes.has(laneId)) return
    this.lanes.delete(laneId)
    this.seeds.delete(laneId)
    for (const [id, h] of this.holds) if (h.laneId === laneId) this.holds.delete(id)
    this.completed++
    this.pump()
  }

  /** Resolves on the next release or finish — for a scheduler waiting on budget. */
  changed(): Promise<void> {
    return new Promise(resolve => { this.changeWaiters.push(resolve) })
  }

  private notifyChange(): void {
    const waiting = this.changeWaiters
    this.changeWaiters = []
    for (const w of waiting) w()
  }

  spentUsd(): number { return this.cfg.ledgerTotal ? this.cfg.ledgerTotal() : this.spent }

  snapshot(): GateSnapshot {
    return {
      spent_usd: this.spentUsd(), in_flight: this.lanes.size,
      in_flight_projected_usd: this.reserved(),
      calls_in_flight: this.holds.size, calls_waiting: this.waiters.length,
      completed: this.completed,
      calibration: 1, cap_usd: this.cfg.capUsd, deadline_ms: this.cfg.deadlineMs,
    }
  }
}
