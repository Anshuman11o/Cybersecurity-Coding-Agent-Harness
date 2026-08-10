#!/usr/bin/env python3
"""
The agent runtime boundary.

`AgentRunner` is deliberately narrow: give it a prompt and a phase, get back one
invocation record. The loop in `task_loop.py` never learns which runtime it is
talking to, which is what lets the patcher model be swapped without touching the
architecture -- and lets `FakeRunner` drive the entire state machine in a unit
test for no money.

Two rules this module exists to keep:

  1. Usage is MEASURED, never estimated. The numbers come from the runtime's own
     JSON output. A cost this project cannot see is a cost it pays twice.
  2. A rate limit is "not yet", not "could not". Recording a 429 as a one-turn
     $0 failure would put an infrastructure event into the report where a
     reasoning result belongs.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from dataclasses import dataclass, field, asdict

HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    'hooks', 'sandbox_guard.py')

# ----------------------------------------------------------------------------
# Effort and reasoning
# ----------------------------------------------------------------------------
# Both are passed as explicit CLI flags, which is the only channel that can be
# shown to have been honoured. Verified against the installed binary, Claude Code
# 2.1.226:
#
#   --effort <level>    documented in `claude --help`; the accepted set is the
#                       binary's own constant ["low","medium","high","xhigh","max"].
#   --thinking <mode>   registered with commander `.choices(["enabled","adaptive",
#                       "disabled"])`. Hidden from --help, but validated: an
#                       unknown value exits 1. "enabled" is documented in the
#                       option's own help text as "equivalent to adaptive", and
#                       adaptive is the mode that lets thinking scale with effort.
#
# The two flags fail differently, and that asymmetry is the reason for the
# validation below. `--thinking bogus` exits 1 and nothing runs. `--effort bogus`
# prints a warning to stderr and RUNS ANYWAY at the default effort, exit 0. The
# runner captures stdout and parses the last line as JSON, so that warning would
# be discarded and the run would complete, look clean, and be reported as a
# high-effort run. A typo'd effort must therefore be caught before the run
# starts, not diagnosed from a transcript afterwards.
#
# Settings-file and environment channels were both considered and rejected:
#   - The `--settings` file (see `_settings_path`) does accept unknown keys
#     silently, so a thinking key placed there is indistinguishable from a no-op.
#     It is also the channel carrying the sandbox hook, and in `-p` mode a
#     settings file that fails validation is ignored in full -- so an unproven key
#     there risks silently disarming the guard.
#   - MAX_THINKING_TOKENS does control thinking, but a positive value pins a FIXED
#     budget (`{type:"enabled",budget_tokens:N}`) in place of adaptive, which is
#     exactly what effort is supposed to be scaling. Setting it would defeat the
#     thing we are turning up. CLAUDE_CODE_DISABLE_THINKING was measured to have
#     no effect on this model path at all.
EFFORT_LEVELS = ('low', 'medium', 'high', 'xhigh', 'max')
REASONING_MODES = ('enabled', 'adaptive', 'disabled')

DEFAULT_EFFORT = 'high'
DEFAULT_REASONING = 'enabled'

_REASONING_ALIASES = {'true': 'enabled', 'on': 'enabled', 'yes': 'enabled',
                      'false': 'disabled', 'off': 'disabled', 'no': 'disabled'}


def normalise_effort(value) -> str:
    """Config value -> a level the CLI accepts. Absent means the default."""
    if value is None:
        return DEFAULT_EFFORT
    level = str(value).strip().lower()
    if level not in EFFORT_LEVELS:
        raise ValueError(
            f'agent.effort {value!r} is not a level this CLI accepts. Valid: '
            f'{", ".join(EFFORT_LEVELS)}. Note that the CLI does NOT fail on an '
            'unknown --effort value: it warns on stderr and runs at the default '
            'effort anyway, so a typo here would produce a full run that reports '
            'itself as high effort while having been anything but.')
    return level


def normalise_reasoning(value) -> str:
    """Config value -> a `--thinking` mode. Absent means reasoning on."""
    if value is None:
        return DEFAULT_REASONING
    if isinstance(value, bool):                  # before str(): bool is an int
        return 'enabled' if value else 'disabled'
    mode = str(value).strip().lower()
    mode = _REASONING_ALIASES.get(mode, mode)
    if mode not in REASONING_MODES:
        raise ValueError(
            f'agent.reasoning {value!r} is not a mode this CLI accepts. Valid: '
            f'true/false, or one of {", ".join(REASONING_MODES)}.')
    return mode


def validate_agent_settings(cfg: dict) -> dict:
    """Fail on a bad effort/reasoning value at config load, before any spend.

    Called from `build_runner`, so it fires for every runner kind -- including
    `fake`, where a typo would otherwise survive a rehearsal and only bite on the
    paid run it was rehearsing for.
    """
    a = cfg.get('agent', {}) or {}
    return {'effort': normalise_effort(a.get('effort')),
            'reasoning': normalise_reasoning(a.get('reasoning'))}


@dataclass
class Invocation:
    phase: str
    ok: bool = False
    reason: str | None = None
    wall_s: float = 0.0
    num_turns: int | None = None
    cost_usd: float | None = None
    usage: dict | None = None
    model_usage: dict | None = None
    rate_limited_s: float | None = None
    log_path: str | None = None
    result_tail: str = ''

    def as_record(self) -> dict:
        d = asdict(self)
        d.pop('result_tail', None)
        return d


class AgentRunner:
    """Interface. One method, because the loop needs exactly one thing."""

    name = 'abstract'

    def run(self, prompt: str, *, cwd: str, phase: str, task_id: str,
            log_path: str, guard_log: str) -> Invocation:
        raise NotImplementedError

    def describe(self) -> dict:
        return {'runner': self.name}


# ----------------------------------------------------------------------------
# Claude CLI adapter
# ----------------------------------------------------------------------------

class ClaudeCliRunner(AgentRunner):
    name = 'claude-cli'

    def __init__(self, cfg: dict, sandbox_dir: str, extra_path_patterns=(),
                 extra_cmd_patterns=()):
        a = cfg.get('agent', {})
        self.model = a.get('model', 'opus')
        self.max_turns = int(a.get('max_turns', 120))
        self.timeout_s = int(a.get('timeout_s', 2400))
        self.permission_mode = a.get('permission_mode', 'acceptEdits')
        # Absent means high / on, so an existing config gets the intended
        # settings without being edited.
        self.effort = normalise_effort(a.get('effort'))
        self.reasoning = normalise_reasoning(a.get('reasoning'))
        self.allowed_tools = list(a.get('allowed_tools',
                                        ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']))
        self.rate_limit_probe_s = int(a.get('rate_limit_probe_s', 600))
        self.rate_limit_max_wait_s = int(a.get('rate_limit_max_wait_s', 6 * 3600))
        self.sandbox_dir = sandbox_dir
        self.extra_path_patterns = list(extra_path_patterns)
        self.extra_cmd_patterns = list(extra_cmd_patterns)
        os.makedirs(self.sandbox_dir, exist_ok=True)

    # -- settings -----------------------------------------------------------

    def _settings_path(self, tree: str, phase: str, task_id: str, guard_log: str) -> str:
        """One settings file per (task, phase).

        The hook needs to know which phase it is guarding -- source is read-only
        during characterisation and the gate artefacts are frozen afterwards --
        and hook arguments are the only channel that cannot be talked out of.
        """
        argv = ['python3', HOOK, '--tree', tree, '--log', guard_log,
                '--phase', phase, '--task', task_id or '-']
        for p in self.extra_path_patterns:
            argv += ['--deny-path-pattern', p]
        for p in self.extra_cmd_patterns:
            argv += ['--deny-cmd-pattern', p]

        settings = {
            'permissions': {
                # Belt and braces: the hook denies these too, but a tool the CLI
                # never offers is a tool that cannot be reached at all.
                'deny': ['WebFetch', 'WebSearch'],
                'defaultMode': self.permission_mode,
            },
            'hooks': {
                'PreToolUse': [{
                    'matcher': '*',
                    'hooks': [{'type': 'command',
                               'command': ' '.join(shlex.quote(x) for x in argv),
                               'timeout': 20}],
                }],
            },
        }
        path = os.path.join(self.sandbox_dir,
                            f'settings-{task_id or "run"}-{phase}.json')
        with open(path, 'w') as fh:
            json.dump(settings, fh, indent=1)
        return path

    # -- run ----------------------------------------------------------------

    def _argv(self, settings_path: str, cwd: str) -> list:
        return (['claude', '-p', '--output-format', 'json',
                 '--model', self.model,
                 '--effort', self.effort,
                 '--thinking', self.reasoning,
                 '--permission-mode', self.permission_mode,
                 '--settings', settings_path,
                 '--max-turns', str(self.max_turns),
                 '--add-dir', cwd,
                 '--allowedTools'] + self.allowed_tools)

    def run(self, prompt: str, *, cwd: str, phase: str, task_id: str,
            log_path: str, guard_log: str) -> Invocation:
        inv = Invocation(phase=phase, log_path=log_path)
        settings_path = self._settings_path(cwd, phase, task_id, guard_log)
        argv = self._argv(settings_path, cwd)
        os.makedirs(os.path.dirname(log_path) or '.', exist_ok=True)

        t0 = time.time()
        waited = 0.0
        while True:
            try:
                proc = subprocess.run(argv, input=prompt, cwd=cwd, text=True,
                                      capture_output=True, timeout=self.timeout_s)
                raw = proc.stdout
                stderr = proc.stderr
            except subprocess.TimeoutExpired as ex:
                raw = ex.stdout if isinstance(ex.stdout, str) else (ex.stdout or b'').decode(
                    'utf-8', 'replace')
                _write(log_path, raw)
                inv.reason = f'timeout after {self.timeout_s}s'
                inv.wall_s = time.time() - t0
                return inv

            _write(log_path, raw)

            try:
                payload = json.loads(raw.strip().splitlines()[-1])
            except Exception as ex:                              # noqa: BLE001
                inv.reason = f'unparseable runtime output: {type(ex).__name__}: {ex}'
                inv.wall_s = time.time() - t0
                inv.result_tail = (stderr or '')[-800:]
                return inv

            if payload.get('api_error_status') != 429:
                break

            if waited >= self.rate_limit_max_wait_s:
                inv.reason = f'rate limited past max wait ({waited:.0f}s)'
                inv.rate_limited_s = waited
                inv.wall_s = time.time() - t0
                return inv
            print(f'    [rate-limited] retrying in {self.rate_limit_probe_s // 60}m '
                  f'(waited {waited / 60:.0f}m so far)', flush=True)
            time.sleep(self.rate_limit_probe_s)
            waited += self.rate_limit_probe_s

        inv.ok = not payload.get('is_error')
        inv.reason = None if inv.ok else (payload.get('result') or 'runtime reported error')[:300]
        inv.wall_s = time.time() - t0
        inv.num_turns = payload.get('num_turns')
        inv.cost_usd = payload.get('total_cost_usd')
        inv.usage = payload.get('usage')
        inv.model_usage = payload.get('modelUsage')
        inv.rate_limited_s = waited or None
        inv.result_tail = (payload.get('result') or '')[-1500:]
        return inv

    def describe(self) -> dict:
        # effort and reasoning travel in the report's agent_desc because the
        # runtime does not echo them back: the result JSON carries no effort
        # field, so the invocation record cannot be used to reconstruct what a
        # run was set to. A run that cannot say what effort it used cannot be
        # compared to one that can.
        return {'runner': self.name, 'model': self.model, 'max_turns': self.max_turns,
                'effort': self.effort, 'reasoning': self.reasoning}


def _write(path: str, text: str):
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(text or '')
    except OSError:
        pass


# ----------------------------------------------------------------------------
# Fake runtime -- drives the whole state machine for free
# ----------------------------------------------------------------------------

@dataclass
class FakeRunner(AgentRunner):
    """A scripted runtime for `--agent fake` and for the unit tests.

    `behaviour` is a callable (prompt, phase, task_id, cwd) -> bool. It performs
    whatever filesystem effects the real agent would (writing the scratch
    artefacts, editing source) and returns whether the invocation "succeeded".
    Defaults to a no-op success, which exercises every failure path in the loop.
    """

    name: str = 'fake'
    behaviour: object = None
    invocations: list = field(default_factory=list)

    def run(self, prompt: str, *, cwd: str, phase: str, task_id: str,
            log_path: str, guard_log: str) -> Invocation:
        t0 = time.time()
        ok = True
        if callable(self.behaviour):
            ok = bool(self.behaviour(prompt, phase, task_id, cwd))
        inv = Invocation(phase=phase, ok=ok, wall_s=time.time() - t0, num_turns=1,
                         cost_usd=0.0, log_path=log_path,
                         reason=None if ok else 'fake runner scripted failure')
        self.invocations.append((phase, task_id))
        _write(log_path, json.dumps({'fake': True, 'phase': phase, 'task': task_id,
                                     'prompt_chars': len(prompt)}))
        return inv

    def describe(self) -> dict:
        return {'runner': self.name, 'model': None}


def build_runner(cfg: dict, sandbox_dir: str, kind: str | None = None) -> AgentRunner:
    """Build the configured runtime adapter.

    The task loop depends only on AgentRunner, so model/runtime swaps happen
    here. `claude-cli` is the currently implemented live adapter; planned GPT
    subagent support should register another adapter here without changing the
    orchestration loop.
    """
    kind = kind or cfg.get('agent', {}).get('runner', 'claude-cli')
    validate_agent_settings(cfg)      # loudly, here, rather than 120 turns in
    if kind == 'fake':
        return FakeRunner()
    if kind == 'claude-cli':
        sb = cfg.get('sandbox', {})
        return ClaudeCliRunner(cfg, sandbox_dir,
                               extra_path_patterns=sb.get('extra_denied_path_patterns', []),
                               extra_cmd_patterns=sb.get('extra_denied_command_patterns', []))
    if kind == 'gpt-subagents':
        raise NotImplementedError(
            'gpt-subagents runner is planned but not implemented; see '
            'docs/patcher/GPT-SUBAGENT-PATCHER-PLAN.md')
    raise ValueError(f'unknown agent runner {kind!r}')
