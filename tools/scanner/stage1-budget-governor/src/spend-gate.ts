/**
 * Spend gate — the enforcing half of the budget governor (productization plan §2.6).
 *
 * Stage 1 prices every lane before the run; Stage 2 asks this gate before it
 * STARTS each one. The gate never interrupts a lane in flight: a lane's calls are
 * billed as they happen, so killing it mid-way pays for work and throws it away.
 * The guarantee is therefore the one the plan states — no new lane starts once
 * projected spend would exceed the cap — and the overshoot is bounded by the
 * lanes already in flight, not by the size of the repository.
 *
 * A lane may start when
 *
 *     spent + Σ projected(in flight) × k + projected(lane) × k  ≤  cap
 *
 * where `k` is the calibration factor: the ratio of measured to projected cost
 * over the lanes completed so far, never below 1. A projection that runs low on
 * this repository is corrected after the first few lanes instead of being
 * trusted for the whole run; one that runs high is left alone, because erring
 * high only stops a run early, which is the safe direction for a hard cap.
 *
 * When the next lane does not fit but others are still in flight, the answer is
 * `wait`, not `stop`: their measured cost may come in under projection and make
 * room. Only when nothing is in flight and it still does not fit does the run
 * stop. Lanes are never reordered to squeeze a small one in after a large one
 * failed to fit — the unscanned list stays a plain suffix of the plan, which is
 * what the confirmation screen promised.
 *
 * Zero dependencies, no I/O: Stage 2 owns the clock and the scheduling, this
 * owns only the decision, so the decision is unit-testable.
 */

export type GateDecision =
  | { action: 'start' }
  | { action: 'wait'; reason: 'max_cost' }
  | { action: 'stop'; reason: 'max_cost' | 'timeout'; detail: string }

export interface GateConfig {
  /** USD. Null means no cost cap. */
  capUsd: number | null
  /** Epoch ms after which no lane starts. Null means no deadline. */
  deadlineMs: number | null
  /** Completed lanes needed before the calibration factor moves off 1. */
  calibrationMinLanes?: number
  now?: () => number
}

export interface GateSnapshot {
  spent_usd: number
  in_flight: number
  in_flight_projected_usd: number
  completed: number
  calibration: number
  cap_usd: number | null
  deadline_ms: number | null
}

export class SpendGate {
  private readonly cap: number | null
  private readonly deadline: number | null
  private readonly minLanes: number
  private readonly now: () => number
  private spent: number
  private readonly inFlight = new Map<string, number>()
  private completed = 0
  private calibratedActual = 0
  private calibratedProjected = 0

  /**
   * @param spentUsd spend already on the books — on a resume, what the
   *                 checkpointed lanes cost, so the cap covers the whole run
   */
  constructor(cfg: GateConfig, spentUsd = 0) {
    if (cfg.capUsd != null && !(cfg.capUsd > 0)) throw new Error(`spend cap must be positive, got ${cfg.capUsd}`)
    this.cap = cfg.capUsd
    this.deadline = cfg.deadlineMs
    this.minLanes = cfg.calibrationMinLanes ?? 3
    this.now = cfg.now ?? Date.now
    this.spent = spentUsd
  }

  /** Measured-over-projected cost so far, floored at 1. */
  calibration(): number {
    if (this.completed < this.minLanes || this.calibratedProjected <= 0) return 1
    return Math.max(1, this.calibratedActual / this.calibratedProjected)
  }

  private inFlightProjected(): number {
    let s = 0
    for (const v of this.inFlight.values()) s += v
    return s
  }

  /**
   * May a lane projected at `projectedUsd` start now?
   * `projectedUsd` null means the target is unpriced; with a cap set that is a
   * configuration error, and the gate refuses rather than guessing.
   */
  decide(projectedUsd: number | null): GateDecision {
    if (this.deadline != null && this.now() >= this.deadline) {
      return { action: 'stop', reason: 'timeout', detail: 'the --timeout deadline passed' }
    }
    if (this.cap == null) return { action: 'start' }
    if (projectedUsd == null) {
      return { action: 'stop', reason: 'max_cost', detail: 'the model is unpriced, so a cost cap cannot be enforced' }
    }
    const k = this.calibration()
    const committed = this.spent + this.inFlightProjected() * k
    if (committed + projectedUsd * k <= this.cap) return { action: 'start' }
    if (this.inFlight.size > 0) return { action: 'wait', reason: 'max_cost' }
    return {
      action: 'stop',
      reason: 'max_cost',
      detail:
        `next lane projects $${(projectedUsd * k).toFixed(4)} and $${this.spent.toFixed(4)} is spent ` +
        `of the $${this.cap.toFixed(2)} cap` + (k > 1 ? ` (projection scaled ×${k.toFixed(2)} by measured spend)` : ''),
    }
  }

  /** A lane started; its projection is held against the cap until it finishes. */
  begin(laneId: string, projectedUsd: number | null): void {
    this.inFlight.set(laneId, projectedUsd ?? 0)
  }

  /**
   * A lane finished, successfully or not. `actualUsd` is its measured cost, or
   * null when the provider returned no usage — then its projection is booked
   * instead, so an unmeasured lane is never free.
   */
  finish(laneId: string, actualUsd: number | null): void {
    const projected = this.inFlight.get(laneId) ?? 0
    this.inFlight.delete(laneId)
    const cost = actualUsd ?? projected
    this.spent += cost
    if (actualUsd != null && projected > 0) {
      this.completed++
      this.calibratedActual += actualUsd
      this.calibratedProjected += projected
    }
  }

  spentUsd(): number {
    return this.spent
  }

  snapshot(): GateSnapshot {
    return {
      spent_usd: this.spent,
      in_flight: this.inFlight.size,
      in_flight_projected_usd: this.inFlightProjected(),
      completed: this.completed,
      calibration: this.calibration(),
      cap_usd: this.cap,
      deadline_ms: this.deadline,
    }
  }
}
