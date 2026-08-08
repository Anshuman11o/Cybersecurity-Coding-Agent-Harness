#!/usr/bin/env python3
"""
The work tree: build it, snapshot it, revert it, diff it, hash it.

One cumulative tree for the whole run. Task N works on what task N-1 left
behind, which is what makes "one fixed codebase" a real deliverable and lets a
later task's regression net notice damage an earlier one caused.

Everything here is deliberately boring and deliberately defensive. The tree is
the run's only durable product; a bug in this module does not produce a worse
number, it produces no number at all.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile

SCRATCH_DIRNAME = '.patcher-scratch'

# Never part of the deliverable diff, and never part of the tree digest.
# `order_*.pdf` are receipts the application itself writes while its own tests
# run -- dozens per suite. Counting them as patcher output would put noise into
# every blast-radius number, and the rest of `ftp/` is real application content
# a patch may legitimately touch, so the receipts are excluded and the directory
# is not.
DIFF_EXCLUDES = [
    'node_modules', '.git', 'dist', 'build', 'logs', '*.log', 'coverage',
    '.nyc_output', 'uploads', '*.sqlite', '*.tmp', 'order_*.pdf',
    SCRATCH_DIRNAME, '.patcher-snapshots',
]

# Root-relative paths the target application GENERATES when it runs. Its own
# .gitignore lists them (`i18n/*.json`, `ftp/legal.md`) and only `i18n/.gitkeep`
# is tracked, so they are never the patcher's work -- a test run populates them.
#
# These cannot go in DIFF_EXCLUDES above. `diff --exclude` matches a basename,
# and the same locale filenames (ar_SA.json, bg_BG.json, ...) also live under
# frontend/src/assets/i18n and data/static/i18n, which ARE tracked source a patch
# may legitimately touch. Excluding by basename would silently hide a real
# frontend change, so the filter has to be path-anchored instead.
#
# Measured before this existed: a task's deliverable diff was 4,000,043 bytes,
# hit the truncation cap, and contained NONE of the actual patch --
# diff_stats.files_touched listed 32 generated locale files and zero real ones.
# Since build_reconcile() feeds this diff back into the prompt, the agent was
# being asked to review locale data instead of its own change.
GENERATED_PATH_PREFIXES = ('i18n/', 'ftp/legal.md')

# Digest inputs. Source only: anything a test run can touch would make the
# digest a measure of test execution rather than of the patch.
SOURCE_EXTS = ('.ts', '.js', '.mjs', '.cjs', '.tsx', '.json', '.yml', '.yaml',
               '.html', '.pug', '.scss', '.css')
DIGEST_SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output',
                    'logs', 'uploads', SCRATCH_DIRNAME, '.patcher-snapshots', 'frontend/dist'}


class WorkspaceError(RuntimeError):
    pass


# ----------------------------------------------------------------------------
# Construction
# ----------------------------------------------------------------------------

def prepare(base_tree: str, work_tree: str, node_modules: str | None = None,
            *, force: bool = False) -> None:
    """Materialise the work tree from the pristine base.

    A real copy, not hardlinks. An in-place write through a hardlink would
    corrupt the base tree that every future run is copied from, and the symptom
    would not show up until a later run produced quietly wrong numbers.
    """
    base_tree = os.path.abspath(base_tree)
    work_tree = os.path.abspath(work_tree)
    if not os.path.isdir(base_tree):
        raise WorkspaceError(f'base tree does not exist: {base_tree}')
    if os.path.realpath(base_tree) == os.path.realpath(work_tree):
        raise WorkspaceError('work_tree must not be the base tree; the base must stay '
                             'pristine for the next run')

    if os.path.exists(work_tree):
        if not force:
            raise WorkspaceError(
                f'{work_tree} already exists. Pass --force to rebuild it, or --resume '
                '<run_id> to continue the run that owns it. Silently overwriting a tree '
                'is how a run gets lost.')
        shutil.rmtree(work_tree)
    os.makedirs(work_tree, exist_ok=True)

    r = subprocess.run(
        f'tar -C {base_tree!r} -cf - --exclude=node_modules --exclude=.git . '
        f'| tar -C {work_tree!r} -xf -',
        shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        raise WorkspaceError(f'tree copy failed: {r.stderr[:500]}')

    if node_modules:
        link = os.path.join(work_tree, 'node_modules')
        if not os.path.exists(link):
            if not os.path.isdir(node_modules):
                raise WorkspaceError(
                    f'node_modules {node_modules} does not exist. Install it once, '
                    'outside the tree, and point the config at it: the patcher may not '
                    'run npm install, and an unpinned install would make every '
                    'differential metric unattributable.')
            os.symlink(os.path.abspath(node_modules), link)


# ----------------------------------------------------------------------------
# Snapshots
# ----------------------------------------------------------------------------

def _snapshot_dir(work_tree: str) -> str:
    d = os.path.join(work_tree, '.patcher-snapshots')
    os.makedirs(d, exist_ok=True)
    return d


def snapshot(work_tree: str, tag: str) -> str:
    """Freeze the source state so a task can be rolled back exactly.

    A tar of source only. Cheap enough to take per task, and unlike `git stash`
    it does not require the tree to be a repository or race with anything the
    application writes while its own tests run.
    """
    path = os.path.join(_snapshot_dir(work_tree), f'{tag}.tar')
    tmp = path + '.partial'
    with tarfile.open(tmp, 'w') as tf:
        for rel in iter_source_files(work_tree):
            tf.add(os.path.join(work_tree, rel), arcname=rel)
    os.replace(tmp, path)      # atomic: a half-written snapshot is worse than none
    return path


def restore(work_tree: str, snapshot_path: str) -> list:
    """Roll the tree back to a snapshot. Returns the files that changed.

    Files created since the snapshot are removed: a fix that added a module and
    is then abandoned must not leave the module behind, or the next task
    inherits dead code nobody chose to ship.
    """
    if not os.path.exists(snapshot_path):
        raise WorkspaceError(f'snapshot missing: {snapshot_path}')

    before = set(iter_source_files(work_tree))
    with tarfile.open(snapshot_path, 'r') as tf:
        members = tf.getmembers()
        recorded = {m.name for m in members if m.isfile()}
        tf.extractall(work_tree)

    for rel in sorted(before - recorded):
        try:
            os.remove(os.path.join(work_tree, rel))
        except OSError:
            pass
    return sorted(before ^ recorded)


def discard_snapshot(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


# ----------------------------------------------------------------------------
# Inspection
# ----------------------------------------------------------------------------

def iter_source_files(work_tree: str):
    """Every source file, tree-relative, sorted. The unit of hashing and snapshotting."""
    out = []
    for root, dirs, files in os.walk(work_tree):
        rel_root = os.path.relpath(root, work_tree)
        rel_root = '' if rel_root == '.' else rel_root
        dirs[:] = [d for d in dirs
                   if d not in DIGEST_SKIP_DIRS
                   and os.path.join(rel_root, d) not in DIGEST_SKIP_DIRS
                   and not os.path.islink(os.path.join(root, d))]
        for f in files:
            if f.endswith(SOURCE_EXTS):
                out.append(os.path.join(rel_root, f) if rel_root else f)
    return sorted(out)


def tree_digest(work_tree: str) -> str:
    """Content hash of the source tree.

    Pairs the report with the codebase it describes, and is what a resumed run
    checks before it agrees to continue. A resumed run against a drifted tree
    would attribute someone else's edits to the patcher, invisibly.
    """
    h = hashlib.sha256()
    for rel in iter_source_files(work_tree):
        h.update(rel.encode())
        h.update(b'\0')
        try:
            with open(os.path.join(work_tree, rel), 'rb') as fh:
                h.update(hashlib.sha256(fh.read()).digest())
        except OSError:
            h.update(b'<unreadable>')
    return h.hexdigest()


def changed_files(work_tree: str, snapshot_path: str) -> list:
    """Source files that differ from a snapshot, tree-relative."""
    if not os.path.exists(snapshot_path):
        return []
    changed = []
    with tarfile.open(snapshot_path, 'r') as tf:
        recorded = {}
        for m in tf.getmembers():
            if m.isfile():
                fh = tf.extractfile(m)
                recorded[m.name] = hashlib.sha256(fh.read()).digest() if fh else b''
    for rel in iter_source_files(work_tree):
        try:
            with open(os.path.join(work_tree, rel), 'rb') as fh:
                digest = hashlib.sha256(fh.read()).digest()
        except OSError:
            continue
        if recorded.get(rel) != digest:
            changed.append(rel)
    for rel in recorded:
        if not os.path.exists(os.path.join(work_tree, rel)):
            changed.append(rel)
    return sorted(set(changed))


def diff_against_snapshot(work_tree: str, snapshot_path: str, *, max_bytes=400_000) -> str:
    """Unified diff of the tree against a snapshot, for the reconcile prompt."""
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(snapshot_path, 'r') as tf:
            tf.extractall(tmp)
        return _diff_dirs(tmp, work_tree, max_bytes=max_bytes)


def diff_against_base(work_tree: str, base_tree: str, *, max_bytes=4_000_000) -> str:
    """The run's deliverable diff: work tree against the pristine base."""
    return _diff_dirs(base_tree, work_tree, max_bytes=max_bytes)


