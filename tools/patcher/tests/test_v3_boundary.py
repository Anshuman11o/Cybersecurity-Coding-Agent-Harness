"""v3 write boundary.

The boundary is not a deny list, and the tests exist to keep it from becoming
one. A measured correct CSRF fix spanned four files, so "outside" has to be
reachable-by-declaration rather than blocked; what must NOT be reachable is the
test corpus, and what must not be silent is an undeclared reach.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from v3 import boundary  # noqa: E402


def _b(owned=('lib/insecurity.ts',)):
    return boundary.WriteBoundary('A01', owned)


# ---- glob semantics --------------------------------------------------------

def test_double_star_crosses_separators_and_single_star_does_not():
    assert boundary.matches('views/a/b.pug', ['views/**'])
    assert boundary.matches('views/a.pug', ['views/**'])
    assert not boundary.matches('viewsx/a.pug', ['views/**'])
    assert boundary.matches('config/x.yml', ['config/*'])
    assert not boundary.matches('config/a/x.yml', ['config/*'])


def test_leading_double_star_matches_at_any_depth_including_none():
    assert boundary.matches('a.spec.ts', ['**/*.spec.ts'])
    assert boundary.matches('frontend/src/app/x.spec.ts', ['**/*.spec.ts'])
    assert not boundary.matches('frontend/src/app/x.ts', ['**/*.spec.ts'])


# ---- classification --------------------------------------------------------

def test_the_four_classes():
    b = _b()
    assert b.classify('lib/insecurity.ts') == boundary.OWNED
    assert b.classify('views/login.pug') == boundary.SHARED_EXTENSION
    assert b.classify('routes/login.ts') == boundary.OUTSIDE
    assert b.classify('test/api/login.spec.ts') == boundary.NEVER_WRITABLE


def test_never_writable_beats_ownership():
    """A map that assigned a spec file must not thereby make it writable.

    The hard deny is the last thing that should be overridable by data.
    """
    b = boundary.WriteBoundary('A01', ['frontend/src/x.spec.ts'])
    assert b.classify('frontend/src/x.spec.ts') == boundary.NEVER_WRITABLE
    assert not b.may_write('frontend/src/x.spec.ts', declared=['frontend/src/x.spec.ts'])


def test_declaring_is_what_makes_an_outside_write_permitted():
    b = _b()
    assert not b.may_write('routes/login.ts')
    assert b.may_write('routes/login.ts', declared=['routes/login.ts'])


def test_reads_are_open_except_the_answer_key_adjacent_set():
    b = _b()
    assert b.may_read('routes/login.ts')
    assert not b.may_read('models/challenge.ts')
    assert not b.may_read('lib/antiCheat.ts')


# ---- review ----------------------------------------------------------------

def test_review_separates_declared_from_undeclared():
    rev = _b().review(
        ['lib/insecurity.ts', 'routes/login.ts', 'views/login.pug'],
        declared=['routes/login.ts'])
    assert rev.owned == ['lib/insecurity.ts']
    assert rev.declared == ['routes/login.ts']
    assert rev.undeclared == ['views/login.pug']
    assert not rev.clean


def test_an_undeclared_reach_still_forces_merge_last():
    """The reason to merge last is that somebody else owns the file. That is
    true whether or not the agent remembered to say so."""
    rev = _b().review(['lib/insecurity.ts', 'routes/login.ts'])
    assert rev.merge_last
    assert rev.undeclared == ['routes/login.ts']


def test_staying_inside_the_owned_set_is_clean_and_merges_early():
    rev = _b().review(['lib/insecurity.ts'])
    assert rev.clean and not rev.merge_last


def test_a_write_to_the_test_corpus_is_denied_not_declared_away():
    rev = _b().review(['test/api/x.ts'], declared=['test/api/x.ts'])
    assert rev.denied == ['test/api/x.ts']
    assert not rev.clean


def test_unused_declarations_are_reported():
    """A declaration nobody used is not an error, but it is the difference
    between 'fixes need four files' and 'agents declare defensively'."""
    rev = _b().review(['lib/insecurity.ts'], declared=['views/x.pug'])
    assert rev.unused_declarations == ['views/x.pug']
