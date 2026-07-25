/**
 * Stage 2 Hunt Lanes — shared types.
 */

export interface LaneManifestEntry {
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

export interface TraceStep {
  kind: "entrypoint" | "propagation" | "sink";
  file: string;
  line: number;
  description: string;
}

export interface ScopeRequest {
  file: string;
  reason: string;
}

export interface CandidateFinding {
  finding_id: string;
  lane_id: string;
  categories: string[];
  title: string;
  description: string;
  trace: TraceStep[];
  severity_estimate: "low" | "medium" | "high" | "critical";
  confidence: number;  // 0-1
}

export interface LaneHuntResponse {
  findings: CandidateFinding[];
  scope_requests: ScopeRequest[];
}

export interface BudgetConsumption {
  lane_id: string;
  tokens_used: number;
  seconds_elapsed: number;
  ceiling_hit: boolean;
}
