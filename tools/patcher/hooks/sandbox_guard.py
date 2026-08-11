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

# ----------------------------------------------------------------------------
# Seed denylist -- files inside the target app that enumerate the answers
# ----------------------------------------------------------------------------
#
# A handful of files in the corpus reference every challenge by name for
# legitimate structural reasons: the challenge model, the anti-cheat bookkeeping
# and the seed-data creator. Reading any of them hands over the list of things
# the run is being scored on, so the scanner has refused them since
# 2026-07-28 (CLAUDE.md, third instance).
#
# The patcher never picked that up. This is the same failure mode the third
# instance records -- a guard that existed and was correct, and a component
# built later that silently never imported it -- so the list is NOT copied here.
# It is parsed at load time from the scanner's own module, which stays the one
# source of truth. `tests/test_sandbox_guard.py` asserts the parse matches what
# that file actually contains, so the two cannot drift apart unnoticed.

READ_GUARD_TS = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..', '..', 'scanner', 'shared', 'read-guard.ts'))

# SEED_DENYLIST entries are repo-relative (`target-apps/<app>/lib/antiCheat.ts`).
# A patcher work tree is a copy of one target app, so the corpus root is stripped
# to leave the tree-relative path the agent would actually type.
_CORPUS_ROOT_RE = re.compile(r'^target-apps/[^/]+/')

# A FLOOR, not a copy of the list: these are unioned in so that a read-guard.ts
# that cannot be read, cannot be parsed, or has been emptied still leaves the
# known-bad names denied. Failing open here would be worse than having no guard,
# because the log would claim the boundary held. A test asserts this floor is a
# subset of what read-guard.ts declares, so it can never quietly become the only
# thing in force.
SEED_DENYLIST_FLOOR = ('models/challenge.ts', 'lib/antiCheat.ts',
                       'data/datacreator.ts')


def parse_seed_denylist(path: str = READ_GUARD_TS):
    """Parse SEED_DENYLIST out of the scanner's read-guard.

    Returns (tree_relative_paths, source_description, parse_error_or_None).
    Never raises: on any failure it returns the fail-closed floor and the reason,
    which the caller surfaces in the denial text and the audit.
    """
    try:
        with open(path) as fh:
            src = fh.read()
        # `[^=]*` spans the type annotation (`: readonly string[]`) without
        # crossing the assignment.
        m = re.search(r'\bSEED_DENYLIST\b[^=]*=\s*\[(.*?)\]', src, re.S)
        if not m:
            raise ValueError('no SEED_DENYLIST array found')
        entries = re.findall(r"""['"]([^'"]+)['"]""", m.group(1))
        if not entries:
            raise ValueError('SEED_DENYLIST is empty')
        rel = []
        for raw in entries:
            r = _CORPUS_ROOT_RE.sub('', raw.strip()).strip('/')
            if r and r not in rel:
                rel.append(r)
        return tuple(rel), path, None
    except Exception as ex:                                      # noqa: BLE001
        return (), path, f'{type(ex).__name__}: {ex}'


_parsed, SEED_DENYLIST_SOURCE, SEED_DENYLIST_PARSE_ERROR = parse_seed_denylist()

SEED_DENYLIST_PARSED = _parsed
SEED_DENYLIST_RELPATHS = tuple(
    list(_parsed) + [p for p in SEED_DENYLIST_FLOOR if p not in _parsed])
SEED_DENYLIST_BASENAMES = frozenset(
    os.path.basename(p) for p in SEED_DENYLIST_RELPATHS)

# Anchored at a path boundary, for a value that is already a path.
_SEED_PATH_RE = [re.compile(r'(^|/)' + re.escape(p) + r'$', re.IGNORECASE)
                 for p in SEED_DENYLIST_RELPATHS]
# Unanchored, for a whole Bash command line. A denylisted name appearing
# anywhere in a command is denied: `python3 -c "open('data/datacreator.ts')"`
# and a heredoc are reads too, and no token-level rule sees them. The lookarounds
# keep `challenge.model.ts` and `antiCheat.unit.test.ts` out of it.
_SEED_TEXT_RE = [re.compile(r'(?<![\w.\-])' + re.escape(b) + r'(?![\w.\-])',
                            re.IGNORECASE)
                 for b in sorted(SEED_DENYLIST_BASENAMES)]

