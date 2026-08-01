/**
 * Stage 2 Hunt Lanes (Per-File v2) — types matching the contract schema.
 */

// ── Lane assignments (consumed from Stage 0.5 v2 output) ────────────────

export interface CategoryRef {
  code: string;       // e.g. "A03", "API3", "LLM01"
  name: string;       // display name
  framework: string;  // e.g. "OWASP Top 10 2021"
}

export interface ChunkSpec {
  index: number;
  start_line: number;
  end_line: number;
}

export interface ChunkPlan {
  required: boolean;
  total_chunks: number;
  chunks: ChunkSpec[];
}

export interface LaneAssignmentEntry {
  lane_id: string;
  target_file: string;          // relative to target_dir
  disposition: "hunt" | "skip";
  skip_reason: string | null;   // non-null when disposition="skip"
  categories: CategoryRef[];
  category_basis: string | null;
  // NEW (Stage 0.5 v3): signal-based narrowing
  signals?: string[];           // per-file signals from Stage 0
  classes?: string[];           // narrowed class ids (union of signal classes + floor)
  class_basis?: Record<string, string[]>; // which signal contributed which classes
  file_bytes: number;
  file_lines: number;
  estimated_prompt_tokens: number;
  chunk_plan: ChunkPlan;
}

export interface CoverageLedger {
  total_files_in_inventory: number;
  assigned_hunt: number;
  assigned_skip: number;
  unaccounted: number;          // MUST be 0
}

export interface LaneAssignments {
  generated_at: string;
  target_dir: string;
  source_stage0_run: string;
  coverage_ledger: CoverageLedger;
  category_universe: CategoryRef[];
  lanes: LaneAssignmentEntry[];
}

// ── Vulnerability class registry types ───────────────────────────────────

export interface VulnClassEntry {
  playbook: string;
  codes: string[];
}

export type VulnClassRegistry = Record<string, VulnClassEntry>;

export interface FindingClassRef {
  class: string;                  // class id, e.g. "access-control"
  justified_by_step: number;      // 0-based index into the finding's trace array
}

// ── Finding / output types (same shapes as v1) ───────────────────────────

export interface TraceStep {
  kind: "entrypoint" | "propagation" | "sink";
  file: string;
  line: number;
  description: string;
}

export interface CandidateFinding {
  finding_id: string;
  lane_id: string;
  finding_classes: FindingClassRef[];  // vulnerability class(es) with justification
  categories: string[];                // OWASP code strings (A01, API1, …) — union of all class codes
  title: string;
  description: string;
  trace: TraceStep[];
  severity_estimate: "low" | "medium" | "high" | "critical";
  confidence: number;           // 0-1
}

export interface LaneHuntResponse {
  findings: CandidateFinding[];
}

export interface BudgetConsumption {
  lane_id: string;
  tokens_used: number;
  seconds_elapsed: number;
  ceiling_hit: boolean;
  /**
   * True when the lane threw and produced no findings. The entry is still
   * recorded — a lane that burned wall-clock and hit a rate limit is part of
   * the budget story — but a failed lane is NOT complete, and loadCheckpoint
   * excludes it so a resume retries it instead of locking the failure in.
   */
  failed?: boolean;
  /** Why the lane failed. Kept so a rate limit is distinguishable from a bug. */
  failure_reason?: string;
}

// ── v2 itemized token accounting types ───────────────────────────────────

/**
 * One contributing segment of a built prompt.
 * `chars` is exact character count (string length).
 * `segment_type` is one of: "boilerplate", "playbook:<class-id>",
 *   "route_context", "arch_context", "file_content".
 */
export interface PromptSegment {
  segment_type: string;  // "boilerplate" | "playbook:<class-id>" | "route_context" | "arch_context" | "file_content"
  chars: number;
}

/**
 * Character breakdown of a prompt. The sum of all `chars` fields MUST
 * equal the prompt string's `.length`.
 */
export interface PromptBreakdown {
  segments: PromptSegment[];
  total_chars: number;
}

/**
 * Measured token counts from the API response.
 * Fields are `null` when the provider omits them — never inferred.
 */
export interface MeasuredTokens {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  /**
   * Input tokens served from the provider's prefix cache, billed at an order of
   * magnitude less than fresh input.
   *
   * Recorded because a conversational loop re-sends its whole first prompt as
   * the prefix of its follow-up turn — precisely the shape a prefix cache
   * serves — so a loop's marginal input cost is not its marginal input tokens.
   * Without this field the difference is invisible and the loop looks more
   * expensive than it is. Null when the provider omits the detail.
   */
  cached_prompt_tokens?: number | null;
}

/**
 * Per-segment attribution of prompt_tokens, derived by distributing
 * the measured prompt_tokens in proportion to each segment's character
 * share. This is an approximation, NOT a measurement.
 */
export interface DerivedSegmentAttribution {
  segment_type: string;
  chars: number;
  derived_prompt_tokens: number | null;  // null when prompt_tokens was not measured
}

/**
 * Measured + derived token data for one chunk of a lane.
 */
export interface ChunkTokenRecord {
  chunk_index: number;
  start_line: number;
  end_line: number;
  prompt_breakdown: PromptBreakdown;
  segment_attribution: DerivedSegmentAttribution[];
  measured: MeasuredTokens;
  /**
   * Which follow-up turn of the per-lane agent loop this record covers.
   * Absent on the lane's first turn, which is the only turn a `none` lane has,
   * so a run made before the loop existed reads back unchanged.
   */
  loop_pass?: number;
  /** The loop mode in force. Absent for the first turn, as above. */
  loop_mode?: string;
  /**
   * How many findings this turn emitted, and what the merge did with them.
   * A loop whose later turns emit findings that all merge away has produced
   * tokens and no information; without these three numbers that is invisible
   * in the artifact and shows up only as a cost line.
   */
  findings_emitted?: number;
  findings_added?: number;
  traces_extended?: number;
}

/**
 * Per-lane token record (v2 enriched).
 */
export interface LaneTokenRecordV2 {
  lane_id: string;
  target_file: string;
  file_bytes: number;
  chunk_count: number;
  chunks: ChunkTokenRecord[];
  lane_totals: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  };
}

/**
 * Run-level rollup of v2 token accounting.
 */
export interface RunLevelRollupV2 {
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_tokens: number | null;
  input_by_segment_kind: Record<string, { tokens: number | null; share_of_input: number | null }>;
  input_by_playbook_class: Array<{ class_id: string; tokens: number | null; share_of_input: number | null }>;
  top_20_expensive_lanes: Array<{
    lane_id: string;
    target_file: string;
    file_bytes: number;
    chunk_count: number;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    segment_breakdown: Record<string, number | null>;
  }>;
  tokens_per_byte: number | null;
  lane_chunk_distribution: Record<string, number>;  // chunk_count → lane_count
  repeated_boilerplate_cost: {
    total_extra_prompt_tokens: number | null;
    description: string;
  };
}

/**
 * Full v2 budget consumption output.
 */
export interface BudgetConsumptionV2 {
  generated_at: string;
  /** Provider key the run executed under. Optional: predates the registry. */
  provider?: string;
  model: string | null;
  lanes: LaneTokenRecordV2[];
  rollup: RunLevelRollupV2;
  // Legacy array preserved for backward compatibility
  legacy_entries: BudgetConsumption[];
}
