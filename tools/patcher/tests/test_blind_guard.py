"""The inputs must not carry the answers.

A runtime hook cannot help here: material embedded in the bug report reaches the
model inside the prompt, before any tool call exists to intercept.
"""
import json
import os

import pytest

import blind_guard
import grouping
import prompts

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
CONTRACT = os.path.join(REPO_ROOT, 'tools/patcher/contracts/bug-report.schema.json')
SHIPPED_REPORTS = ('tools/patcher/inputs/bug-report.json',
                   'tools/patcher/inputs/subset3/bug-report.json',
                   'tools/patcher/inputs/subset4/bug-report.json')


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
    # `notes` is the last free-text field an entry may carry, so it is where a
    # withheld string would arrive now that the two prose fields are gone.
    br = _bug_report()
    br['bugs'][0]['notes'] = text
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


# -- seed denylist ----------------------------------------------------------
#
# The sandbox hook denies these files at read time. Catching them here as well
# means the run stops before a dollar is spent, and says which file and why,
# instead of dispatching a task the agent cannot possibly do.

def test_seed_denylist_comes_from_the_scanner_read_guard():
    """One source of truth, reached through the hook rather than re-copied."""
    assert set(blind_guard.SEED_DENYLIST) >= {
        'models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts'}
    assert blind_guard.SEED_DENYLIST_NOTE is None


@pytest.mark.parametrize('rel', [
    'models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts'])
def test_bug_in_denylisted_file_is_rejected(tmp_path, rel):
    br = _bug_report()
    br['bugs'][0]['location']['file'] = rel
    with pytest.raises(ValueError) as ex:
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    msg = str(ex.value)
    assert rel in msg and 'seed denylist' in msg
    assert 'read-guard.ts' in msg


def test_denylisted_file_in_scoped_files_is_rejected(tmp_path):
    br = _bug_report()
    br['scoped_files'] = ['routes/search.ts', 'data/datacreator.ts']
    with pytest.raises(ValueError, match='seed denylist'):
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))


def test_ordinary_file_is_not_mistaken_for_a_denylisted_one(tmp_path):
    br = _bug_report()
    br['bugs'][0]['location']['file'] = 'frontend/src/app/Models/challenge.model.ts'
    doc, rep = blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    assert doc['bugs'][0]['location']['file'].endswith('challenge.model.ts')


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


def test_seed_denylist_denial_is_counted_and_noted(tmp_path):
    """The read was denied, so nothing leaked and the run stands -- but an agent
    reaching for the seed files is a fact the report has to carry."""
    log = tmp_path / 'guard.jsonl'
    log.write_text(json.dumps({'allowed': False, 'kind': 'seed_denylist',
                               'reason': 'data/datacreator.ts is on the corpus '
                                         'seed denylist',
                               'task': 'BUG-001', 'phase': 'fix'}) + '\n')
    audit = blind_guard.audit_run(str(log))
    assert not audit['contaminated']
    assert audit['runtime_denials']['seed_denylist'] == 1
    assert any('seed-denylisted' in n for n in audit['notes'])


def test_test_dir_denial_does_not_contaminate(tmp_path):
    """A blocked test edit is the guard working on an honesty rule, not a leak."""
    log = tmp_path / 'guard.jsonl'
    log.write_text(json.dumps({'allowed': False, 'kind': 'test_dir_write',
                               'reason': 'x', 'task': 'BUG-001', 'phase': 'fix'}) + '\n')
    audit = blind_guard.audit_run(str(log))
    assert not audit['contaminated']
    assert audit['runtime_denials']['test_dir_write'] == 1


# -- what an entry may carry -------------------------------------------------
#
# The report localises a defect and classifies it. It used to also carry prose
# saying what was wrong and how to trigger it; both were removed from the
# contract on 2026-08-10, because the agent's own task loop already requires it
# to characterise the code path and build a probe from the source, and that
# prose did part of the work for it. The generator that produces these reports
# lives outside this repository, so the harness cannot stop it emitting the
# fields -- it can only refuse the report, loudly, before anything is spent.

