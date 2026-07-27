// Stage 1 — Budget Governor
// Task A: Pre-run cost estimator (arithmetic, no model call)
// Task B: BudgetTracker enforcement class

import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runPath, type Provider } from "../../shared/run-paths.js";
import { resolveProvider } from "../../shared/provider.js";
import { writeMeta, assertUpstream } from "../../shared/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");
const PROVIDER: Provider = resolveProvider("stage1");
const STARTED = new Date().toISOString();

// ── Types ──────────────────────────────────────────────────────────────────

interface LaneManifestEntry {
  lane_id: string;
  categories: string[];
  subsystem_scope: string;
  seed_files: string[];
  playbook_reference: string;
}

export interface BudgetPlanEntry {
  lane_id: string;
  seed_file_count: number;
  seed_bytes_total: number;
  token_ceiling: number;
  wall_clock_ceiling_seconds: number;
  model_tier: "mid";
  escalation_flag: boolean;
  escalation_reason: string;
}

export interface ConsumptionReport {
  lane_id: string;
  tokens_used: number;
  seconds_elapsed: number;
  nearly_done?: boolean;       // optional: caller signals "almost finished"
  estimated_remaining?: number; // optional: caller's estimate of tokens still needed
}

export type StopReason =
  | { type: "none" }
  | { type: "lane_token_ceiling"; lane_id: string; framing: "bounded_ask" | "architectural_concern" }
  | { type: "lane_wall_clock_ceiling"; lane_id: string; framing: "bounded_ask" | "architectural_concern" }
  | { type: "global_cap"; framing: "bounded_ask" | "architectural_concern" };

export interface TrackerResult {
  ok: boolean;
  stop: StopReason;
  message: string;
  lane_totals: Record<string, { tokens: number; seconds: number }>;
  global_total_tokens: number;
}

// ── Task A: Pre-run cost estimator ─────────────────────────────────────────

/**
 * Multiplier rationale: A hunting lane does not read its seed files once.
 * It reads them to understand context, then re-reads while building
 * entrypoint→sink traces, then re-reads again while cross-referencing
 * across files, then once more while assembling evidence. Security-audit-skill's
 * benchmarked run showed each lane needs several reasoning passes over the same
 * code. 4× is a defensible midpoint: 1× initial read + ~3× re-reads for
 * trace-construction and cross-referencing. This is a planning-stage estimate;
 * the actual token consumption is governed at runtime by the BudgetTracker.
 */
const REASONING_PASS_MULTIPLIER = 4;

/**
 * Wall-clock derivation: ~150 tokens/sec is a conservative sustained throughput
 * for mid-tier model calls including queue time. We add a 30-second floor so a
 * lane with 2 tiny files still gets a non-trivial window (real overhead matters).
 */
const TOKENS_PER_SECOND = 150;
const WALL_CLOCK_FLOOR_SECONDS = 30;

