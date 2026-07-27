// Stage 1 — Budget Governor
// Task A: Pre-run cost estimator (arithmetic, no model call)
// Task B: BudgetTracker enforcement class

import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");

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

// ── v2 Types ───────────────────────────────────────────────────────────────

/** Per-lane v2 budget plan entry. */
export interface BudgetPlanEntryV2 {
  lane_id: string;
  target_file: string;
  file_bytes: number;
  file_lines: number;
  chunk_count: number;
  assigned_classes: string[];
  // Estimated prompt tokens from boilerplate + playbooks (per chunk)
  estimated_boilerplate_tokens: number;
  estimated_playbook_tokens: number;
  estimated_file_content_tokens: number;
  // Projected total input tokens for this lane (sum across chunks)
  projected_input_tokens: number;
}

/** Run-level v2 budget plan. */
export interface BudgetPlanV2 {
  generated_at: string;
  target_dir: string;
  lanes: BudgetPlanEntryV2[];
  total_projected_input_tokens: number;
  total_file_bytes: number;
  total_chunks: number;
  lane_count: number;
  model: string;
}

/** Reconciliation result for one lane. */
export interface LaneReconciliation {
  lane_id: string;
  target_file: string;
  projected_input_tokens: number;
  actual_input_tokens: number | null;
  actual_total_tokens: number | null;
  divergence: number | null;         // actual - projected (null when actual missing)
  divergence_pct: number | null;     // (actual - projected) / projected
}

/** Full v2 reconciliation output. */
export interface ReconciliationV2 {
  generated_at: string;
  plan_source: string;
  consumption_source: string;
  lanes: LaneReconciliation[];
  overall: {
    total_projected_input: number;
    total_actual_input: number | null;
    total_actual_total: number | null;
    overall_divergence: number | null;
    overall_divergence_pct: number | null;
  };
  largest_divergences: Array<{
    lane_id: string;
    target_file: string;
    divergence: number;
    divergence_pct: number;
    projected: number;
    actual: number | null;
  }>;
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
  const manifestPath = join(REPO_ROOT, "tools/scanner/stage05-lane-selector/output/lane-manifest.json");
  const manifest: LaneManifestEntry[] = JSON.parse(readFileSync(manifestPath, "utf-8"));

  console.log(`Computing budget plan for ${manifest.length} lanes…`);
  const plan = computeBudgetPlan(manifest, REPO_ROOT);

  const outDir = join(__dirname, "..", "output");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "budget-plan.json");
  writeFileSync(outPath, JSON.stringify(plan, null, 2) + "\n");

  console.log(`\nBudget plan written to ${outPath}`);
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

// ── v2: Pre-run estimation ────────────────────────────────────────────────

/**
 * Load playbook text sizes from the per-file stage2 directory.
 * Returns a map of playbook module name → character count.
 */
function loadPlaybookCharSizes(): Map<string, number> {
  const playbooksDir = join(REPO_ROOT, 'tools/scanner/stage2-hunt-lanes-perfile/src/playbooks')
  const sizes = new Map<string, number>()
  const entries = readdirSync(playbooksDir).filter((f: string) => f.endsWith('.ts'))
  for (const entry of entries) {
    const content = readFileSync(join(playbooksDir, entry), 'utf-8')
    const modName = entry.replace(/\.ts$/, '')
    sizes.set(modName, content.length)
  }
  return sizes
}

/**
 * Estimate input token cost for one chunk of a v2 lane.
 * Uses character count ÷ 4 as the token approximation (standard for
 * English/code text).
 */
function estimateChunkInputTokens(
  boilerplateChars: number,
  playbookChars: number,
  fileContentChars: number,
  routeContextChars: number,
  archContextChars: number,
): number {
  const totalChars = boilerplateChars + playbookChars + fileContentChars + routeContextChars + archContextChars
  return Math.round(totalChars / 4)
}

/**
 * Compute the v2 budget plan: projected input-token cost per lane,
 * built from actual lane assignments, playbook sizes, and chunk counts.
 */