def _schema_bug_errors(bug: dict) -> list:
    """The keys `definitions.bug` rejects, applying the schema's own rule.

    `jsonschema` is deliberately not a dependency here -- blind_guard is written
    out so it runs on a bare interpreter -- so the rule the contract states is
    applied directly: the object closes with additionalProperties:false, and
    anything outside its `properties` is invalid.
    """
    with open(CONTRACT) as fh:
        bug_schema = json.load(fh)['definitions']['bug']
    assert bug_schema['additionalProperties'] is False, (
        'the bug object must stay closed; an open object silently accepts '
        'whatever a future generator decides to add')
    return sorted(set(bug) - set(bug_schema['properties']))


@pytest.mark.parametrize('field', ['vulnerability', 'reproduction'])
def test_the_contract_does_not_allow_the_prose_fields(field):
    assert _schema_bug_errors({'bug_id': 'BUG-001', field: 'anything'}) == [field]


@pytest.mark.parametrize('field', ['vulnerability', 'reproduction'])
def test_prose_field_is_refused_at_preflight(tmp_path, field):
    """Refused, not stripped: a report that still emits it is a generator nobody
    has fixed, and silently trimming it would hide that from every later run."""
    br = _bug_report()
    br['bugs'][0][field] = 'a sentence describing the defect'
    with pytest.raises(ValueError) as ex:
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    msg = str(ex.value)
    assert field in msg and 'BUG-001' in msg


def test_a_renamed_carrier_for_the_same_prose_is_refused_too(tmp_path):
    """Removing two field names is not a boundary. The contract is the closed
    property list, and anything outside it fails the same way."""
    br = _bug_report()
    br['bugs'][0]['how_to_trigger'] = 'send a crafted q parameter'
    with pytest.raises(ValueError) as ex:
        blind_guard.load_bug_report(write(tmp_path, 'b.json', br))
    assert 'how_to_trigger' in str(ex.value)


def test_the_guard_reads_its_allowed_keys_from_the_contract():
    """One statement of what an entry may carry, not two that can drift."""
    allowed = blind_guard._allowed_bug_keys()
    assert {'bug_id', 'location', 'owasp', 'class', 'playbook_ref'} <= allowed
    assert not allowed & set(blind_guard.WITHHELD_BUG_KEYS)


@pytest.mark.parametrize('rel', SHIPPED_REPORTS)
def test_every_shipped_bug_report_loads_clean(rel):
    """The reports in the tree are what a run actually dispatches."""
    doc, rep = blind_guard.load_bug_report(os.path.join(REPO_ROOT, rel))
    assert rep.clean, rep.keys_stripped + rep.value_pattern_hits
    assert doc['bugs']
    for b in doc['bugs']:
        assert _schema_bug_errors(b) == []


# -- what the prompt renders -------------------------------------------------
#
# The rendered block is the only place a bug reaches the model, so the narrowing
# is only real if it holds here. Tested next to the input rules rather than in a
# module of its own: it is the same property, on the other side of the boundary.

def test_the_rendered_bug_carries_location_and_class_and_no_prose():
    bug = _bug_report()['bugs'][0]
    out = prompts._fmt_bug(bug)
    assert 'routes/search.ts' in out
    assert 'line        : 19' in out
    assert 'Injection / SQL' in out
    assert 'A03' in out and 'Injection' in out
    assert 'what is wrong' not in out
    assert 'how it is exercised' not in out


def test_prose_smuggled_past_the_guard_is_still_not_rendered():
    """_fmt_bug is called on whatever the loader returned. If a report ever
    reached it carrying the old fields, the prompt must not print them anyway."""
    bug = dict(_bug_report()['bugs'][0],
               vulnerability='concatenated into the query',
               reproduction='send a crafted q parameter')
    out = prompts._fmt_bug(bug)
    assert 'concatenated into the query' not in out
    assert 'crafted q parameter' not in out


def test_a_per_file_unit_still_renders_every_member():
    """Narrowing each entry must not cost the multi-bug unit its members: an
    agent asked to fix four defects in one file has to see all four."""
    bugs = [{'bug_id': f'BUG-{i:03d}',
             'location': {'file': 'routes/a.ts', 'line': i},
             'owasp': [{'code': 'A03'}], 'class': 'Injection / SQL'}
            for i in (1, 2, 3)]
    unit = [u for u in grouping.group(bugs, 'file') if u.get('members')][0]
    out = prompts._fmt_bug(unit)
    for b in bugs:
        assert b['bug_id'] in out
    assert out.count('--- finding') == 3
    assert 'what is wrong' not in out and 'how it is exercised' not in out