function computeBudgetPlan(
  manifest: LaneManifestEntry[],
  repoRoot: string
): BudgetPlanEntry[] {
  // Collect per-lane byte counts
  const laneStats = manifest.map((lane) => {
    let seedBytesTotal = 0;
    let validCount = 0;
    for (const sf of lane.seed_files) {
      const fullPath = join(repoRoot, sf);
      if (existsSync(fullPath)) {
        seedBytesTotal += statSync(fullPath).size;
        validCount++;
      }
    }
    return { lane_id: lane.lane_id, seed_file_count: validCount, seed_bytes_total: seedBytesTotal };
  });

  // Compute distribution for escalation flag (top quartile by seed_bytes_total)
  const byteTotals = laneStats.map((s) => s.seed_bytes_total).sort((a, b) => a - b);
  const q75Index = Math.floor(byteTotals.length * 0.75);
  const q75Threshold = byteTotals[q75Index];

  const fileCounts = laneStats.map((s) => s.seed_file_count).sort((a, b) => a - b);
  const fileQ75Index = Math.floor(fileCounts.length * 0.75);
  const fileQ75Threshold = fileCounts[fileQ75Index];

  return laneStats.map((stat) => {
    const estimatedInputTokens = stat.seed_bytes_total / 4; // bytes → chars ≈ chars/4 ≈ tokens
    const token_ceiling = Math.round(estimatedInputTokens * REASONING_PASS_MULTIPLIER);
    const wall_clock_ceiling_seconds = Math.max(
      WALL_CLOCK_FLOOR_SECONDS,
      Math.round(token_ceiling / TOKENS_PER_SECOND)
    );

    const isLargeByBytes = stat.seed_bytes_total >= q75Threshold;
    const isLargeByFiles = stat.seed_file_count >= fileQ75Threshold;
    const escalation_flag = isLargeByBytes || isLargeByFiles;
    let escalation_reason = "";
    if (escalation_flag) {
      const reasons: string[] = [];
      if (isLargeByBytes) {
        reasons.push(`seed footprint in top quartile by bytes (${stat.seed_bytes_total.toLocaleString()} B, Q75=${q75Threshold.toLocaleString()} B)`);
      }
      if (isLargeByFiles) {
        reasons.push(`seed footprint in top quartile by file count (${stat.seed_file_count} files, Q75=${fileQ75Threshold} files)`);
      }
      escalation_reason = reasons.join("; ");
    }

    return {
      lane_id: stat.lane_id,
      seed_file_count: stat.seed_file_count,
      seed_bytes_total: stat.seed_bytes_total,
      token_ceiling,
      wall_clock_ceiling_seconds,
      model_tier: "mid" as const,
      escalation_flag,
      escalation_reason,
    };
  });
}

// ── Task B: BudgetTracker ──────────────────────────────────────────────────

export class BudgetTracker {
  private plan: Map<string, BudgetPlanEntry>;
  private globalCap: number | null;
  private laneTokens: Map<string, number>;
  private laneSeconds: Map<string, number>;
  private laneStopped: Map<string, boolean>;
  private runStopped: boolean;

  constructor(budgetPlan: BudgetPlanEntry[], globalCap?: number) {
    this.plan = new Map(budgetPlan.map((e) => [e.lane_id, e]));
    this.globalCap = globalCap ?? null;
    this.laneTokens = new Map(budgetPlan.map((e) => [e.lane_id, 0]));
    this.laneSeconds = new Map(budgetPlan.map((e) => [e.lane_id, 0]));
    this.laneStopped = new Map(budgetPlan.map((e) => [e.lane_id, false]));
    this.runStopped = false;
  }

  /**
   * Report incremental consumption for a lane. Returns a TrackerResult.
   * If a stop condition is hit, ok=false and the caller MUST stop the lane
   * (or the whole run, if global cap). The tracker never auto-approves more
   * budget — it always stops and reports.
   */
  reportConsumption(rpt: ConsumptionReport): TrackerResult {
    // If the whole run is already stopped, reject further reports
    if (this.runStopped) {
      return {
        ok: false,
        stop: { type: "global_cap", framing: "architectural_concern" },
        message: "Run already stopped due to global cap — no further consumption accepted.",
        lane_totals: this.snapshotLaneTotals(),
        global_total_tokens: this.globalTotalTokens(),
      };
    }

    // If this lane was already stopped, reject
    if (this.laneStopped.get(rpt.lane_id)) {
      const entry = this.plan.get(rpt.lane_id)!;
      return {
        ok: false,
        stop: { type: "lane_token_ceiling", lane_id: rpt.lane_id, framing: "architectural_concern" },
        message: `Lane "${rpt.lane_id}" already stopped — no further consumption accepted.`,
        lane_totals: this.snapshotLaneTotals(),
        global_total_tokens: this.globalTotalTokens(),
      };
    }

    // Update consumption
    this.laneTokens.set(rpt.lane_id, rpt.tokens_used);
    this.laneSeconds.set(rpt.lane_id, rpt.seconds_elapsed);

    const entry = this.plan.get(rpt.lane_id);
    if (!entry) {
      return {
        ok: true,
        stop: { type: "none" },
        message: `Lane "${rpt.lane_id}" not in budget plan — no ceiling to enforce.`,
        lane_totals: this.snapshotLaneTotals(),
        global_total_tokens: this.globalTotalTokens(),
      };
    }

    // Live report
    this.printLiveReport(rpt.lane_id, entry);

    // Check lane-level ceilings
    if (rpt.tokens_used >= entry.token_ceiling) {
      this.laneStopped.set(rpt.lane_id, true);
      const framing = this.determineFraming(rpt, entry, "token");
      return {
        ok: false,
        stop: { type: "lane_token_ceiling", lane_id: rpt.lane_id, framing },
        message: this.buildStopMessage(rpt, entry, "token", framing),
        lane_totals: this.snapshotLaneTotals(),
        global_total_tokens: this.globalTotalTokens(),
      };
    }

    if (rpt.seconds_elapsed >= entry.wall_clock_ceiling_seconds) {
      this.laneStopped.set(rpt.lane_id, true);
      const framing = this.determineFraming(rpt, entry, "wall_clock");
      return {
        ok: false,
        stop: { type: "lane_wall_clock_ceiling", lane_id: rpt.lane_id, framing },
        message: this.buildStopMessage(rpt, entry, "wall_clock", framing),
        lane_totals: this.snapshotLaneTotals(),
        global_total_tokens: this.globalTotalTokens(),
      };
    }

    // Check global cap
    if (this.globalCap !== null) {
      const totalTokens = this.globalTotalTokens();
      if (totalTokens >= this.globalCap) {
        this.runStopped = true;
        const framing = this.determineFraming(rpt, entry, "global");
        return {
          ok: false,
          stop: { type: "global_cap", framing },
          message: this.buildGlobalStopMessage(totalTokens, this.globalCap, framing),
          lane_totals: this.snapshotLaneTotals(),
          global_total_tokens: totalTokens,
        };
      }
    }

    return {
      ok: true,
      stop: { type: "none" },
      message: "Within budget.",
      lane_totals: this.snapshotLaneTotals(),
      global_total_tokens: this.globalTotalTokens(),
    };
  }

