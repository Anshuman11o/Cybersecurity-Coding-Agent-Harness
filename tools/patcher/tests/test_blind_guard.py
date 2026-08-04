"""The inputs must not carry the answers.

A runtime hook cannot help here: material embedded in the bug report reaches the
model inside the prompt, before any tool call exists to intercept.
"""
import json

import pytest

import blind_guard


def _bug_report(**over):
    doc = {
        'report_id': 'r1',
        'kind': 'bug-report-agent',
        'visibility': 'BLIND -- safe to place in a worktree and a prompt',
        'target_dir': 'target-apps/juice-shop-blind',
        'bug_count': 1,
        'bugs': [{
            'bug_id': 'BUG-001',
            'location': {'file': 'routes/search.ts', 'line': 19},
            'owasp': [{'code': 'A03', 'title': 'Injection'}],
            'class': 'Injection / SQL',
            'vulnerability': 'User input is concatenated into a SQL string.',
            'reproduction': 'Send a crafted q parameter to the search endpoint.',
        }],
    }
    doc.update(over)
    return doc


def _playbook(**over):
    doc = {
        'playbook_id': 'pb1',
        'entries': [{
            'entry_id': 'a03-injection',
            'title': 'Injection',
            'owasp_codes': ['A03'],
            'classes': ['Injection / SQL'],
            'guidance': 'Parameterise every query. Never concatenate user input.',
            'preserve': ['Search must still return matching products.'],
        }],
    }
    doc.update(over)
    return doc


def write(tmp_path, name, doc):
    p = tmp_path / name
    p.write_text(json.dumps(doc))
    return str(p)


# -- happy path -------------------------------------------------------------

def test_clean_inputs_load(tmp_path):
    doc, rep = blind_guard.load_bug_report(write(tmp_path, 'b.json', _bug_report()))
    assert rep.clean and len(doc['bugs']) == 1
    pb, prep = blind_guard.load_playbook(write(tmp_path, 'p.json', _playbook()))
    assert prep.clean and len(pb['entries']) == 1


# -- key stripping ----------------------------------------------------------

def test_challenge_key_is_stripped_not_dispatched(tmp_path):
    """A stray key can be removed and recorded; the run stays valid but loud."""
    br = _bug_report()
    br['bugs'][0]['challenge_key'] = 'unionSqlInjectionChallenge'
    doc, rep = blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    assert 'challenge_key' not in doc['bugs'][0]
    assert any('challenge_key' in k for k in rep.keys_stripped)
    assert not rep.clean


def test_reference_fix_is_stripped(tmp_path):
    br = _bug_report()
    br['bugs'][0]['reference_correct_fix'] = 'use replacements'
    doc, rep = blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    assert 'reference_correct_fix' not in doc['bugs'][0]
    assert rep.keys_stripped


def test_nested_forbidden_key_is_reached(tmp_path):
    br = _bug_report()
    br['bugs'][0]['notes'] = 'fine'
    br['extra'] = {'deep': [{'oracles': ['x']}]}
    doc, rep = blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    assert any('oracles' in k for k in rep.keys_stripped)


# -- value patterns: not repairable, so the run stops ------------------------

@pytest.mark.parametrize('text', [
    'see /home/user/juice-shop-answer-key/SOLUTIONS.md',
    'the ground truth says line 19',
    'compare against benchmark_ground_truth',
    'the fix is in codefixes/searchChallenge_correct.ts',
])
def test_withheld_string_in_prose_fails_the_run(tmp_path, text):
    br = _bug_report()
    br['bugs'][0]['vulnerability'] = text
    with pytest.raises(blind_guard.BlindBoundaryError):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_playbook_challenge_key_is_stripped(tmp_path):
    pb = _playbook()
    pb['entries'][0]['challenge_key'] = 'redirectChallenge'
    doc, rep = blind_guard.load_playbook(write(tmp_path, 'p.json', pb))
    assert 'challenge_key' not in doc['entries'][0]
    assert rep.keys_stripped


# -- structural validation --------------------------------------------------