function computeBudgetPlanV2(): BudgetPlanV2 {
  // Load v2 lane assignments
  const assignmentsPath = join(REPO_ROOT, 'tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json')
  if (!existsSync(assignmentsPath)) {
    throw new Error(`v2 lane assignments not found at ${assignmentsPath}`)
  }
  const assignments = JSON.parse(readFileSync(assignmentsPath, 'utf-8'))
  const targetDir = assignments.target_dir
  const huntLanes = assignments.lanes.filter((l: any) => l.disposition === 'hunt')

  // Load playbook sizes from stage2 source
  const playbookSizes = loadPlaybookCharSizes()

  // Load vuln class registry to map class ids → playbook modules
  const vulnClassesPath = join(REPO_ROOT, 'tools/scanner/shared/vuln-classes.json')
  const vulnClasses = JSON.parse(readFileSync(vulnClassesPath, 'utf-8')) as Record<string, { playbook: string; codes: string[] }>

  // Boilerplate char budget (constant across all chunks, same as stage2)
  // This is the base boilerplate without the chunk-specific line and class list
  const BASE_BOILERPLATE = `You are a security analyst hunting for vulnerabilities in a single source file.

## Target File
File: placeholder
`
  const MULTI_CHUNK_HEADER = `Chunk X of Y. Analyze ALL lines shown below — do not skip any.
`
  const CLASSES_SECTION = `
## Assigned Classes
You are hunting ONLY for these vulnerability classes in this file: placeholder.
Do NOT look for vulnerability classes outside this list.

## Playbook Guidance — How to detect each assigned class
Below is the technical guidance for the vulnerability classes you are hunting. This guidance explains what these vulnerability classes look like in general — what shapes of code create them, what to trace, what distinguishes a real instance from a false positive. It does NOT describe this particular codebase.
`

  const baseBoilerplateChars = BASE_BOILERPLATE.length
  const multiChunkHeaderChars = MULTI_CHUNK_HEADER.length
  const classesSectionChars = CLASSES_SECTION.length

  const lanes: BudgetPlanEntryV2[] = []

  for (const lane of huntLanes) {
    const laneClasses: string[] = lane.classes && lane.classes.length > 0
      ? lane.classes
      : lane.categories.map((c: any) => {
          // Map category code to class id via reverse lookup
          for (const [classId, entry] of Object.entries(vulnClasses)) {
            if (entry.codes.includes(c.code)) return classId
          }
          return null
        }).filter(Boolean)

    // Compute playbook chars for this lane's classes
    let playbookChars = 0
    const seenPlaybooks = new Set<string>()
    for (const classId of laneClasses) {
      const entry = vulnClasses[classId]
      if (!entry) continue
      if (seenPlaybooks.has(entry.playbook)) continue
      seenPlaybooks.add(entry.playbook)
      playbookChars += playbookSizes.get(entry.playbook) ?? 0
    }

    // Boilerplate: base + classes section (+ multi-chunk header if applicable)
    const isMultiChunk = lane.chunk_plan.total_chunks > 1
    const boilerplateChars = baseBoilerplateChars +
      CLASSES_SECTION.length +
      (isMultiChunk ? multiChunkHeaderChars : 0)

    // File content chars = file bytes (approximate: 1 byte ≈ 1 char for source code)
    const fileContentChars = lane.file_bytes

    // Route context and arch context: estimate from typical sizes
    // Route context ~500 chars when present (most lanes won't have it)
    // Arch context ~200 chars when present
    const routeContextChars = 0  // Per-lane, not predictable at planning time
    const archContextChars = 200 // Same for all lanes when present

    // Per-chunk estimate
    const chunkInputTokens = estimateChunkInputTokens(
      boilerplateChars,
      playbookChars,
      fileContentChars,
      routeContextChars,
      archContextChars,
    )

    // Lane total = per-chunk × chunk count
    const chunkCount = lane.chunk_plan.chunks.length
    const projectedInputTokens = chunkInputTokens * chunkCount

    lanes.push({
      lane_id: lane.lane_id,
      target_file: lane.target_file,
      file_bytes: lane.file_bytes,
      file_lines: lane.file_lines,
      chunk_count: chunkCount,
      assigned_classes: laneClasses,
      estimated_boilerplate_tokens: Math.round(boilerplateChars / 4),
      estimated_playbook_tokens: Math.round(playbookChars / 4),
      estimated_file_content_tokens: Math.round(fileContentChars / 4),
      projected_input_tokens: projectedInputTokens,
    })
  }

  const totalProjected = lanes.reduce((s, l) => s + l.projected_input_tokens, 0)
  const totalFileBytes = lanes.reduce((s, l) => s + l.file_bytes, 0)
  const totalChunks = lanes.reduce((s, l) => s + l.chunk_count, 0)

  return {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    lanes,
    total_projected_input_tokens: totalProjected,
    total_file_bytes: totalFileBytes,
    total_chunks: totalChunks,
    lane_count: lanes.length,
    model: 'qwen-plus',
  }
}