  isLaneStopped(laneId: string): boolean {
    return this.laneStopped.get(laneId) ?? false;
  }

  isRunStopped(): boolean {
    return this.runStopped;
  }

  private determineFraming(
    rpt: ConsumptionReport,
    entry: BudgetPlanEntry,
    ceilingType: "token" | "wall_clock" | "global"
  ): "bounded_ask" | "architectural_concern" {
    // "bounded_ask": caller signals nearly_done AND estimated remaining is small
    // relative to the ceiling (≤ 25% of ceiling).
    // Otherwise: "architectural_concern".
    if (rpt.nearly_done && rpt.estimated_remaining !== undefined) {
      const ceiling = ceilingType === "token"
        ? entry.token_ceiling
        : ceilingType === "wall_clock"
          ? entry.wall_clock_ceiling_seconds
          : 0;
      if (ceiling > 0 && rpt.estimated_remaining <= ceiling * 0.25) {
        return "bounded_ask";
      }
    }
    return "architectural_concern";
  }

  private buildStopMessage(
    rpt: ConsumptionReport,
    entry: BudgetPlanEntry,
    ceilingType: "token" | "wall_clock",
    framing: "bounded_ask" | "architectural_concern"
  ): string {
    const ceilingLabel = ceilingType === "token"
      ? `token ceiling of ${entry.token_ceiling.toLocaleString()}`
      : `wall-clock ceiling of ${entry.wall_clock_ceiling_seconds}s`;

    if (framing === "bounded_ask") {
      const remaining = rpt.estimated_remaining ?? 0;
      return `LANE STOP: "${rpt.lane_id}" hit ${ceilingLabel} (used: ${rpt.tokens_used.toLocaleString()} tokens, ${rpt.seconds_elapsed}s elapsed). ` +
        `Bounded ask: lane reports nearly done, needs ~${remaining.toLocaleString()} more tokens to complete.`;
    }

    return `LANE STOP: "${rpt.lane_id}" hit ${ceilingLabel} (used: ${rpt.tokens_used.toLocaleString()} tokens, ${rpt.seconds_elapsed}s elapsed). ` +
      `Architectural concern: lane is significantly over ceiling with no signal of being close to done.`;
  }

