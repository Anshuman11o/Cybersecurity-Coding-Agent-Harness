/**
 * Spend gate: hold each file's chunks × the run's fixed reservation unit U
 * until the file finishes. Calls are already booked in the live ledger.
 * Wait for in-flight files to release reservations before refusing a new file;
 * a retry that cannot reserve one more U ends its file immediately.
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
  in_flight: number
  in_flight_projected_usd: number
  completed: number
  calibration: number
  cap_usd: number | null
  deadline_ms: number | null
}

export class SpendGate {
  private readonly inFlight = new Map<string, number>()
  private completed = 0
  private spent: number

  constructor(private readonly cfg: GateConfig, spentUsd = 0) {
    if (cfg.capUsd != null && !(cfg.capUsd > 0)) throw new Error(`spend cap must be positive, got ${cfg.capUsd}`)
    this.spent = spentUsd
  }

  /** Kept in the status format; U is fixed and never calibrated. */
  calibration(): number { return 1 }

  private reserved(): number {
    return [...this.inFlight.values()].reduce((sum, value) => sum + value, 0)
  }

  /** reservationUsd is chunks × U, never a per-file estimate. */
  decide(reservationUsd: number | null): GateDecision {
    if (this.cfg.deadlineMs != null && (this.cfg.now ?? Date.now)() >= this.cfg.deadlineMs) {
      return { action: 'stop', reason: 'timeout', detail: 'the --timeout deadline passed' }
    }
    if (this.cfg.capUsd == null) return { action: 'start' }
    if (reservationUsd == null) {
      return { action: 'stop', reason: 'max_cost', detail: 'the reservation is unpriced, so a cost cap cannot be enforced' }
    }
    if (this.spentUsd() + this.reserved() + reservationUsd <= this.cfg.capUsd) return { action: 'start' }
    if (this.inFlight.size > 0) return { action: 'wait', reason: 'max_cost' }
    return {
      action: 'stop', reason: 'max_cost',
      detail: `next file reserves $${reservationUsd.toFixed(4)} and $${this.spentUsd().toFixed(4)} is spent of the $${this.cfg.capUsd.toFixed(2)} cap`,
    }
  }

  begin(laneId: string, reservationUsd: number | null): void {
    this.inFlight.set(laneId, reservationUsd ?? 0)
  }

  /** No waiting here: refused retries end the file and stop the run. */
  reserveRetry(laneId: string, unitUsd: number | null): boolean {
    if (this.cfg.capUsd != null && (unitUsd == null ||
        this.spentUsd() + this.reserved() + unitUsd > this.cfg.capUsd)) return false
    this.inFlight.set(laneId, (this.inFlight.get(laneId) ?? 0) + (unitUsd ?? 0))
    return true
  }

  /** With a ledger, finishing only releases the reservation; never book twice. */
  finish(laneId: string, actualUsd: number | null = null): void {
    if (!this.inFlight.has(laneId)) return
    const held = this.inFlight.get(laneId)!
    this.inFlight.delete(laneId)
    if (!this.cfg.ledgerTotal) this.spent += actualUsd ?? held
    this.completed++
  }

  spentUsd(): number { return this.cfg.ledgerTotal ? this.cfg.ledgerTotal() : this.spent }

  snapshot(): GateSnapshot {
    return {
      spent_usd: this.spentUsd(), in_flight: this.inFlight.size,
      in_flight_projected_usd: this.reserved(), completed: this.completed,
      calibration: 1, cap_usd: this.cfg.capUsd, deadline_ms: this.cfg.deadlineMs,
    }
  }
}