def _is_generated(rel: str) -> bool:
    rel = rel.lstrip('./')
    return any(rel == p.rstrip('/') or rel.startswith(p)
               for p in GENERATED_PATH_PREFIXES)


def _rel_to_root(path: str, roots: tuple) -> str:
    for r in sorted(roots, key=len, reverse=True):
        pre = r.rstrip('/') + '/'
        if path.startswith(pre):
            return path[len(pre):]
    return path


def _drop_generated(text: str, roots: tuple) -> str:
    """Strip file sections for paths the application generates at run time.

    Applied before truncation, so generated data can never crowd the real patch
    out of the diff.
    """
    out, skipping = [], False
    for line in text.splitlines(keepends=True):
        if line.startswith('diff '):
            parts = line.rstrip('\n').split()
            skipping = bool(parts) and _is_generated(_rel_to_root(parts[-1], roots))
        elif line.startswith('Only in '):
            body = line[len('Only in '):].rstrip('\n')
            d, _, name = body.partition(': ')
            skipping = False
            if _is_generated(_rel_to_root(os.path.join(d, name), roots)):
                continue
        if not skipping:
            out.append(line)
    return ''.join(out)


def _diff_dirs(a: str, b: str, *, max_bytes: int) -> str:
    # `--text` and a lenient decode: the target ships images and key material,
    # and one undecodable byte used to abort a whole unit AFTER the agent had
    # finished and been paid for.
    argv = (['diff', '-ruN'] + [f'--exclude={e}' for e in DIFF_EXCLUDES]
            + ['--text', a, b])
    r = subprocess.run(argv, capture_output=True)
    text = r.stdout.decode('utf-8', errors='replace')
    text = _drop_generated(text, (a, b))
    if len(text) > max_bytes:
        text = text[:max_bytes] + f'\n[... diff truncated at {max_bytes} bytes ...]\n'
    return text