  private buildGlobalStopMessage(
    totalTokens: number,
    cap: number,
    framing: "bounded_ask" | "architectural_concern"
  ): string {
    if (framing === "bounded_ask") {
      return `RUN STOP: global token cap of ${cap.toLocaleString()} reached (${totalTokens.toLocaleString()} consumed). ` +
        `Bounded ask: one or more lanes need a small, bounded increase to finish.`;
    }
    return `RUN STOP: global token cap of ${cap.toLocaleString()} reached (${totalTokens.toLocaleString()} consumed). ` +
      `Architectural concern: aggregate spend significantly exceeds plan.`;
  }

  private printLiveReport(laneId: string, entry: BudgetPlanEntry): void {
    const tokensUsed = this.laneTokens.get(laneId) ?? 0;
    const secondsUsed = this.laneSeconds.get(laneId) ?? 0;
    const tokenPct = ((tokensUsed / entry.token_ceiling) * 100).toFixed(1);
    const wallPct = ((secondsUsed / entry.wall_clock_ceiling_seconds) * 100).toFixed(1);

    let line = `[BudgetTracker] Lane "${laneId}": tokens ${tokensUsed.toLocaleString()}/${entry.token_ceiling.toLocaleString()} (${tokenPct}%), ` +
      `wall ${secondsUsed}s/${entry.wall_clock_ceiling_seconds}s (${wallPct}%)`;

    if (this.globalCap !== null) {
      const totalTokens = this.globalTotalTokens();
      const globalPct = ((totalTokens / this.globalCap) * 100).toFixed(1);
      line += ` | GLOBAL: ${totalTokens.toLocaleString()}/${this.globalCap.toLocaleString()} (${globalPct}%)`;
    }

    console.log(line);
  }

  private snapshotLaneTotals(): Record<string, { tokens: number; seconds: number }> {
    const result: Record<string, { tokens: number; seconds: number }> = {};
    for (const [laneId] of this.plan) {
      result[laneId] = {
        tokens: this.laneTokens.get(laneId) ?? 0,
        seconds: this.laneSeconds.get(laneId) ?? 0,
      };
    }
    return result;
  }

  private globalTotalTokens(): number {
    let total = 0;
    for (const t of this.laneTokens.values()) total += t;
    return total;
  }
}

// ── CLI entry point: generate budget-plan.json ─────────────────────────────

async function main() {
  const manifestPath = join(runPath(PROVIDER, "stage05-lane-selector"), "lane-manifest.json");
  const manifest: LaneManifestEntry[] = JSON.parse(readFileSync(manifestPath, "utf-8"));

  console.log(`Computing budget plan for ${manifest.length} lanes…`);
  const plan = computeBudgetPlan(manifest, REPO_ROOT);

  const outDir = runPath(PROVIDER, "stage1-budget-governor");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "budget-plan.json");
  writeFileSync(outPath, JSON.stringify(plan, null, 2) + "\n");

  console.log(`\nBudget plan written to ${outPath}`);
  writeMeta(PROVIDER, "stage1-budget-governor", "deterministic", STARTED);
  console.log("─".repeat(90));
  console.log(
    "Lane".padEnd(30) +
    "Files".padStart(6) +
    "Bytes".padStart(12) +
    "Token Ceiling".padStart(14) +
    "Wall (s)".padStart(10) +
    "Esc?".padStart(6)
  );
  console.log("─".repeat(90));

  for (const e of plan) {
    console.log(
      e.lane_id.padEnd(30) +
      String(e.seed_file_count).padStart(6) +
      e.seed_bytes_total.toLocaleString().padStart(12) +
      e.token_ceiling.toLocaleString().padStart(14) +
      String(e.wall_clock_ceiling_seconds).padStart(10) +
      (e.escalation_flag ? " YES " : "  —  ").padStart(6)
    );
    if (e.escalation_reason) {
      console.log(`  ↳ ${e.escalation_reason}`);
    }
  }

  const totalBytes = plan.reduce((s, e) => s + e.seed_bytes_total, 0);
  const totalTokens = plan.reduce((s, e) => s + e.token_ceiling, 0);
  console.log("─".repeat(90));
  console.log(`Total seed bytes: ${totalBytes.toLocaleString()}`);
  console.log(`Total token ceiling (sum across lanes): ${totalTokens.toLocaleString()}`);
}

main().catch(console.error);
