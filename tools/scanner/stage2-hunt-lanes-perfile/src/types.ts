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
}
