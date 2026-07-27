/**
 * Degraded-run tracking.
 *
 * Stage 0 and Stage 0.5 are built to survive an LLM failure: they catch the
 * error and fall back to deterministic analysis. That is a sensible safety net
 * when one provider is the only option, but it is dangerous once results are
 * being scored — the stage exits 0, writes normal-looking artifacts, and
 * meta.json still names the model. A reader cannot tell the model never ran.
 *
 * Every fallback path must call markDegraded(). writeMeta() then records it,
 * and failIfDegraded() turns it into a non-zero exit when the provider was
 * chosen explicitly (i.e. someone is deliberately testing that provider and a
 * silent deterministic substitute would corrupt their results).
 *
 * Zero dependencies (node builtins only).
 */

/**
 * State lives on globalThis, not in a module-level array.
 *
 * tsx can load the same file into both the CJS and ESM graphs of one process
 * (depending on which package imports it), producing two module instances with
 * separate module-level state. That silently broke the first implementation:
 * a stage called markDegraded() on instance A while writeMeta() read instance
 * B and saw a clean run. globalThis is shared across both graphs.
 */
const KEY = '__scanner_degraded_reasons__'
const g = globalThis as unknown as Record<string, string[] | undefined>
if (!g[KEY]) g[KEY] = []
const reasons: string[] = g[KEY]!

/** Record that a stage fell back to a non-LLM path. */
export function markDegraded(reason: string): void {
  reasons.push(reason)
  console.error(`  [DEGRADED] ${reason}`)
}

export function isDegraded(): boolean {
  return reasons.length > 0
}

export function degradedReasons(): string[] {
  return [...reasons]
}

/** Test-only: clear accumulated state. */
export function resetDegraded(): void {
  reasons.length = 0
}