_SEED_DENY_MSG = (
    'is on the corpus seed denylist. It enumerates the challenges this run is '
    'scored against, so reading it would end the run\'s blindness. It is denied '
    'for reads and writes alike, in every phase; no task is ever assigned to it. '
    'Work from the bug report and the code around it.')


def _seed_source_note() -> str:
    if SEED_DENYLIST_PARSE_ERROR:
        return (f' [denylist source {SEED_DENYLIST_SOURCE} could not be parsed '
                f'({SEED_DENYLIST_PARSE_ERROR}); running on the fail-closed floor]')
    return ''


def seed_denylist_hit_path(value: str):
    """The denylisted relative path a path-shaped value names, or None."""
    if not value or not isinstance(value, str):
        return None
    probe = value.replace('\\', '/').rstrip('/')
    for rel, rx in zip(SEED_DENYLIST_RELPATHS, _SEED_PATH_RE):
        if rx.search(probe):
            return rel
    if os.path.basename(probe) in SEED_DENYLIST_BASENAMES:
        return os.path.basename(probe)
    return None


def seed_denylist_hit_text(text: str):
    """The denylisted name a free-form command line mentions, or None."""
    if not text or not isinstance(text, str):
        return None
    for b, rx in zip(sorted(SEED_DENYLIST_BASENAMES), _SEED_TEXT_RE):
        if rx.search(text):
            return b
    return None


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

# ----------------------------------------------------------------------------
# Git history -- the pre-strip source is still in the commit graph
# ----------------------------------------------------------------------------
#
# The corpus was committed once with its challenge instrumentation intact and
# stripped in a later commit. The strip changed the working tree; it did not
# change history. Every pre-strip blob is still reachable, so a command that
# renders a revision back into text hands over instrumented source -- a challenge
# identifier sitting next to a file and a line, which is the exact pairing the
# blind boundary forbids. Measured on the repository as it stands: the count of
# corpus files carrying that instrumentation is an order of magnitude higher one
# commit back than it is in the tree the agent can see.
#
# DENIED BY CAPABILITY, NEVER BY REVISION. Naming the two commits would be
# security theatre: the same blobs are reachable through every ancestor of those
# commits, any branch or tag containing them, `HEAD~n`, `@{n}` reflog syntax, a
# `git rev-list` enumeration, an abbreviated object id of any length, and the raw
# object files under `.git/`. There is no finite set of revisions to block. What
# is finite is the set of commands that can turn A revision -- any revision --
# back into content, so that is what is blocked, and the rules below never look
# at which revision was named.
#
# This is a MITIGATION, NOT A REMOVAL. The blobs remain in history; only the
# routes to them from inside a sandboxed agent are closed. Removing them means
# rewriting history, which is deferred. See docs/patcher/README.md.

# Subcommands that exist to turn a revision into content, or to write a revision
# into a working tree. Denied outright -- no form of them is needed here.
#
# `merge-file` is deliberately absent: it three-way-merges three FILES, reads no
# revision, and the integrator depends on it.
GIT_CONTENT_SUBCOMMANDS = {
    # print a blob, or a tree's contents, at a revision
    'show', 'cat-file', 'ls-tree', 'diff-tree', 'diff-index', 'unpack-file',
    'checkout-index',
    # serialise history -- blobs included -- into something readable as a file
    'archive', 'bundle', 'fast-export', 'format-patch', 'pack-objects',
    # materialise a revision into a tree on disk
    'worktree', 'bisect', 'cherry-pick', 'merge', 'rebase', 'replay',
    'filter-branch',
    # diff drivers whose arguments are revisions
    'difftool', 'range-diff',
}

# Subcommands that are fine against the working tree and become a history read
# the moment a revision is named: `git diff` vs `git diff <rev>`, `git grep <pat>`
# vs `git grep <pat> <rev>`, `git blame <file>` vs `git blame <rev> -- <file>`.
GIT_REV_SENSITIVE_SUBCOMMANDS = {
    'diff', 'grep', 'blame', 'annotate', 'checkout', 'restore', 'switch',
}

# `git log` names revisions harmlessly -- a subject line is not source. It leaks
# only when asked to render the diffs, which is what these flags do. `-G`/`-S`
# are searches over historical content: an answer to "did this string ever exist"
# is a read of the revision that held it, one bit at a time.
GIT_PATCH_FLAG_SUBCOMMANDS = {'log', 'shortlog', 'whatchanged', 'reflog'}

