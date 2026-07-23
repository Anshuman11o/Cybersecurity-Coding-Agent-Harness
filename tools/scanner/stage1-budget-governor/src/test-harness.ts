// Stage 1 — Simulated Test Harness (Task C)
// Three scenarios with fake lane runners, no actual LLM calls.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { BudgetTracker, BudgetPlanEntry, ConsumptionReport, TrackerResult } from "./budget-governor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");

// ── Helpers ────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ASSERTION FAILED: ${msg}`);
    throw new Error(msg);
  }
}

function loadPlan(): BudgetPlanEntry[] {
  const planPath = join(REPO_ROOT, "tools/scanner/stage1-budget-governor/output/budget-plan.json");
  return JSON.parse(readFileSync(planPath, "utf-8"));
}

function getCeiling(plan: BudgetPlanEntry[], laneId: string): BudgetPlanEntry {
  const entry = plan.find((e) => e.lane_id === laneId);
  if (!entry) throw new Error(`Lane ${laneId} not found in plan`);
  return entry;
}

// Simulates a lane runner that reports consumption in increments
function simulateLane(
  tracker: BudgetTracker,
  laneId: string,
  ceiling: BudgetPlanEntry,
  increments: { tokens: number; seconds: number; nearly_done?: boolean; estimated_remaining?: number }[]
): { results: TrackerResult[]; final: TrackerResult } {
  const results: TrackerResult[] = [];
  let finalResult: TrackerResult | null = null;

  for (const inc of increments) {
    const rpt: ConsumptionReport = {
      lane_id: laneId,
      tokens_used: inc.tokens,
      seconds_elapsed: inc.seconds,
      nearly_done: inc.nearly_done,
      estimated_remaining: inc.estimated_remaining,
    };
    const result = tracker.reportConsumption(rpt);
    results.push(result);
    finalResult = result;

    // If stopped, the lane must stop — we record this as the final result
    if (!result.ok) {
      break;
    }
  }

  if (!finalResult) throw new Error("No final result produced");
  return { results, final: finalResult };
}

// ── Scenario 1: Lane completes well under ceiling ──────────────────────────

function scenario1(plan: BudgetPlanEntry[]): boolean {
  console.log("\n" + "═".repeat(90));
  console.log("SCENARIO 1: Lane completes well under its ceiling");
  console.log("═".repeat(90));

  const tracker = new BudgetTracker(plan);
  const laneId = "injection-sql"; // small lane: 2 files
  const ceiling = getCeiling(plan, laneId);

  console.log(`  Lane: ${laneId}`);
  console.log(`  Token ceiling: ${ceiling.token_ceiling.toLocaleString()}`);
  console.log(`  Wall-clock ceiling: ${ceiling.wall_clock_ceiling_seconds}s`);

  // Simulate a lane that uses 40% of its token budget and finishes
  const finalTokens = Math.round(ceiling.token_ceiling * 0.4);
  const finalSeconds = Math.round(ceiling.wall_clock_ceiling_seconds * 0.3);

  const increments = [
    { tokens: Math.round(finalTokens * 0.25), seconds: Math.round(finalSeconds * 0.25) },
    { tokens: Math.round(finalTokens * 0.50), seconds: Math.round(finalSeconds * 0.50) },
    { tokens: Math.round(finalTokens * 0.75), seconds: Math.round(finalSeconds * 0.75) },
    { tokens: finalTokens, seconds: finalSeconds },
  ];

  const { results, final: last } = simulateLane(tracker, laneId, ceiling, increments);

  // Verify: never stopped
  assert(last.ok === true, `Expected ok=true but got ok=false with stop type="${last.stop.type}"`);
  assert(last.stop.type === "none", `Expected stop type "none" but got "${last.stop.type}"`);
  assert(!tracker.isLaneStopped(laneId), "Lane should not be stopped");
  assert(!tracker.isRunStopped(), "Run should not be stopped");

  console.log(`  ✓ Lane finished at ${finalTokens.toLocaleString()}/${ceiling.token_ceiling.toLocaleString()} tokens (${(finalTokens / ceiling.token_ceiling * 100).toFixed(1)}%)`);
  console.log(`  ✓ Lane finished at ${finalSeconds}s/${ceiling.wall_clock_ceiling_seconds}s wall time (${(finalSeconds / ceiling.wall_clock_ceiling_seconds * 100).toFixed(1)}%)`);
  console.log(`  ✓ No stop triggered — ok=true throughout`);
  console.log(`  SCENARIO 1: PASS`);
  return true;
}

// ── Scenario 2a: Lane exceeds per-lane token ceiling (bounded_ask) ─────────

