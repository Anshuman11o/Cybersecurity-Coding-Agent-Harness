# GPT subagent patcher plan

This is the implementation plan for running the patcher with GPT-backed
subagents while keeping the orchestrator model-agnostic. It replaces the
assumption that the live runtime must be `claude-cli`; `claude-cli` remains one
adapter, not the architecture.

## Design goal

The patcher should continue to be a deterministic task loop that owns snapshots,
gates, retries, reverts, and reports. Models are interchangeable workers behind a
small runtime interface. A GPT deployment should therefore change only the agent
adapter and run config, not `task_loop.py`, `verify.py`, schemas, or scoring.

## Runtime abstraction

Keep `AgentRunner.run(prompt, cwd, phase, task_id, log_path, guard_log)` as the
only orchestrator dependency. Add adapters, rather than special-casing models in
the loop:

| Adapter | Purpose | Notes |
|---|---|---|
| `fake` | Unit tests and no-cost state-machine checks | Already available. |
| `claude-cli` | Existing CLI-based runtime | Keep for comparability and fallback. |
| `gpt-subagents` | Planned GPT-backed patcher runtime | Spawns one fresh GPT subagent per phase and returns the same `Invocation` record. |
| Future adapters | Other local CLIs, OpenAI API, or hosted workers | Must implement the same interface and measured-usage fields. |

The adapter contract is deliberately stronger than "send prompt, get text":

1. It must run each phase in a fresh context.
2. It must confine file access to the work tree and route all write attempts
   through the same policy boundaries used by the current hook.
3. It must write a raw transcript to `log_path`.
4. It must return measured usage/cost when the backend exposes it.
5. It must surface rate limits as retryable infrastructure state, not as a
   failed patching result.

## GPT subagent topology

Use a supervising adapter that dispatches phase-local subagents:

```text
Task loop
  -> GptSubagentRunner.run(... phase=characterise ...)
       -> spawn fresh CHARACTERISE subagent
       -> collect artefacts + transcript + usage
  -> runner-executed gates
  -> GptSubagentRunner.run(... phase=fix ...)
       -> spawn fresh FIX subagent
  -> runner-executed gates
  -> GptSubagentRunner.run(... phase=reconcile ...)
       -> spawn fresh RECONCILE subagent
```

The subagent is scoped by phase, not by task lifetime. That preserves the current
architecture property that reasoning context never accumulates across phases; the
only carry-over is the bounded object assembled by the orchestrator.

## Model-agnostic config shape

The run config should name a runtime and a model family without making the task
loop aware of either:

```jsonc
{
  "agent": {
    "runner": "gpt-subagents",
    "model": "gpt-5.5",
    "role_models": {
      "characterise": "gpt-5.5",
      "fix": "gpt-5.5",
      "reconcile": "gpt-5.5",
      "attest": "gpt-5.5"
    },
    "max_turns": 120,
    "timeout_s": 2400
  }
}
```

`role_models` is optional. When absent, the adapter uses `agent.model` for every
phase. This lets a later experiment use a stronger model for `fix` and a cheaper
model for `attest` without changing prompts or loop code.

## Prompt and artefact boundaries

Do not fork prompts per model. The prompt builders should keep describing the
phase contract, allowed outputs, and gates. Runtime-specific mechanics belong in
adapter-level wrappers only, for example:

- how a GPT subagent is spawned;
- how its file-edits are applied;
- how tool calls are constrained;
- how usage is read and normalized into `Invocation`.

The artefacts remain unchanged:

- `workflow.test.ts`
- `exploit.probe.ts`
- `characterisation.json`
- `attestation.json`
- `patcher-report.json`

## Implementation steps

1. Add a `GptSubagentRunner` adapter beside `ClaudeCliRunner`.
2. Keep the adapter registered through `build_runner()` using
   `agent.runner = "gpt-subagents"`.
3. Normalize GPT usage into the existing `Invocation.usage`,
   `Invocation.model_usage`, and `Invocation.cost_usd` fields.
4. Reuse the existing sandbox policy. If the GPT subagent API cannot consume the
   current Claude hook directly, implement the same checks at the adapter's file
   operation boundary and keep the denial log shape compatible with
   `guard.jsonl`.
5. Run the existing fake-agent tests unchanged. Passing them proves the model
   swap did not leak into the orchestration loop.
6. Run a two-vulnerability pilot before any 12-vulnerability run.

## Non-goals

- Do not move the VERIFY gates into the model.
- Do not let one subagent patch multiple bugs in one context.
- Do not add model-specific branches to `task_loop.py`.
- Do not make scoring depend on runtime identity.