_GIT_PATCH_FLAG_RE = re.compile(
    r'^(-p|-u|--patch|--patch-with-[\w-]+|--full-diff|--cc|-c|-m|'
    r'--word-diff(=.*)?|-[GS].*|--pickaxe[\w-]*(=.*)?)$')

# git's own options, before the subcommand. These take a VALUE, so the "first
# non-flag token is the subcommand" rule used elsewhere in this file reads the
# value instead: in `git -C . show HEAD` it decides the subcommand is `.`. That is
# a bypass, so the git parsing below consumes them explicitly.
_GIT_GLOBAL_VALUE_OPTS = {'-C', '-c', '--git-dir', '--work-tree', '--namespace',
                          '--exec-path', '--super-prefix', '--config-env',
                          '--attr-source'}

# Per-subcommand options that take a separate value, so the value is not mistaken
# for a revision. Kept deliberately small: an unknown option's value falls through
# to the revision test and is denied, which is the safe direction.
_GIT_VALUE_OPTS = {
    'grep': {'-e', '-f', '-A', '-B', '-C', '--max-depth', '--threads', '-m',
             '--max-count'},
    'diff': {'-O', '--output', '--diff-filter', '-l', '-U', '--unified',
             '--src-prefix', '--dst-prefix'},
    'blame': {'-L', '-C', '-M', '-S', '--date', '--contents', '--since'},
    'annotate': {'-L', '-C', '-M', '-S', '--date', '--contents', '--since'},
    'checkout': {'-b', '-B', '--orphan', '--conflict'},
    'switch': {'-c', '-C', '--orphan', '--conflict'},
    'restore': {'--conflict'},
}

# Options that name a revision in their own value, whatever else the command says.
_GIT_REV_OPT_RE = re.compile(r'^(--source|-s|--merge-base|--tree-ish)(=.*)?$')

# A revision by shape. Only consulted for tokens that also name a real file, so
# that a file genuinely called `HEAD` cannot be used to smuggle one past.
_GIT_REV_SHAPED_RE = re.compile(
    r'^[0-9a-fA-F]{4,40}$|\.\.|@\{|[\^~:]|^refs/|'
    r'^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|@)$')

# The object store itself. `.git/objects/**` IS the pre-strip source, zlib-framed:
# reading it with python, or copying the directory somewhere and pointing
# `--git-dir` at the copy, reaches the same blobs without ever naming a
# subcommand above. Anchored so `.gitignore` and `.github/` do not match.
_GIT_INTERNALS_PATH_RE = re.compile(r'(^|/)\.git(/|$)')
_GIT_INTERNALS_TEXT_RE = re.compile(r'(?<![\w.\-])\.git(?![\w.\-])')

# `git` reached through a path, a command substitution, or an interpreter's -c
# string: `cat $(git show …)`, `bash -c "git show …"`. None of those make `git`
# the first token of a segment, so the whole line is scanned as well.
_GIT_INVOCATION_RE = re.compile(r'(?:^|(?<=[\s;|&()`"\'/]))git\s+([^;|&()`\n]*)')

_GIT_DENY_TAIL = (
    'The working tree was stripped of the material this run is scored against, '
    'but history was not: any command that renders a revision back into text '
    'returns the unstripped file. Revisions are not readable here, in any form. '
    'Work from the tree as it stands.')

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


# Paths outside the work tree that no agent could be reaching for in order to find
# an answer. They are still DENIED -- the tree is the world -- but they are recorded
# as incidental so they cannot void a run on their own.
#
# This distinction is not cosmetic. A run whose only out-of-tree denials were
# /dev/null and its own dependency tree was reported "BLIND BOUNDARY VIOLATED", and
# a real 67-minute, $21 wave was stamped void by it. Conflating "the agent went
# looking for the answers" with "the agent wrote to /dev/null" destroys the one
# signal the flag exists to carry.
INCIDENTAL_OUTSIDE = (
    # character devices: a shell redirect target, never a source of answers
    r'^/dev/(null|zero|urandom|random|stdout|stderr|fd/)',
    # the application's OWN dependency tree, deliberately shared by symlink so a
    # 427MB node_modules is not copied per unit tree. Reading a dependency's
    # package.json resolves through that symlink and lands outside the tree.
    # `($|/)` because the first version required a trailing slash and therefore
    # missed `./node_modules` -- the directory itself -- which flagged a completed
    # wave on one `ls`.
    r'/node_modules($|/)',
    # the scratchpad this harness itself hands the agent
    r'^/tmp/claude-',
)