def test_visibility_must_declare_blind(tmp_path):
    br = _bug_report(visibility='SIGHTED')
    with pytest.raises(ValueError, match='BLIND'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_bug_count_drift_is_caught(tmp_path):
    """A silent count drift has cost this project a run before."""
    br = _bug_report(bug_count=7)
    with pytest.raises(ValueError, match='bug_count'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_duplicate_bug_ids_rejected(tmp_path):
    br = _bug_report()
    br['bugs'].append(dict(br['bugs'][0]))
    br['bug_count'] = 2
    with pytest.raises(ValueError, match='duplicate'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_path_escaping_target_rejected(tmp_path):
    br = _bug_report()
    br['bugs'][0]['location']['file'] = '../../../etc/passwd'
    with pytest.raises(ValueError, match='target-relative'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_target_prefix_must_be_stripped_once(tmp_path):
    br = _bug_report()
    br['bugs'][0]['location']['file'] = 'target-apps/juice-shop-blind/routes/search.ts'
    with pytest.raises(ValueError, match='prefix'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_blanket_category_tagging_rejected(tmp_path):
    """A finding tagged with everything tells the agent nothing."""
    br = _bug_report()
    br['bugs'][0]['owasp'] = [{'code': c} for c in ('A01', 'A02', 'A03', 'A04')]
    with pytest.raises(ValueError, match='Cap is 3'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_playbook_entry_without_guidance_rejected(tmp_path):
    pb = _playbook()
    pb['entries'][0]['guidance'] = '   '
    with pytest.raises(ValueError, match='guidance'):
        blind_guard.load_playbook(write(tmp_path, 'p.json', pb))


# -- selection --------------------------------------------------------------

def test_entry_selection_precedence():
    pb = _playbook()
    pb['entries'].append({'entry_id': 'pinned', 'guidance': 'g',
                          'applies_to_bug_ids': ['BUG-001']})
    bug = _bug_report()['bugs'][0]
    entry, how = blind_guard.select_entry(pb, bug)
    assert entry['entry_id'] == 'pinned' and how == 'bug_id'


def test_entry_selection_falls_back_to_code():
    pb = {'playbook_id': 'p', 'entries': [
        {'entry_id': 'by-code', 'owasp_codes': ['A03'], 'guidance': 'g'}]}
    entry, how = blind_guard.select_entry(pb, _bug_report()['bugs'][0])
    assert entry['entry_id'] == 'by-code' and how == 'owasp_code'


def test_unmatched_entry_is_reported_not_faked():
    pb = {'playbook_id': 'p', 'entries': [
        {'entry_id': 'other', 'owasp_codes': ['A07'], 'guidance': 'g'}]}
    entry, how = blind_guard.select_entry(pb, _bug_report()['bugs'][0])
    assert entry is None and how == 'unmatched'


# -- audit ------------------------------------------------------------------

def test_missing_guard_log_is_treated_as_contamination(tmp_path):
    """Absence of evidence is not evidence the boundary held."""
    audit = blind_guard.audit_run(str(tmp_path / 'nope.jsonl'))
    assert audit['contaminated']


def test_unenforced_runtime_is_flagged_but_not_contamination(tmp_path):
    """A fake runtime has no hook to leave a log. That is a different fact from
    a boundary that existed and was crossed, and it must not be silent."""
    audit = blind_guard.audit_run(str(tmp_path / 'nope.jsonl'), runtime_enforced=False)
    assert not audit['contaminated']
    assert audit['runtime_enforced'] is False
    assert any('sandbox-enforced' in n.lower() for n in audit['notes'])


def test_answer_key_denial_contaminates(tmp_path):
    log = tmp_path / 'guard.jsonl'
    log.write_text(json.dumps({'allowed': False, 'kind': 'answer_key_pattern',
                               'reason': 'searched for solutions',
                               'task': 'BUG-001', 'phase': 'fix'}) + '\n')
    audit = blind_guard.audit_run(str(log))
    assert audit['contaminated']
    assert audit['runtime_denials']['answer_key_pattern'] == 1


def test_test_dir_denial_does_not_contaminate(tmp_path):
    """A blocked test edit is the guard working on an honesty rule, not a leak."""
    log = tmp_path / 'guard.jsonl'
    log.write_text(json.dumps({'allowed': False, 'kind': 'test_dir_write',
                               'reason': 'x', 'task': 'BUG-001', 'phase': 'fix'}) + '\n')
    audit = blind_guard.audit_run(str(log))
    assert not audit['contaminated']
    assert audit['runtime_denials']['test_dir_write'] == 1