function scenario2a(plan: BudgetPlanEntry[]): boolean {
  console.log("\n" + "═".repeat(90));
  console.log("SCENARIO 2a: Lane exceeds per-lane token ceiling (bounded ask)");
  console.log("═".repeat(90));

  const tracker = new BudgetTracker(plan);
  const laneId = "client-side"; // large lane: 23 files
  const ceiling = getCeiling(plan, laneId);

  console.log(`  Lane: ${laneId}`);
  console.log(`  Token ceiling: ${ceiling.token_ceiling.toLocaleString()}`);

  // Simulate a lane that hits its ceiling but signals "nearly done, need a bit more"
  const increments = [
    { tokens: Math.round(ceiling.token_ceiling * 0.5), seconds: 20 },
    { tokens: Math.round(ceiling.token_ceiling * 0.8), seconds: 50 },
    // Hits ceiling — nearly_done=true, needs ~20% more which is ≤ 25% of ceiling
    {
      tokens: ceiling.token_ceiling,
      seconds: 80,
      nearly_done: true,
      estimated_remaining: Math.round(ceiling.token_ceiling * 0.20),
    },
  ];

  const { results, final: last } = simulateLane(tracker, laneId, ceiling, increments);

  assert(last.ok === false, `Expected ok=false (stop triggered) but got ok=true`);
  assert(last.stop.type === "lane_token_ceiling", `Expected stop type "lane_token_ceiling" but got "${last.stop.type}"`);

  const stopFraming = last.stop.type === "lane_token_ceiling" ? last.stop.framing : null;
  assert(stopFraming === "bounded_ask", `Expected framing "bounded_ask" but got "${stopFraming}"`);

  // Verify the lane is stopped and further reports are rejected
  assert(tracker.isLaneStopped(laneId), "Lane should be stopped after ceiling hit");

  // Try one more report — should be rejected
  const rejectResult = tracker.reportConsumption({
    lane_id: laneId,
    tokens_used: ceiling.token_ceiling + 100,
    seconds_elapsed: 90,
  });
  assert(rejectResult.ok === false, "Further consumption after stop should be rejected");

  console.log(`  ✓ Lane stopped at exactly ${ceiling.token_ceiling.toLocaleString()} tokens (ceiling)`);
  console.log(`  ✓ Framing: bounded_ask (nearly_done=true, needs ~${Math.round(ceiling.token_ceiling * 0.20).toLocaleString()} more tokens)`);
  console.log(`  ✓ Stop message: "${last.message.slice(0, 120)}..."`);
  console.log(`  ✓ Further consumption correctly rejected`);
  console.log(`  SCENARIO 2a: PASS`);
  return true;
}

// ── Scenario 2b: Lane exceeds per-lane token ceiling (architectural_concern) 

function scenario2b(plan: BudgetPlanEntry[]): boolean {
  console.log("\n" + "═".repeat(90));
  console.log("SCENARIO 2b: Lane exceeds per-lane token ceiling (architectural concern)");
  console.log("═".repeat(90));

  const tracker = new BudgetTracker(plan);
  const laneId = "access-control"; // largest lane: 17 files
  const ceiling = getCeiling(plan, laneId);

  console.log(`  Lane: ${laneId}`);
  console.log(`  Token ceiling: ${ceiling.token_ceiling.toLocaleString()}`);

  // Simulate a lane that hits its ceiling with no "nearly done" signal
  const increments = [
    { tokens: Math.round(ceiling.token_ceiling * 0.5), seconds: 30 },
    { tokens: Math.round(ceiling.token_ceiling * 0.85), seconds: 80 },
    // Hits ceiling — no nearly_done signal, no estimate → architectural concern
    { tokens: ceiling.token_ceiling, seconds: 120 },
  ];

  const { results, final: last } = simulateLane(tracker, laneId, ceiling, increments);

  assert(last.ok === false, `Expected ok=false (stop triggered) but got ok=true`);
  assert(last.stop.type === "lane_token_ceiling", `Expected stop type "lane_token_ceiling" but got "${last.stop.type}"`);

  const stopFraming = last.stop.type === "lane_token_ceiling" ? last.stop.framing : null;
  assert(stopFraming === "architectural_concern", `Expected framing "architectural_concern" but got "${stopFraming}"`);

  assert(tracker.isLaneStopped(laneId), "Lane should be stopped after ceiling hit");

  console.log(`  ✓ Lane stopped at exactly ${ceiling.token_ceiling.toLocaleString()} tokens (ceiling)`);
  console.log(`  ✓ Framing: architectural_concern (no nearly_done signal)`);
  console.log(`  ✓ Stop message: "${last.message.slice(0, 120)}..."`);
  console.log(`  SCENARIO 2b: PASS`);
  return true;
}

// ── Scenario 3: Global cap hit while no single lane exceeds its own ceiling 