def _incidental_outside(resolved: str) -> bool:
    if any(re.search(p, resolved) for p in INCIDENTAL_OUTSIDE):
        return True
    # Nothing can be learned from a file that is not there. Measured: an agent
    # trying to run a test file in its OWN tree miscounted `../` and landed on a
    # path that does not exist -- denied, harmless, and on its own enough to stamp a
    # completed wave void.
    #
    # This does not weaken the answer-key defence. PATH_DENY_PATTERNS is matched
    # against the path STRING, before this, and does not care whether the target
    # exists -- so a reach for the answer key is caught either way.
    return not os.path.exists(resolved)


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

    seed = seed_denylist_hit_path(raw)
    if seed:
        named = raw if raw == seed else f'{raw} ({seed})'
        return deny('seed_denylist', f'{named} {_SEED_DENY_MSG}{_seed_source_note()}')

    # Before resolution, so a path into a git directory anywhere is caught, and
    # again after it, so `.` -> the repository root cannot be walked into.
    if _GIT_INTERNALS_PATH_RE.search(raw.replace('\\', '/')):
        return deny('git_history',
                    f'{raw} is inside a git directory. The object store holds the '
                    f'pre-strip source verbatim. {_GIT_DENY_TAIL}')

    resolved = _resolve(raw, cwd)

    if not _inside(resolved, tree):
        kind = ('out_of_tree_incidental' if _incidental_outside(resolved)
                else 'out_of_tree')
        return deny(kind,
                    f'{raw} resolves to {resolved}, outside the work tree {tree}. '
                    'The work tree is the entire world for this run.')

    hit = _matches(PATH_DENY_PATTERNS + list(extra_path_patterns), resolved)
    if hit:
        return deny('answer_key_pattern',
                    f'resolved path matches a withheld-material pattern ({hit!r})')

    rel = _rel(resolved, tree)

    # After resolution, so `data/../data/datacreator.ts` and a symlink planted
    # inside the tree are the same thing to the guard as the plain name.
    seed = seed_denylist_hit_path(rel)
    if seed:
        return deny('seed_denylist',
                    f'{raw} resolves to {rel}, which {_SEED_DENY_MSG}'
                    f'{_seed_source_note()}')

    if _GIT_INTERNALS_PATH_RE.search(rel):
        return deny('git_history',
                    f'{raw} resolves to {rel}, inside a git directory. '
                    f'{_GIT_DENY_TAIL}')

    if not writing:
        return ALLOW

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


# -- git history ------------------------------------------------------------

def _git_subcommand(args):
    """(subcommand, remaining args), with git's own global options consumed."""
    i = 0
    while i < len(args):
        a = args[i]
        if a in _GIT_GLOBAL_VALUE_OPTS:
            i += 2                       # the option AND its value
            continue
        if a.startswith('-'):
            i += 1
            continue
        break
    if i >= len(args):
        return None, []
    return args[i], args[i + 1:]


def _names_a_real_file(tok: str, cwd: str, tree: str) -> bool:
    try:
        if os.path.isabs(tok):
            return os.path.exists(tok)
        return (os.path.exists(os.path.join(cwd, tok))
                or os.path.exists(os.path.join(tree, tok)))
    except (OSError, ValueError):
        return False


def git_revision_argument(sub: str, args, cwd: str, tree: str):
    """The argument of a rev-sensitive git subcommand that names a revision.

    Fails closed by construction: a positional argument is treated as a REVISION
    unless it demonstrably names a file that exists. `git diff routes/x.ts` is a
    working-tree diff and passes; `git diff v1.2`, `git diff some-branch` and
    `git diff <sha>` do not, and neither does a branch name this guard has never
    heard of. That asymmetry is deliberate -- the guard cannot enumerate refs, and
    guessing that an unknown word is harmless is the guess that loses.
    """
    value_opts = _GIT_VALUE_OPTS.get(sub, frozenset())
    positional = 0
    skip_value = False
    # `git grep` normally takes its pattern as the first positional, so that one
    # token is not a revision. But the pattern can be supplied by option instead
    # -- `-e`, `-f`, `--regexp=`, `--file=` -- and then the first positional is
    # the REVISION. Skipping it unconditionally let `git grep -e <pat> <rev>`
    # through, which renders matching lines straight out of history: the leak
    # this guard exists to stop, reached by moving one argument behind a flag.
    pattern_from_opt = False
    for tok in args:
        if tok == '--':
            break                        # everything after `--` is a pathspec
        if skip_value:
            skip_value = False
            continue
        if _GIT_REV_OPT_RE.match(tok):
            return tok                   # e.g. `git restore --source=<rev>`
        if tok.startswith('-'):
            if sub == 'grep' and (tok in ('-e', '-f')
                                  or tok.startswith(('--regexp=', '--file='))):
                pattern_from_opt = True
            if tok in value_opts:
                skip_value = True
            continue
        positional += 1
        if sub == 'grep' and positional == 1 and not pattern_from_opt:
            continue                     # the search pattern, not a revision
        if _names_a_real_file(tok, cwd, tree) and not _GIT_REV_SHAPED_RE.search(tok):
            continue
        return tok
    return None