// ── v2: Reconciliation ────────────────────────────────────────────────────

function reconcileV2(
  plan: BudgetPlanV2,
  consumptionPath: string,
): ReconciliationV2 {
  // Read consumption file — could be v1 (legacy array) or v2 (full structure)
  const consumptionRaw = JSON.parse(readFileSync(consumptionPath, 'utf-8'))

  // Build lane map from consumption
  const actualByLane = new Map<string, { input: number | null; total: number | null }>()

  if (Array.isArray(consumptionRaw)) {
    // v1 legacy format: array of { lane_id, tokens_used, ... }
    // tokens_used is total_tokens, not split — mark input as null
    for (const entry of consumptionRaw) {
      actualByLane.set(entry.lane_id, {
        input: null,
        total: entry.tokens_used,
      })
    }
  } else if (consumptionRaw.lanes && Array.isArray(consumptionRaw.lanes)) {
    // v2 format
    for (const lane of consumptionRaw.lanes) {
      actualByLane.set(lane.lane_id, {
        input: lane.lane_totals?.prompt_tokens ?? null,
        total: lane.lane_totals?.total_tokens ?? null,
      })
    }
  }

  // Build per-lane reconciliation
  const laneResults: LaneReconciliation[] = []
  let totalProjected = 0
  let totalActualInput = 0
  let totalActualTotal = 0
  let inputMeasured = 0

  for (const planLane of plan.lanes) {
    const actual = actualByLane.get(planLane.lane_id)
    const actualInput = actual?.input ?? null
    const actualTotal = actual?.total ?? null
    const divergence = actualInput != null ? actualInput - planLane.projected_input_tokens : null
    const divergencePct = actualInput != null && planLane.projected_input_tokens > 0
      ? (actualInput - planLane.projected_input_tokens) / planLane.projected_input_tokens
      : null

    totalProjected += planLane.projected_input_tokens
    if (actualInput != null) {
      totalActualInput += actualInput
      inputMeasured++
    }
    if (actualTotal != null) totalActualTotal += actualTotal

    laneResults.push({
      lane_id: planLane.lane_id,
      target_file: planLane.target_file,
      projected_input_tokens: planLane.projected_input_tokens,
      actual_input_tokens: actualInput,
      actual_total_tokens: actualTotal,
      divergence,
      divergence_pct: divergencePct,
    })
  }

  // Top divergences (absolute)
  const ranked = laneResults
    .filter(r => r.divergence != null)
    .sort((a, b) => Math.abs(b.divergence!) - Math.abs(a.divergence!))
    .slice(0, 10)
    .map(r => ({
      lane_id: r.lane_id,
      target_file: r.target_file,
      divergence: r.divergence!,
      divergence_pct: r.divergence_pct!,
      projected: r.projected_input_tokens,
      actual: r.actual_input_tokens,
    }))

  return {
    generated_at: new Date().toISOString(),
    plan_source: 'budget-plan-v2.json',
    consumption_source: consumptionPath,
    lanes: laneResults,
    overall: {
      total_projected_input: totalProjected,
      total_actual_input: inputMeasured > 0 ? totalActualInput : null,
      total_actual_total: totalActualTotal,
      overall_divergence: inputMeasured > 0 ? totalActualInput - totalProjected : null,
      overall_divergence_pct: inputMeasured > 0 && totalProjected > 0
        ? (totalActualInput - totalProjected) / totalProjected
        : null,
    },
    largest_divergences: ranked,
  }
}

// ── v2 CLI entry point ────────────────────────────────────────────────────

