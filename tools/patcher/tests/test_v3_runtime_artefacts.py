"""Two chunks in one phase must both be able to start the application.

The failure this pins down cost `patch-run-subset-05` a whole chunk, and nothing
about it was the agent's doing.

Every chunk agent starts the app to run its probe. The app's own startup restore
copies a set of files into place as it boots -- a legal notice, a subtitle track
and 43 localisation JSONs. Those files are not in the pristine checkout, so when
two chunks run concurrently in one phase they each create their own copy. The
merge queue does a three-way merge, which needs a common ancestor; for a file
absent from the phase base there is none. The first chunk to reach the queue
creates them in the trunk and is accepted. The second conflicts against them --
43 conflicts, not one of them about a line any agent wrote -- and its ENTIRE
submission is rolled back.

Two independent defences, and this file tests both:

  1. `logs/` is in SEED_EXCLUDES, so it is never seeded and never submitted. The
     app writes into it immediately and it is pure runtime noise.
  2. everything else the startup restore creates is put into the BASE TREE by
     `setup/prepare_env.sh`, so the ancestor exists and the files never show up
     as a change at all.

Defence 2 is deliberately NOT an exclusion. Excluding those paths would also hide
a real edit to a file an agent may legitimately touch, which trades a loud
failure for a silent one.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import workspace  # noqa: E402
from v3 import chunk_map, dispatcher  # noqa: E402

from test_v3_dispatcher import BUGS, Script, _build, _map_doc, _write  # noqa: E402

SETUP = os.path.join(os.path.dirname(__file__), '..', 'setup', 'prepare_env.sh')

# What the application's startup restore creates, as a relative path shape. Kept
# in one place so a future addition to the app's restore routine has one obvious
# home.
RUNTIME_RESTORED = ('ftp/legal.md',
                    'frontend/dist/frontend/assets/public/videos/owasp_promo.vtt',
                    'i18n/en.json')


# ----------------------------------------------------------------------------
# Defence 1 -- logs/ is never seeded and never submitted
# ----------------------------------------------------------------------------

def test_logs_is_excluded_from_a_chunk_tree():
    assert 'logs' in dispatcher.SEED_EXCLUDES, (
        'the application writes into logs/ as soon as it starts, and every chunk '
        'agent starts it. Left seeded, two concurrent chunks each produce their '
        'own and the second submission is rejected over it.')


def test_a_chunk_that_writes_a_log_does_not_submit_it(tmp_path):
    """The end-to-end form of the same guarantee."""
    class Logging(Script):
        def __call__(self, prompt, phase, task_id, cwd):
            _write(os.path.join(cwd, 'logs', 'access.log'), 'boot\n')
            return super().__call__(prompt, phase, task_id, cwd)

    d, trunk, _r = _build(tmp_path, Logging())
    result = d.run()
    submitted = {rel for p in result['phases'] for c in p['chunks']
                 for rel in (c.get('changed_files') or [])}
    assert not [s for s in submitted if s.startswith('logs/')], (
        f'a log file reached a submission: {sorted(submitted)}')


# ----------------------------------------------------------------------------
# Defence 2 -- the base tree carries what the app restores at boot
# ----------------------------------------------------------------------------

def test_prepare_env_runs_the_apps_own_restore_routine():
    """Called, not reimplemented: a hand-written copy list drifts from the app."""
    with open(SETUP) as fh:
        sh = fh.read()
    assert 'restoreOverwrittenFilesWithOriginals' in sh, (
        'prepare_env.sh must invoke the application\'s own startup restore, so '
        'the base tree cannot disagree with what the app actually creates')


def test_prepare_env_verifies_the_restored_files_are_present():
    with open(SETUP) as fh:
        sh = fh.read()
    for rel in ('ftp/legal.md',
                'frontend/dist/frontend/assets/public/videos/owasp_promo.vtt'):
        assert rel in sh, f'prepare_env.sh --verify does not check {rel}'
    assert 'i18n' in sh, 'prepare_env.sh --verify does not check the i18n set'


def test_the_restored_files_are_NOT_excluded_from_seeding():
    """They belong in the base, not in an exclude list.

    Excluding them would stop the conflict too -- and would also hide a real edit
    to any of them, turning a loud merge failure into a silent unsubmitted fix.
    """
    for rel in RUNTIME_RESTORED:
        top = rel.split('/')[0]
        assert top not in dispatcher.SEED_EXCLUDES, (
            f'{top}/ is excluded from seeding; the fix is to put its contents in '
            'the base tree so the merge has an ancestor, not to stop submitting '
            'edits to it')


# ----------------------------------------------------------------------------
# The thing that actually failed: two chunks, one phase, both merge
# ----------------------------------------------------------------------------

def _two_chunk_phase_doc():
    """One phase, two disjoint chunks, so both run concurrently and both merge."""
    doc = _map_doc()
    for ph in doc['phases']:
        ph['concurrency'] = 2
    return doc


def test_two_concurrent_chunks_both_merge_when_the_base_has_the_runtime_files(tmp_path):
    """The regression criterion, stated as the run would have wanted it.

    Both agents create the same boot-time file. Because the phase base already
    has it -- as `prepare_env.sh` now guarantees -- there is a common ancestor,
    the merge is trivial, and BOTH submissions are accepted.
    """
    doc = _two_chunk_phase_doc()

    class Booting(Script):
        def __call__(self, prompt, phase, task_id, cwd):
            # identical content, exactly as the app's restore produces
            _write(os.path.join(cwd, 'i18n', 'en.json'), '{"lang":"en"}\n')
            return super().__call__(prompt, phase, task_id, cwd)

    d, trunk, _r = _build(tmp_path, Booting(), doc=doc,
                          build_gate=lambda t: (True, ''))
    # The base tree carries it, which is what prepare_env.sh now arranges.
    _write(os.path.join(trunk, 'i18n', 'en.json'), '{"lang":"en"}\n')

    result = d.run()
    rejected = [e for p in result['phases'] for e in (p['merge'].get('rejected') or [])]
    assert not rejected, (
        'a submission was rejected even though the phase base carried the '
        f'boot-time file: {rejected}')
    phase0 = [p for p in result['phases'] if p['phase'] == 0][0]
    assert len(phase0['merge'].get('accepted') or []) == len(phase0['chunks']), (
        'not every concurrently-running chunk was accepted')


def test_without_the_base_file_the_second_chunk_is_rejected(tmp_path):
    """The failure, reproduced, so the fix above is demonstrably load-bearing.

    Same run, one difference: the boot-time file is absent from the base. No
    common ancestor, so the second chunk to reach the queue is rejected -- over a
    file neither agent authored.
    """
    doc = _two_chunk_phase_doc()

    class Booting(Script):
        def __call__(self, prompt, phase, task_id, cwd):
            _write(os.path.join(cwd, 'i18n', 'en.json'), '{"lang":"en"}\n')
            return super().__call__(prompt, phase, task_id, cwd)

    d, trunk, _r = _build(tmp_path, Booting(), doc=doc,
                          build_gate=lambda t: (True, ''))
    # deliberately NOT creating it in the trunk

    result = d.run()
    phase0 = [p for p in result['phases'] if p['phase'] == 0][0]
    rejected = phase0['merge'].get('rejected') or []
    assert rejected, (
        'expected the second concurrent chunk to be rejected when the boot-time '
        'file is absent from the phase base -- if this no longer happens the '
        'merge queue changed and the fix above may be redundant'
    )
    assert any('i18n/en.json' in str(e) for e in rejected), (
        f'rejected for some other reason than the boot-time file: {rejected}')
