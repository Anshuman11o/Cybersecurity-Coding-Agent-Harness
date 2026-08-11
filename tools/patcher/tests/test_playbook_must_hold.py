"""`must_hold` -- the remediation criterion, kept away from the thing it judges.

A playbook entry says what good remediation looks like, in prose, in a prompt
that runs to tens of thousands of characters. Prose is advisory: an agent can
receive a principle, and a named anti-pattern, and do the opposite anyway, and
nothing downstream notices because the only gate it faces is a probe it wrote
itself.

`must_hold` is the same statement in a form something can check. Two properties
make it worth having, and this file pins both.

**It is not rendered into any prompt.** `prompts._fmt_playbook` selects
`guidance`, `principles`, `preserve` and `common_mistakes` by name, so a new
field is invisible to the agent by construction. That is the point rather than an
accident: an agent that can see the criterion optimises against the criterion,
which is the same circularity as grading a fix with the probe that defined it.
The agent optimises against the principle; the gate decides whether the criterion
holds.

**Its provenance is independent of any run.** Each assertion is authored from the
entry's OWASP sources and its class definition, never from an observed failure.
Guidance reverse-engineered from a scored run makes the next run score better
without being better -- the harness fitted to the benchmark, and a number that
reads as progress. `must_hold_provenance` records this so a later reader can tell
which kind of content they are looking at.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import prompts  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..')
PLAYBOOKS = [
    os.path.join(ROOT, 'inputs', 'playbook.json'),
    os.path.join(ROOT, 'inputs', 'subset3', 'playbook.json'),
    os.path.join(ROOT, 'inputs', 'subset4', 'playbook.json'),
    os.path.join(ROOT, 'inputs', 'subset5', 'playbook.json'),
]


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def test_every_entry_in_every_playbook_carries_a_criterion():
    for path in PLAYBOOKS:
        pb = _load(path)
        for e in pb['entries']:
            mh = e.get('must_hold')
            assert mh and all(isinstance(x, str) and x.strip() for x in mh), (
                f"{os.path.basename(os.path.dirname(path))}/{e['entry_id']} has no "
                'must_hold; an entry with no checkable criterion can only ever be '
                'graded by the agent that wrote the fix')


def test_the_criterion_never_reaches_the_agent():
    """The separation the whole field depends on."""
    pb = _load(PLAYBOOKS[0])
    for e in pb['entries']:
        rendered = prompts._fmt_playbook(e, None, pb.get('general_guidance'))
        for clause in e['must_hold']:
            assert clause not in rendered, (
                f"{e['entry_id']}: a must_hold clause was rendered into the prompt. "
                'An agent that can read the criterion optimises against it, which is '
                'the circularity this field exists to break.')


def test_a_subset_playbook_states_the_same_criterion_as_the_master():
    """Subsets are filters. A criterion that drifts between them is two criteria."""
    master = {e['entry_id']: e['must_hold'] for e in _load(PLAYBOOKS[0])['entries']}
    for path in PLAYBOOKS[1:]:
        for e in _load(path)['entries']:
            assert e['must_hold'] == master[e['entry_id']], (
                f"{os.path.basename(os.path.dirname(path))}/{e['entry_id']} states a "
                'different criterion from the master playbook')


def test_the_criterion_is_general_and_names_nothing_from_the_target():
    """Authored from the class, not from a run.

    A criterion naming a route, a file, a config key or a challenge would be
    guidance fitted to this benchmark, and a later run measured against it would
    report the fit as an improvement.
    """
    forbidden = ('.ts', '.json', '.md', '/ftp', '/rest', '/api', 'juice',
                 'challenge', 'metrics', 'i18n', 'kdbx', 'server.ts',
                 'userAgent', 'user-agent', 'BUG-')
    for path in PLAYBOOKS:
        for e in _load(path)['entries']:
            for clause in e['must_hold']:
                low = clause.lower()
                hit = [t for t in forbidden if t.lower() in low]
                assert not hit, (
                    f"{e['entry_id']}: must_hold names {hit} -- that is target- or "
                    'run-specific. State the property, not the instance.')


def test_provenance_is_recorded_next_to_the_criterion():
    for path in PLAYBOOKS:
        pb = _load(path)
        prov = pb.get('must_hold_provenance', '')
        assert 'independent of any run' in prov, (
            f'{path}: must_hold_provenance must record that the criterion was '
            'authored without reference to any run, so a later reader can tell it '
            'apart from guidance fitted to a scored result')


def test_every_class_a_playbook_names_is_covered_by_an_entry_with_a_criterion():
    for path in PLAYBOOKS:
        pb = _load(path)
        for e in pb['entries']:
            assert e.get('classes'), f"{e['entry_id']} names no classes"
            assert e.get('must_hold'), (
                f"{e['entry_id']} covers {e['classes']} with no criterion")