function scenario3(plan: BudgetPlanEntry[]): boolean {
  console.log("\n" + "═".repeat(90));
  console.log("SCENARIO 3: Global cap hit while no single lane exceeds ceiling");
  console.log("═".repeat(90));

  // Set a global cap that is reachable when several lanes run partially
  // without any individual lane hitting its own ceiling.
  // Strategy: each lane consumes a fixed % of its own ceiling. We pick
  // enough lanes at 40% each that the aggregate crosses the cap.
  const globalCap = 150_000;
  const totalCeilingSum = plan.reduce((s, e) => s + e.token_ceiling, 0);
  console.log(`  Global cap set at: ${globalCap.toLocaleString()} tokens`);
  console.log(`  Total ceiling sum (all lanes): ${totalCeilingSum.toLocaleString()} tokens`);
  console.log(`  Cap is ${((globalCap / totalCeilingSum) * 100).toFixed(1)}% of total`);

  const tracker = new BudgetTracker(plan, globalCap);

  // Pick the largest lanes — each will run at 40% of its own ceiling.
  // 40% of each ensures no single lane exceeds its limit, but the
  // cumulative across several lanes crosses the 150k cap.
  const targetLanes = [
    "client-side",             // 122,128 × 0.40 = 48,851
    "access-control",          //  93,813 × 0.40 = 37,525 → cum = 86,376
    "sensitive-business-flows",//  85,877 × 0.40 = 34,351 → cum = 120,727
    "insecure-design",         //  76,382 × 0.40 = 30,553 → cum = 151,280 > 150k!
    "resource-consumption",    //  73,495 × 0.40 = 29,398 (won't reach — global cap fires first)
  ];
  const consumePct = 0.40;

  console.log(`  Running lanes at ${consumePct * 100}% of their own ceiling each:`);

  let lastResult: TrackerResult | null = null;
  let stoppedLane: string | null = null;

  for (let i = 0; i < targetLanes.length; i++) {
    const laneId = targetLanes[i];
    const ceiling = getCeiling(plan, laneId);
    const tokensToConsume = Math.round(ceiling.token_ceiling * consumePct);

    // Verify this lane's consumption is under its own ceiling
    assert(tokensToConsume < ceiling.token_ceiling,
      `Per-lane tokens ${tokensToConsume} must be < ceiling ${ceiling.token_ceiling} for lane ${laneId}`);

    console.log(`  → Lane "${laneId}": consuming ${tokensToConsume.toLocaleString()}/${ceiling.token_ceiling.toLocaleString()} (${(consumePct * 100).toFixed(0)}% of own ceiling)`);

    const rpt: ConsumptionReport = {
      lane_id: laneId,
      tokens_used: tokensToConsume,
      seconds_elapsed: 60,
    };

    const result = tracker.reportConsumption(rpt);
    lastResult = result;

    if (!result.ok) {
      stoppedLane = laneId;
      console.log(`  ✗ Run stopped at lane "${laneId}"`);
      break;
    }
  }

  assert(lastResult !== null, "Should have at least one result");
  assert(lastResult!.ok === false, `Expected global cap stop (ok=false) but got ok=true`);
  assert(lastResult!.stop.type === "global_cap", `Expected stop type "global_cap" but got "${lastResult!.stop.type}"`);
  assert(stoppedLane !== null, "Should have identified which lane triggered the global cap stop");
  assert(tracker.isRunStopped(), "Run should be marked as stopped");

  // Verify no individual lane exceeded its own ceiling
  for (const laneId of targetLanes) {
    const ceiling = getCeiling(plan, laneId);
    const consumed = lastResult!.lane_totals[laneId]?.tokens ?? 0;
    // Lanes after the stop point won't have been reported, so 0 is expected
    if (consumed > 0) {
      assert(consumed <= ceiling.token_ceiling,
        `Lane ${laneId} consumed ${consumed} but ceiling is ${ceiling.token_ceiling} — individual lane should not have exceeded`);
    }
  }

  // Verify the total crossed the global cap
  assert(lastResult!.global_total_tokens >= globalCap,
    `Global total ${lastResult!.global_total_tokens} should be >= cap ${globalCap}`);

  console.log(`  ✓ Run stopped at lane "${stoppedLane}" — global total ${lastResult!.global_total_tokens.toLocaleString()} >= cap ${globalCap.toLocaleString()}`);
  console.log(`  ✓ No individual lane exceeded its own ceiling`);
  console.log(`  ✓ Stop type: global_cap`);
  console.log(`  SCENARIO 3: PASS`);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Stage 1 Budget Governor — Simulated Test Harness");
  console.log("=".repeat(90));

  const plan = loadPlan();
  console.log(`Loaded budget plan: ${plan.length} lanes`);

  let allPassed = true;

  try { scenario1(plan); } catch (e: any) {
    console.error(`  SCENARIO 1: FAIL — ${e.message}`);
    allPassed = false;
  }

  try { scenario2a(plan); } catch (e: any) {
    console.error(`  SCENARIO 2a: FAIL — ${e.message}`);
    allPassed = false;
  }

  try { scenario2b(plan); } catch (e: any) {
    console.error(`  SCENARIO 2b: FAIL — ${e.message}`);
    allPassed = false;
  }

  try { scenario3(plan); } catch (e: any) {
    console.error(`  SCENARIO 3: FAIL — ${e.message}`);
    allPassed = false;
  }

  console.log("\n" + "═".repeat(90));
  if (allPassed) {
    console.log("ALL SCENARIOS: PASS");
  } else {
    console.log("SOME SCENARIOS: FAIL (see details above)");
    process.exit(1);
  }
}

main().catch(console.error);