def check_git_history(command: str, cwd: str, tree: str) -> Decision:
    """Deny git invocations that can render a revision back into content.

    Scanned over the WHOLE command line rather than per segment, because `git`
    reaches history without ever being a segment's first token: `cat $(git show
    …)`, `bash -c "git show …"`, `/usr/bin/git show …`.
    """
    if _GIT_INTERNALS_TEXT_RE.search(command):
        return deny('git_history',
                    'command names the .git directory. The object store holds the '
                    f'pre-strip source verbatim, so it is not readable. {_GIT_DENY_TAIL}')

    for m in _GIT_INVOCATION_RE.finditer(command):
        try:
            args = shlex.split(m.group(1), posix=True)
        except ValueError:
            args = m.group(1).split()    # best effort; the caller denies it anyway
        sub, rest = _git_subcommand(args)
        if not sub:
            continue

        if sub in GIT_CONTENT_SUBCOMMANDS:
            return deny('git_history',
                        f'`git {sub}` renders a revision back into content or writes '
                        f'one into a tree. {_GIT_DENY_TAIL}')

        if sub in GIT_PATCH_FLAG_SUBCOMMANDS:
            flag = next((t for t in rest if _GIT_PATCH_FLAG_RE.match(t)), None)
            if flag:
                return deny('git_history',
                            f'`git {sub} {flag}` prints historical diffs, or searches '
                            f'them, which is a read of the revisions they come from. '
                            f'`git {sub}` without it is fine. {_GIT_DENY_TAIL}')

        if sub in GIT_REV_SENSITIVE_SUBCOMMANDS:
            rev = git_revision_argument(sub, rest, cwd, tree)
            if rev:
                return deny('git_history',
                            f'`git {sub}` was given {rev!r}, which is not a file in '
                            f'this tree and is therefore a revision. {_GIT_DENY_TAIL}')

    return ALLOW


def check_bash(command: str, cwd: str, tree: str, *, phase: str, task: str,
               extra_path_patterns, extra_cmd_patterns) -> Decision:
    if not isinstance(command, str) or not command.strip():
        return ALLOW

    for pat in extra_cmd_patterns:
        if re.search(pat, command, re.IGNORECASE):
            return deny('answer_key_pattern',
                        f'command matches a configured deny pattern ({pat!r})')

    # Whole-line, before tokenising. A denylisted file can be read by a command
    # whose path never appears as its own token -- `python3 -c "...open(...)"`,
    # a heredoc, `node -e`, a quoted argument to an interpreter -- and none of
    # those reach the per-token path check below.
    seed = seed_denylist_hit_text(command)
    if seed:
        return deny('seed_denylist',
                    f'command names {seed}, which {_SEED_DENY_MSG}'
                    f'{_seed_source_note()}')

    # Also whole-line, and for the same reason: the token-level rules below see
    # `git` only when it is a segment's first word.
    d = check_git_history(command, cwd, tree)
    if not d.allow:
        return d

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
            # A shell glob names no denylisted path but can expand onto one:
            # `cat data/*.ts`, `cp data/* scratch/`. The guard expands it the way
            # the shell would and checks what it would actually reach.
            if any(ch in probe for ch in '*?[') and _looks_like_path(probe):
                import glob as _glob
                base = probe if os.path.isabs(probe) else os.path.join(cwd, probe)
                for match in _glob.glob(base)[:2000]:
                    seed = seed_denylist_hit_path(_rel(os.path.realpath(match), tree))
                    if seed:
                        return deny('seed_denylist',
                                    f'{tok} expands onto {seed}, which '
                                    f'{_SEED_DENY_MSG}{_seed_source_note()}')

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