def diff_stats(diff_text: str, bug_file: str | None = None) -> dict:
    files, added, removed = set(), 0, 0
    for line in diff_text.splitlines():
        if line.startswith('+++ '):
            path = line[4:].split('\t')[0].strip()
            if path not in ('/dev/null',):
                files.add(path)
        elif line.startswith('+') and not line.startswith('+++'):
            added += 1
        elif line.startswith('-') and not line.startswith('---'):
            removed += 1
    touched = sorted(files)
    outside = bool(bug_file) and any(bug_file not in f for f in touched) if touched else False
    return {
        'files_touched': touched,
        'lines_added': added,
        'lines_removed': removed,
        'touched_outside_bug_file': outside,
        # The signature of fixing by deleting the feature. Advisory, never a
        # gate -- some correct fixes are deletions -- but every one of these is
        # worth a human eye before a number is published.
        'net_deletion': removed > 0 and removed >= max(8, added * 3),
    }


# ----------------------------------------------------------------------------
# Scratch
# ----------------------------------------------------------------------------

def scratch_rel(task_id: str) -> str:
    return f'{SCRATCH_DIRNAME}/{task_id}'


def scratch_abs(work_tree: str, task_id: str) -> str:
    return os.path.join(work_tree, SCRATCH_DIRNAME, task_id)


def ensure_scratch(work_tree: str, task_id: str) -> str:
    p = scratch_abs(work_tree, task_id)
    os.makedirs(p, exist_ok=True)
    return p


def harvest_scratch(work_tree: str, task_id: str, dest_dir: str) -> bool:
    """Copy the agent's artefacts out of the tree, then remove them from it.

    Harvested because they are the evidence for what the task verified; removed
    because the deliverable is application source and nothing else. `DIFF_EXCLUDES`
    also drops the scratch path unconditionally, so even a failed harvest cannot
    leak agent-authored test files into the submitted diff.
    """
    src = scratch_abs(work_tree, task_id)
    if not os.path.isdir(src):
        return False
    os.makedirs(dest_dir, exist_ok=True)
    dst = os.path.join(dest_dir, 'artefacts')
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    shutil.rmtree(src, ignore_errors=True)
    return True


def cleanup(work_tree: str) -> None:
    """Remove every trace of the run's machinery from the deliverable tree."""
    for d in (SCRATCH_DIRNAME, '.patcher-snapshots'):
        shutil.rmtree(os.path.join(work_tree, d), ignore_errors=True)
