#!/usr/bin/env python3
"""
PreToolUse hook: the hard half of the blind boundary.

Prompt text asking an agent not to look for the answers is a request, and
requests get ignored under pressure. This is the part that does not depend on
the agent cooperating. It runs before every tool call, resolves what the call
would actually touch, and returns a `deny` decision the CLI enforces.

Invoked by the CLI via a generated settings.json:

    python3 sandbox_guard.py --tree <abs> --log <abs.jsonl> --phase <p> [--task <id>]

Reads the hook payload on stdin, writes one decision object on stdout, appends
one audit line to --log, and always exits 0. The decision, not the exit code,
carries the verdict.

FAIL CLOSED. An unexpected exception denies the call. A guard that fails open
under a bug is a guard that is not there on the day it matters, and one leak
invalidates every number the run produces.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import time

# ----------------------------------------------------------------------------
# Deny sets
# ----------------------------------------------------------------------------

# Tools with no legitimate use inside the boundary. Upstream Juice Shop IS the
# answer key -- its repository ships the reference fixes and the exploit tests --
# so any path to the open internet is a path to the answers.
DENIED_TOOLS = {
    'WebFetch', 'WebSearch', 'NotebookEdit',
    'Task', 'Agent',            # a subagent would not inherit this hook's --phase
}

# Applied to resolved file paths and to path-shaped Bash tokens. Specific by
# design: these strings have no innocent reason to appear in a path.
PATH_DENY_PATTERNS = [
    r'juice-shop-answer-key',
    r'patcher-ground-truth',
    r'harness-private',
    r'benchmark_ground_truth',
    r'\bSOLUTIONS\.md\b',
    r'(^|/)codefixes?(/|$)',
    r'_correct\.ts$',
    r'(^|/)answer-key\.json$',
    r'(^|/)rsn(/|$)',
]

# Applied to SEARCH intent -- Grep/Glob patterns, and the arguments of grep,
# rg, find, ag, ack, fd in a Bash command. Looser than the path set on purpose:
# looking for these is itself the behaviour being prevented, and a false
# positive here costs one denied search.
SEARCH_DENY_PATTERNS = [
    r'answer[\s_-]?key',
    r'ground[\s_-]?truth',
    r'solve[\s_-]?condition',
    r'solveIf',
    r'notSolved',
    r'expectChallengeSolved',
    r'challenges?\.yml',
    r'challengeKey',
    r'codefix',
    r'\bSOLUTIONS\b',
    r'juice-shop-answer-key',
    r'patcher-ground-truth',
    r'harness-private',
]

# Applied to the CONTENT an agent writes. Only the unambiguous strings: the
# orchestrator's own prompts talk about baselines and expected behaviour, and
# denying a write because a comment used an ordinary English phrase would break
# real work for no security gain.
CONTENT_DENY_PATTERNS = [
    r'juice-shop-answer-key',
    r'patcher-ground-truth',
    r'harness-private',
    r'benchmark_ground_truth',
    r'expectChallengeSolved',
]

# Network egress and dependency mutation. Both reach code this run is blind to,
# and `npm install` additionally breaks the pinned tree every metric differences
# against.
NETWORK_BINARIES = {
    'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp',
    'rsync', 'ftp', 'lynx', 'w3m', 'http', 'httpie', 'aria2c',
}

# (binary, first-subcommand) pairs that reach the network or rewrite history.
DENIED_SUBCOMMANDS = {
    ('git', 'clone'), ('git', 'fetch'), ('git', 'pull'), ('git', 'remote'),
    ('git', 'ls-remote'), ('git', 'submodule'), ('git', 'push'),
    # these would silently undo the run's own work, or resurrect deleted code
    ('git', 'checkout'), ('git', 'restore'), ('git', 'reset'), ('git', 'stash'),
    ('git', 'clean'), ('git', 'revert'),
    ('npm', 'install'), ('npm', 'i'), ('npm', 'ci'), ('npm', 'add'),
    ('npm', 'update'), ('npm', 'up'), ('npm', 'link'), ('npm', 'pack'),
    ('yarn', 'add'), ('yarn', 'install'), ('yarn', 'up'),
    ('pnpm', 'add'), ('pnpm', 'install'), ('pnpm', 'update'),
    ('pip', 'install'), ('pip3', 'install'),
}

# npx resolves packages from the registry when they are not already installed.
# Local binaries (tsc, tsx, eslint) are needed; explicit remote fetch is not.
NPX_DENIED_FLAGS = {'-y', '--yes', '-p', '--package', '--registry'}

# Tree-relative prefixes no agent may write to. `test/` is how the work is
# judged; editing it converts a failed patch into a passing one.
PROTECTED_WRITE_PREFIXES = ('test/', 'cypress/')
PROTECTED_WRITE_SUFFIXES = ('.spec.ts', '.spec.js')
PROTECTED_WRITE_EXACT = ('package-lock.json', 'frontend/package-lock.json')

# Written by the agent in phase 1, then frozen: these are the gates. Once
# characterisation signs them off, an agent that can edit them can pass itself.
FROZEN_IN_FIX_PHASES = ('workflow.test.ts', 'exploit.probe.ts')

SCRATCH_DIRNAME = '.patcher-scratch'

MUTATING_BINARIES = {
    'rm', 'mv', 'cp', 'tee', 'truncate', 'touch', 'chmod', 'chown', 'ln',
    'mkdir', 'rmdir', 'dd', 'install', 'patch', 'shred',
}

# Fields whose value is a path, per tool.
PATH_FIELDS = ('file_path', 'path', 'notebook_path', 'filePath')
CONTENT_FIELDS = ('content', 'new_string', 'old_string')

WRITE_TOOLS = {'Write', 'Edit', 'MultiEdit', 'NotebookEdit'}
SEARCH_TOOLS = {'Grep', 'Glob'}


# ----------------------------------------------------------------------------
# Decision plumbing
# ----------------------------------------------------------------------------

class Decision:
    __slots__ = ('allow', 'reason', 'kind')

    def __init__(self, allow: bool, reason: str = '', kind: str = ''):
        self.allow = allow
        self.reason = reason
        self.kind = kind


ALLOW = Decision(True)


def deny(kind: str, reason: str) -> Decision:
    return Decision(False, reason, kind)


def _matches(patterns, text: str):
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            return p
    return None


# ----------------------------------------------------------------------------
# Path containment
# ----------------------------------------------------------------------------

def _resolve(raw: str, cwd: str) -> str:
    """Resolve a path the way the OS will, so `..` and symlinks cannot help."""
    raw = os.path.expanduser(raw)
    if not os.path.isabs(raw):
        raw = os.path.join(cwd, raw)
    return os.path.realpath(raw)


def _inside(path: str, tree: str) -> bool:
    return path == tree or path.startswith(tree + os.sep)


def _rel(path: str, tree: str) -> str:
    if path == tree:
        return ''
    return path[len(tree) + 1:] if _inside(path, tree) else path


def check_path(raw: str, cwd: str, tree: str, *, writing: bool,
               phase: str, task: str, extra_path_patterns) -> Decision:
    """One path, fully resolved, against every path rule."""
    if not raw or not isinstance(raw, str):
        return ALLOW

    hit = _matches(PATH_DENY_PATTERNS + list(extra_path_patterns), raw)
    if hit:
        return deny('answer_key_pattern',
                    f'path matches a withheld-material pattern ({hit!r}): {raw}')

    resolved = _resolve(raw, cwd)

    if not _inside(resolved, tree):
        return deny('out_of_tree',
                    f'{raw} resolves to {resolved}, outside the work tree {tree}. '
                    'The work tree is the entire world for this run.')

    hit = _matches(PATH_DENY_PATTERNS + list(extra_path_patterns), resolved)
    if hit:
        return deny('answer_key_pattern',
                    f'resolved path matches a withheld-material pattern ({hit!r})')

    if not writing:
        return ALLOW

    rel = _rel(resolved, tree)

    if rel.startswith(PROTECTED_WRITE_PREFIXES) or rel in PROTECTED_WRITE_EXACT:
        return deny('test_dir_write',
                    f'writes under {rel.split("/")[0]}/ are denied. The test corpus is '
                    'how this work is judged; a patch that edits it is not a patch.')

    if rel.endswith(PROTECTED_WRITE_SUFFIXES):
        return deny('test_dir_write',
                    f'{rel} is a spec file. Tests are read-only for the whole run.')

    base = os.path.basename(rel)
    if phase in ('fix', 'reconcile') and base in FROZEN_IN_FIX_PHASES \
            and SCRATCH_DIRNAME in rel:
        return deny('gate_artefact_edit',
                    f'{base} is the gate this task is measured against and was frozen '
                    'at the end of characterisation. Change the code so the recorded '
                    'behaviour still holds; do not change what is recorded.')

    if phase == 'characterise':
        # Phase 1 establishes what correct behaviour looks like BEFORE anything
        # changes. A source edit here would poison the very baseline it exists
        # to capture.
        if not rel.startswith(SCRATCH_DIRNAME + '/'):
            return deny('source_edited_in_characterise',
                        f'{rel} is outside {SCRATCH_DIRNAME}/. Characterisation is '
                        'read-only on source: it records how the code behaves now, '
                        'and an edit made now is an edit the recording cannot see.')

    return ALLOW


# ----------------------------------------------------------------------------
# Bash
# ----------------------------------------------------------------------------

_REDIR = re.compile(r'^(?:\d?>>?|<|\d?>&?)')
_FLAGLIKE = re.compile(r'^-')
_SEARCH_BINARIES = {'grep', 'rg', 'ripgrep', 'ack', 'ag', 'find', 'fd', 'fdfind', 'locate'}


def _split_commands(command: str):
    """Split a compound shell line into its component commands, best effort."""
    return [c for c in re.split(r'&&|\|\||;|\|', command) if c.strip()]


def _looks_like_path(tok: str) -> bool:
    if not tok or _FLAGLIKE.match(tok):
        return False
    return ('/' in tok) or tok.startswith('~') or tok in ('.', '..')


def check_bash(command: str, cwd: str, tree: str, *, phase: str, task: str,
               extra_path_patterns, extra_cmd_patterns) -> Decision:
    if not isinstance(command, str) or not command.strip():
        return ALLOW

    for pat in extra_cmd_patterns:
        if re.search(pat, command, re.IGNORECASE):
            return deny('answer_key_pattern',
                        f'command matches a configured deny pattern ({pat!r})')

    for segment in _split_commands(command):
        try:
            tokens = shlex.split(segment, posix=True)
        except ValueError:
            # Unbalanced quotes: cannot reason about it, so refuse it.
            return deny('unparseable_command',
                        'command could not be parsed into tokens; rewrite it as a '
                        'simpler command the guard can reason about')
        if not tokens:
            continue

        binary = os.path.basename(tokens[0])
        rest = tokens[1:]
        sub = next((t for t in rest if not _FLAGLIKE.match(t)), None)

        if binary in NETWORK_BINARIES:
            return deny('network_egress',
                        f'`{binary}` reaches the network. The upstream project is itself '
                        'the material this run is blind to, so there is no safe fetch.')

        if (binary, sub) in DENIED_SUBCOMMANDS:
            return deny('network_egress' if sub in (
                'clone', 'fetch', 'pull', 'remote', 'ls-remote', 'submodule', 'push',
                'install', 'i', 'ci', 'add', 'update', 'up', 'link', 'pack')
                else 'history_rewrite',
                f'`{binary} {sub}` is denied: it either reaches the network or would '
                'undo work this run has already done.')

        if binary == 'npx':
            # Only npx's OWN flags count -- everything from the first non-flag
            # token onward belongs to the program npx is running. `npx tsc -p
            # tsconfig.json` passes `-p` to tsc, not to npx.
            own = []
            for t in rest:
                if not _FLAGLIKE.match(t):
                    break
                own.append(t)
            if any(t in NPX_DENIED_FLAGS for t in own):
                return deny('network_egress',
                            '`npx` may run locally installed binaries only; flags that '
                            'fetch a package from the registry are denied.')

        searching = binary in _SEARCH_BINARIES
        mutating = (binary in MUTATING_BINARIES
                    or (binary == 'sed' and any(t.startswith('-i') for t in rest))
                    or any(_REDIR.match(t) for t in tokens)
                    or re.search(r'(^|\s)>>?\s', segment) is not None)

        for tok in tokens[1:]:
            probe = _REDIR.sub('', tok)
            if searching and not _FLAGLIKE.match(tok):
                hit = _matches(SEARCH_DENY_PATTERNS, tok)
                if hit:
                    return deny('answer_key_pattern',
                                f'search term {tok!r} matches a withheld-material '
                                f'pattern ({hit!r}). Work from the code and the report.')
            if not _looks_like_path(probe):
                continue
            d = check_path(probe, cwd, tree, writing=mutating, phase=phase,
                           task=task, extra_path_patterns=extra_path_patterns)
            if not d.allow:
                return d

    return ALLOW


# ----------------------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------------------

def evaluate(payload: dict, tree: str, phase: str, task: str,
             extra_path_patterns, extra_cmd_patterns) -> Decision:
    tool = payload.get('tool_name') or ''
    ti = payload.get('tool_input') or {}
    cwd = payload.get('cwd') or tree

    if tool in DENIED_TOOLS:
        return deny('denied_tool',
                    f'{tool} is not available in this sandbox. Everything needed is '
                    'inside the work tree.')

    if tool == 'Bash':
        return check_bash(ti.get('command', ''), cwd, tree, phase=phase, task=task,
                          extra_path_patterns=extra_path_patterns,
                          extra_cmd_patterns=extra_cmd_patterns)

    writing = tool in WRITE_TOOLS

    for field in PATH_FIELDS:
        if field in ti:
            d = check_path(ti[field], cwd, tree, writing=writing, phase=phase,
                           task=task, extra_path_patterns=extra_path_patterns)
            if not d.allow:
                return d

    if tool in SEARCH_TOOLS:
        for field in ('pattern', 'glob'):
            val = ti.get(field)
            if isinstance(val, str):
                hit = _matches(SEARCH_DENY_PATTERNS, val)
                if hit:
                    return deny('answer_key_pattern',
                                f'{field} {val!r} matches a withheld-material pattern '
                                f'({hit!r}). Work from the code and the bug report.')

    if writing:
        for field in CONTENT_FIELDS:
            val = ti.get(field)
            if isinstance(val, str):
                hit = _matches(CONTENT_DENY_PATTERNS, val)
                if hit:
                    return deny('answer_key_pattern',
                                f'content references withheld material ({hit!r})')

    return ALLOW


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--tree', required=True)
    ap.add_argument('--log', required=True)
    ap.add_argument('--phase', default='fix',
                    choices=['characterise', 'fix', 'reconcile', 'other'])
    ap.add_argument('--task', default='')
    ap.add_argument('--deny-path-pattern', action='append', default=[])
    ap.add_argument('--deny-cmd-pattern', action='append', default=[])
    args = ap.parse_args()

    tree = os.path.realpath(args.tree)
    payload = {}
    try:
        payload = json.loads(sys.stdin.read() or '{}')
        d = evaluate(payload, tree, args.phase, args.task,
                     args.deny_path_pattern, args.deny_cmd_pattern)
    except Exception as ex:                                  # noqa: BLE001
        # Fail closed, and say why. A guard that fails open under a bug is not
        # a guard.
        d = deny('guard_error',
                 f'sandbox guard could not evaluate this call ({type(ex).__name__}: '
                 f'{ex}); denied by fail-closed policy')

    try:
        os.makedirs(os.path.dirname(args.log) or '.', exist_ok=True)
        with open(args.log, 'a') as fh:
            fh.write(json.dumps({
                'ts': time.time(),
                'task': args.task,
                'phase': args.phase,
                'tool': payload.get('tool_name'),
                'allowed': d.allow,
                'kind': d.kind,
                'reason': d.reason,
                # The input is truncated: a full Write payload is the file, and
                # the audit log is not a place to duplicate the tree.
                'tool_input': json.dumps(payload.get('tool_input', {}))[:1200],
            }) + '\n')
    except Exception:                                        # noqa: BLE001
        pass    # never let an audit-write failure change the decision

    if d.allow:
        out = {'hookSpecificOutput': {'hookEventName': 'PreToolUse',
                                      'permissionDecision': 'allow',
                                      'permissionDecisionReason': 'within sandbox'}}
    else:
        out = {'hookSpecificOutput': {'hookEventName': 'PreToolUse',
                                      'permissionDecision': 'deny',
                                      'permissionDecisionReason':
                                          f'[sandbox:{d.kind}] {d.reason}'}}
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
