"""Tests that cannot survive a correct fix, and must not be charged as damage.

The property being protected is narrow and cuts both ways: a test that requires the
attack to succeed is excused, and everything else in the same file still counts. Get
the first half wrong and correct fixes get reverted -- measured: one unit, 5 rounds,
$10.79, reverted while its probe was blocked the whole time. Get the second half
wrong and real damage goes uncharged, which is worse because it is silent.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import antioracle  # noqa: E402

# An attack payload in the request AND an assertion that the sink was reached.
DEPENDENT = '''
describe('/ftp', () => {
  void it('GET the .bak file for the challenge', async () => {
    const res = await request(app).get('/ftp/package.json.bak%2500.md')
    assert.equal(res.status, 200)
  })
  void it('GET the confidential file', async () => {
    const res = await request(app).get('/ftp/acquisitions.md')
    assert.equal(res.status, 200)
  })
})
'''

# Same payload, but it asserts the attack is REJECTED. A correct fix keeps this green,
# so it must stay in the net.
REJECTION = '''
describe('/ftp', () => {
  void it('GET .bak is refused', async () => {
    const res = await request(app).get('/ftp/package.json.bak%2500.md')
    assert.equal(res.status, 403)
  })
})
'''


def _tree(tmp_path, rel, src):
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(src)
    return str(tmp_path)


def _reg(title):
    return {'title': title, 'was': 'pass', 'now': 'fail'}


def test_an_attack_dependent_test_is_detected(tmp_path):
    tree = _tree(tmp_path, 'test/api/ftp.test.ts', DEPENDENT)
    info = antioracle.detect(tree, ['test/api/ftp.test.ts'])
    assert info['available'] is True
    assert info['tests']['test/api/ftp.test.ts'] == {'GET the .bak file for the challenge'}


def test_a_test_asserting_the_attack_is_refused_is_not_excused(tmp_path):
    """It carries the same payload but a correct fix keeps it green."""
    tree = _tree(tmp_path, 'test/api/ftp.test.ts', REJECTION)
    info = antioracle.detect(tree, ['test/api/ftp.test.ts'])
    assert info['tests'] == {}


def test_the_derived_suite_row_is_excused_with_its_child(tmp_path):
    """Excusing the child alone leaves the describe() row red, the gate red, and the
    exclusion worthless."""
    rel = 'test/api/ftp.test.ts'
    tree = _tree(tmp_path, rel, DEPENDENT)
    info = antioracle.detect(tree, [rel])
    real, excused = antioracle.filter_regressions(
        rel, [_reg('GET the .bak file for the challenge'), _reg('/ftp')], info)
    assert real == []
    assert {e['title'] for e in excused} == {'GET the .bak file for the challenge', '/ftp'}


def test_a_genuine_regression_beside_an_antioracle_still_counts(tmp_path):
    rel = 'test/api/ftp.test.ts'
    tree = _tree(tmp_path, rel, DEPENDENT)
    info = antioracle.detect(tree, [rel])
    real, excused = antioracle.filter_regressions(
        rel, [_reg('GET the .bak file for the challenge'), _reg('/ftp'),
              _reg('GET the confidential file')], info)
    assert {r['title'] for r in real} == {'/ftp', 'GET the confidential file'}
    assert {e['title'] for e in excused} == {'GET the .bak file for the challenge'}


def test_a_file_with_no_antioracle_is_left_completely_alone(tmp_path):
    rel = 'test/api/ftp.test.ts'
    tree = _tree(tmp_path, rel, REJECTION)
    info = antioracle.detect(tree, [rel])
    real, excused = antioracle.filter_regressions(rel, [_reg('GET .bak is refused')], info)
    assert [r['title'] for r in real] == ['GET .bak is refused'] and excused == []


def test_nothing_is_excused_when_the_classifier_is_unavailable(monkeypatch, tmp_path):
    """A missing exclusion costs a correct fix. A guessed one hides real damage, and
    only the second is silent -- so absence must fail toward charging."""
    monkeypatch.setattr(antioracle, '_classifier', lambda: None)
    tree = _tree(tmp_path, 'test/api/ftp.test.ts', DEPENDENT)
    info = antioracle.detect(tree, ['test/api/ftp.test.ts'])
    assert info == {'tests': {}, 'suites': {}, 'available': False}
    real, excused = antioracle.filter_regressions(
        'test/api/ftp.test.ts', [_reg('GET the .bak file for the challenge')], info)
    assert len(real) == 1 and excused == []


def test_it_flags_the_real_corpus_case_that_reverted_a_unit():
    """Pins the actual measured failure, not a synthetic stand-in."""
    tree = '/home/user/wt/patcher-base/target-apps/juice-shop-blind'
    rel = 'test/api/ftp-folder.test.ts'
    if not os.path.isfile(os.path.join(tree, rel)):
        return                                     # target tree not present here
    info = antioracle.detect(tree, [rel])
    titles = info['tests'].get(rel) or set()
    assert any('epilogue-js' in t for t in titles), titles