async function mainV2(mode: 'estimate' | 'reconcile') {
  const outDir = join(__dirname, '..', 'output')
  mkdirSync(outDir, { recursive: true })

  if (mode === 'estimate') {
    console.log('=== Stage 1 v2: Pre-run budget estimate ===\n')

    const plan = computeBudgetPlanV2()
    const outPath = join(outDir, 'budget-plan-v2.json')
    writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n')

    console.log(`Plan written to ${outPath}`)
    console.log(`Lanes: ${plan.lane_count}`)
    console.log(`Total chunks: ${plan.total_chunks}`)
    console.log(`Total file bytes: ${plan.total_file_bytes.toLocaleString()}`)
    console.log(`Total projected input tokens: ${plan.total_projected_input_tokens.toLocaleString()}`)
    console.log()

    // Print top 20 most expensive lanes
    const top20 = [...plan.lanes]
      .sort((a, b) => b.projected_input_tokens - a.projected_input_tokens)
      .slice(0, 20)

    console.log('Top 20 lanes by projected input tokens:')
    console.log('─'.repeat(100))
    console.log(
      'Lane'.padEnd(40) +
      'File'.padEnd(30) +
      'Chunks'.padStart(7) +
      'Proj Input'.padStart(14)
    )
    console.log('─'.repeat(100))
    for (const l of top20) {
      console.log(
        l.lane_id.padEnd(40) +
        l.target_file.padEnd(30) +
        String(l.chunk_count).padStart(7) +
        l.projected_input_tokens.toLocaleString().padStart(14)
      )
    }
    console.log('─'.repeat(100))
    console.log(`Total (all ${plan.lane_count} lanes): ${plan.total_projected_input_tokens.toLocaleString()} projected input tokens`)
  } else if (mode === 'reconcile') {
    console.log('=== Stage 1 v2: Post-run reconciliation ===\n')

    const planPath = join(outDir, 'budget-plan-v2.json')
    if (!existsSync(planPath)) {
      console.error(`Budget plan not found at ${planPath}`)
      console.error('Run with --mode estimate first.')
      process.exit(1)
    }

    const plan: BudgetPlanV2 = JSON.parse(readFileSync(planPath, 'utf-8'))

    // Try v2 consumption first, fall back to v1
    const consumptionPath = join(__dirname, '../../stage2-hunt-lanes-perfile/output/budget-consumption.json')
    if (!existsSync(consumptionPath)) {
      console.error(`Consumption file not found at ${consumptionPath}`)
      console.error('Has Stage 2 (per-file) run yet?')
      process.exit(1)
    }

    const reconciliation = reconcileV2(plan, consumptionPath)
    const outPath = join(outDir, 'reconciliation-v2.json')
    writeFileSync(outPath, JSON.stringify(reconciliation, null, 2) + '\n')

    console.log(`Reconciliation written to ${outPath}`)
    console.log()
    console.log(`Overall:`)
    console.log(`  Projected input tokens: ${reconciliation.overall.total_projected_input.toLocaleString()}`)
    if (reconciliation.overall.total_actual_input != null) {
      console.log(`  Actual input tokens:    ${reconciliation.overall.total_actual_input.toLocaleString()}`)
      console.log(`  Divergence:             ${reconciliation.overall.overall_divergence != null ? reconciliation.overall.overall_divergence.toLocaleString() : 'null'} (${reconciliation.overall.overall_divergence_pct != null ? (reconciliation.overall.overall_divergence_pct * 100).toFixed(1) + '%' : 'null'})`)
    } else {
      console.log(`  Actual input tokens:    not measured (v1 consumption data)`)
    }
    console.log(`  Actual total tokens:    ${reconciliation.overall.total_actual_total != null ? reconciliation.overall.total_actual_total.toLocaleString() : 'not measured'}`)
    console.log()

    if (reconciliation.largest_divergences.length > 0) {
      console.log('Top 10 largest divergences:')
      console.log('─'.repeat(100))
      console.log(
        'Lane'.padEnd(40) +
        'Projected'.padStart(12) +
        'Actual'.padStart(12) +
        'Divergence'.padStart(12) +
        'Pct'.padStart(10)
      )
      console.log('─'.repeat(100))
      for (const d of reconciliation.largest_divergences) {
        console.log(
          d.lane_id.padEnd(40) +
          d.projected.toLocaleString().padStart(12) +
          (d.actual != null ? d.actual.toLocaleString() : 'null').padStart(12) +
          d.divergence.toLocaleString().padStart(12) +
          (d.divergence_pct != null ? (d.divergence_pct * 100).toFixed(1) + '%' : 'null').padStart(10)
        )
      }
    }
  }
}

// ── Combined entry point ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const isV2 = args.includes('--v2')
const modeIdx = args.indexOf('--mode')
const mode = modeIdx >= 0 ? (args[modeIdx + 1] as 'estimate' | 'reconcile') : 'estimate'

if (isV2) {
  mainV2(mode).catch(console.error)
} else {
  main().catch(console.error)
}
