#!/usr/bin/env python3
"""
The soft-boundary bookends: scrub the inputs before dispatch, audit the
transcripts afterwards.

`hooks/sandbox_guard.py` stops the agent reaching withheld material. This
module handles the other two directions:

  BEFORE  the inputs themselves must not carry the answers. A bug report that
          ships a reference fix, or a playbook that ships a challenge key,
          hands over the thing the run exists to measure -- and it does so in
          the prompt, where no runtime hook will ever see it. This has happened
          on the sighted side before, which is why it is checked and not
          assumed.

  AFTER   replay every guard decision and every recorded tool call, and say
          plainly whether the run stayed inside the boundary. A run that did
          not is not a worse run, it is a void one.

No dependency on `jsonschema`: the checks are written out so this can run on a
bare interpreter, and so a validation failure names the field rather than
emitting a JSON Pointer.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.join(os.path.dirname(HERE), 'contracts')

OWASP_CODE = re.compile(r'^(A(0[1-9]|10)|API(0?[1-9]|10))$')


class BlindBoundaryError(RuntimeError):
    """Raised for a violation that cannot be repaired by dropping a key.

    A stray key can be stripped and recorded. A withheld string embedded in a
    prose field cannot: removing it would silently change the meaning of the
    input, and keeping it would hand the answer over. So the run stops.
    """


@dataclass
class ScrubReport:
    source: str
    keys_stripped: list = field(default_factory=list)
    value_pattern_hits: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.keys_stripped and not self.value_pattern_hits


# ----------------------------------------------------------------------------
# Schema-driven deny sets
# ----------------------------------------------------------------------------

def _load_schema(name: str) -> dict:
    with open(os.path.join(CONTRACTS, name)) as fh:
        return json.load(fh)


def _deny_sets(schema: dict):
    keys = set(schema.get('x-forbidden-keys', {}).get('keys', []))
    pats = [re.compile(p, re.IGNORECASE)
            for p in schema.get('x-forbidden-value-patterns', {}).get('patterns', [])]
    return keys, pats


# ----------------------------------------------------------------------------
# Recursive scrub
# ----------------------------------------------------------------------------

def _walk(node: Any, path: str, forbidden_keys: set, patterns, rep: ScrubReport):
    """Strip forbidden keys in place; raise on a forbidden value."""
    if isinstance(node, dict):
        for key in list(node.keys()):
            here = f'{path}.{key}' if path else key
            if key in forbidden_keys:
                rep.keys_stripped.append(here)
                del node[key]
                continue
            _walk(node[key], here, forbidden_keys, patterns, rep)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _walk(item, f'{path}[{i}]', forbidden_keys, patterns, rep)
    elif isinstance(node, str):
        for pat in patterns:
            m = pat.search(node)
            if m:
                rep.value_pattern_hits.append(f'{path}: /{pat.pattern}/ matched {m.group(0)!r}')


def scrub(doc: dict, schema_name: str, source: str) -> ScrubReport:
    """Strip forbidden keys, collect forbidden values. Mutates `doc`."""
    keys, pats = _deny_sets(_load_schema(schema_name))
    rep = ScrubReport(source=source)
    _walk(doc, '', keys, pats, rep)
    if rep.value_pattern_hits:
        raise BlindBoundaryError(
            f'{source} carries withheld material in {len(rep.value_pattern_hits)} '
            'string value(s); this cannot be auto-repaired without changing what the '
            'input means. Fix the generator, then re-run.\n  - '
            + '\n  - '.join(rep.value_pattern_hits[:20]))
    return rep


# ----------------------------------------------------------------------------
# Structural validation
# ----------------------------------------------------------------------------

def _require(cond: bool, msg: str, errors: list):
    if not cond:
        errors.append(msg)


def validate_bug_report(doc: dict) -> list:
    e: list = []
    _require(isinstance(doc.get('report_id'), str) and doc['report_id'],
             'report_id: missing', e)
    _require(isinstance(doc.get('target_dir'), str) and doc['target_dir'],
             'target_dir: missing', e)

    vis = doc.get('visibility')
    if isinstance(vis, str) and 'BLIND' not in vis.upper():
        e.append(f'visibility: {vis!r} does not declare BLIND. Refusing to dispatch an '
                 'input that does not claim to be safe to put in a prompt.')

    bugs = doc.get('bugs')
    if not isinstance(bugs, list) or not bugs:
        e.append('bugs: must be a non-empty array')
        return e

    if isinstance(doc.get('bug_count'), int) and doc['bug_count'] != len(bugs):
        # A silent count drift has cost this project a run before.
        e.append(f'bug_count says {doc["bug_count"]}, bugs[] holds {len(bugs)}')

    seen = set()
    for i, b in enumerate(bugs):
        at = f'bugs[{i}]'
        if not isinstance(b, dict):
            e.append(f'{at}: not an object')
            continue

        bid = b.get('bug_id')
        if not isinstance(bid, str) or not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', bid or ''):
            e.append(f'{at}.bug_id: missing or not a safe identifier '
                     '(it becomes a directory name)')
        elif bid in seen:
            e.append(f'{at}.bug_id: {bid!r} is a duplicate; ids key the task records')
        else:
            seen.add(bid)

        loc = b.get('location')
        if not isinstance(loc, dict):
            e.append(f'{at}.location: missing')
        else:
            f = loc.get('file')
            if not isinstance(f, str) or not f:
                e.append(f'{at}.location.file: missing')
            elif os.path.isabs(f) or '..' in f.split('/'):
                e.append(f'{at}.location.file: {f!r} must be target-relative and must '
                         'not escape the target directory')
            elif f.startswith(str(doc.get('target_dir', '\0'))):
                e.append(f'{at}.location.file: {f!r} still carries the target_dir '
                         'prefix; strip it once, here, not in every consumer')
            if not isinstance(loc.get('line'), int) or loc.get('line', 0) < 1:
                e.append(f'{at}.location.line: missing or not a positive integer')

        owasp = b.get('owasp')
        if not isinstance(owasp, list) or not owasp:
            e.append(f'{at}.owasp: missing; the agent cannot select guidance without a class')
        elif len(owasp) > 3:
            # A hard cap turns an upstream blanket-category defect into a loud
            # failure instead of a silent one.
            e.append(f'{at}.owasp: {len(owasp)} codes. Cap is 3 -- a finding tagged with '
                     'everything tells the agent nothing.')
        else:
            for j, o in enumerate(owasp):
                code = o.get('code') if isinstance(o, dict) else None
                if not isinstance(code, str) or not OWASP_CODE.match(code):
                    e.append(f'{at}.owasp[{j}].code: {code!r} is not an OWASP Top 10:2021 '
                             'or API Security Top 10:2023 code')

        if not isinstance(b.get('class'), str) or not b.get('class'):
            e.append(f'{at}.class: missing')

    return e


def validate_playbook(doc: dict) -> list:
    e: list = []
    _require(isinstance(doc.get('playbook_id'), str) and doc['playbook_id'],
             'playbook_id: missing', e)
    entries = doc.get('entries')
    if not isinstance(entries, list) or not entries:
        e.append('entries: must be a non-empty array')
        return e
    seen = set()
    for i, en in enumerate(entries):
        at = f'entries[{i}]'
        if not isinstance(en, dict):
            e.append(f'{at}: not an object')
            continue
        eid = en.get('entry_id')
        if not isinstance(eid, str) or not eid:
            e.append(f'{at}.entry_id: missing')
        elif eid in seen:
            e.append(f'{at}.entry_id: {eid!r} is a duplicate')
        else:
            seen.add(eid)
        if not isinstance(en.get('guidance'), str) or not en.get('guidance', '').strip():
            e.append(f'{at}.guidance: missing or empty; an entry with no guidance is a '
                     'reference the agent cannot fetch, not guidance')
        for code in en.get('owasp_codes') or []:
            if not OWASP_CODE.match(str(code)):
                e.append(f'{at}.owasp_codes: {code!r} is not a valid code')
    return e


# ----------------------------------------------------------------------------
# Public loaders
# ----------------------------------------------------------------------------

def load_bug_report(path: str):
    with open(path) as fh:
        doc = json.load(fh)
    rep = scrub(doc, 'bug-report.schema.json', f'bug report ({os.path.basename(path)})')
    errors = validate_bug_report(doc)
    if errors:
        raise ValueError('bug report is not usable:\n  - ' + '\n  - '.join(errors))

    declared = set(doc.get('scoped_files') or [])
    derived = {b['location']['file'] for b in doc['bugs']}
    if declared and declared != derived:
        rep.warnings.append(
            f'scoped_files disagrees with bugs[]: {len(declared ^ derived)} file(s) '
            'differ. Using the set derived from bugs[]; scoped_files is advisory.')
    return doc, rep


def load_playbook(path: str):
    with open(path) as fh:
        doc = json.load(fh)
    rep = scrub(doc, 'playbook.schema.json', f'playbook ({os.path.basename(path)})')
    errors = validate_playbook(doc)
    if errors:
        raise ValueError('playbook is not usable:\n  - ' + '\n  - '.join(errors))
    if doc.get('content_status'):
        # A thin playbook must not later be read as a weak model.
        rep.warnings.append(f'playbook declares content_status: {doc["content_status"]!r}. '
                            'Carry this next to every number the run produces.')
    return doc, rep


def _merge_entries(playbook: dict, members: list):
    """Merge the distinct entries matching a per-file unit's members.

    Deduplicated by entry_id and kept in first-match order, so a unit whose
    findings share a class gets that class's guidance exactly once. Returns
    (entry|None, how) with the same contract as select_entry.
    """
    picked, hows = [], []
    for m in members:
        en, how = select_entry(playbook, m)
        if en is None:
            continue
        if any(e.get('entry_id') == en.get('entry_id') for e in picked):
            continue
        picked.append(en)
        hows.append(how)
    if not picked:
        return None, 'no_match'
    if len(picked) == 1:
        return picked[0], hows[0] + '+unit'

    def union(field):
        out = []
        for e in picked:
            for v in e.get(field) or []:
                if v not in out:
                    out.append(v)
        return out

    # Entries cite overlapping documents -- three of the classes in one file all
    # cite A05:2021 -- so merging naively repeats whole cheat sheets verbatim.
    # Measured on the 8-bug server.ts unit: 24KB of a 59KB prompt was the same
    # document three times. Sections are keyed by their source URL and emitted
    # once; a class whose documents were all already shown still gets its banner
    # and a pointer, so the agent knows the class was considered.
    seen_docs: set = set()
    guidance = []
    for e in picked:
        banner = f"## {e.get('title') or e.get('entry_id')}"
        body = e.get('guidance') or ''
        sections = re.split(r'(?m)^(?=### From )', body)
        keep, skipped = [], []
        for sec in sections:
            if not sec.strip():
                continue
            m = re.match(r'### From (\S+)', sec)
            key = m.group(1) if m else sec[:200]
            if key in seen_docs:
                skipped.append(key)
                continue
            seen_docs.add(key)
            keep.append(sec.rstrip())
        if keep:
            guidance.append(banner + '\n\n' + '\n\n'.join(keep))
        else:
            guidance.append(banner + '\n\n(Guidance for this class is the '
                            'document already quoted above.)')
    return {
        'entry_id': '+'.join(e.get('entry_id', '?') for e in picked),
        'title': f'{len(picked)} vulnerability classes in this file',
        'classes': union('classes'),
        'owasp_codes': union('owasp_codes'),
        'guidance': '\n\n---\n\n'.join(guidance),
        'principles': union('principles'),
        'common_mistakes': union('common_mistakes'),
        'preserve': union('preserve'),
        'reference_url': picked[0].get('reference_url'),
        'content_retrieved': all(e.get('content_retrieved') for e in picked),
    }, 'unit_merge(' + ','.join(sorted(set(hows))) + ')'


def select_entry(playbook: dict, bug: dict):
    """Pick one playbook entry for a bug. Returns (entry|None, how).

    Order: explicit bug pin, then class, then OWASP code. First match wins, and
    the resolution used is recorded per task so a thin section can be traced back
    to why it was thin.

    A per-file unit carries `members` and usually spans several classes, so one
    entry cannot cover it. Picking the first member's entry would hand the agent
    guidance for one finding and silence for the rest, which is worse than a thin
    section because it looks complete. Those get a merged entry instead.
    """
    if bug.get('members'):
        return _merge_entries(playbook, bug['members'])

    entries = playbook.get('entries') or []
    bid = bug.get('bug_id')
    for en in entries:
        if bid and bid in (en.get('applies_to_bug_ids') or []):
            return en, 'bug_id'
    bclass = (bug.get('class') or '').strip().lower()
    if bclass:
        for en in entries:
            if any(bclass == str(c).strip().lower() for c in en.get('classes') or []):
                return en, 'class_exact'
        for en in entries:
            for c in en.get('classes') or []:
                c = str(c).strip().lower()
                if c and (c in bclass or bclass in c):
                    return en, 'class_partial'
    codes = {o.get('code') for o in bug.get('owasp') or [] if isinstance(o, dict)}
    for en in entries:
        if codes & set(en.get('owasp_codes') or []):
            return en, 'owasp_code'
    return None, 'unmatched'


# ----------------------------------------------------------------------------
# Post-run audit
# ----------------------------------------------------------------------------

CONTAMINATING_KINDS = {'answer_key_pattern', 'out_of_tree'}

_AUDIT_COUNTER_KEYS = ('out_of_tree', 'test_dir_write', 'gate_artefact_edit',
                       'network_egress', 'answer_key_pattern')


def audit_run(guard_log: str, scrub_reports=(), extra_notes=(), *,
              runtime_enforced: bool = True) -> dict:
    """Replay the guard log and produce the report's `blind_audit` block.

    Contamination is deliberately narrow. A denied write under `test/` means the
    guard did its job on a rule about honest patching; a denied *read* of an
    answer-key path means the agent went looking for the answers, and that is a
    different fact about the run.

    `runtime_enforced=False` is for a runtime that has no sandbox to enforce --
    the fake runner. A missing guard log is then expected rather than damning,
    but the run is still marked as unenforced, because a mechanism test must
    never be mistaken later for a measurement.
    """
    counters = {k: 0 for k in _AUDIT_COUNTER_KEYS}
    counters['total'] = 0
    notes = list(extra_notes)
    contaminated = False

    if not runtime_enforced:
        notes.append('runtime was NOT sandbox-enforced (no hook-bearing runtime). This '
                     'run exercises the loop; it does not measure a patcher, and its '
                     'numbers must not be quoted as one.')
    elif os.path.exists(guard_log):
        with open(guard_log) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    notes.append('guard log holds an unparseable line; audit is '
                                 'incomplete and this run should not be quoted')
                    contaminated = True
                    continue
                if rec.get('allowed'):
                    continue
                kind = rec.get('kind') or 'other'
                counters['total'] += 1
                if kind in counters:
                    counters[kind] += 1
                if kind in CONTAMINATING_KINDS:
                    contaminated = True
                    notes.append(
                        f"[{rec.get('task') or '-'}/{rec.get('phase') or '-'}] "
                        f"{kind}: {(rec.get('reason') or '')[:200]}")
    else:
        notes.append(f'guard log {guard_log} is missing. The runtime boundary cannot '
                     'be shown to have held, so it is treated as though it did not.')
        contaminated = True

    scrub_block = {
        'bug_report_clean': True,
        'playbook_clean': True,
        'keys_stripped': [],
        'value_pattern_hits': [],
    }
    for rep in scrub_reports:
        key = 'bug_report_clean' if 'bug report' in rep.source else 'playbook_clean'
        scrub_block[key] = scrub_block[key] and rep.clean
        scrub_block['keys_stripped'] += [f'{rep.source}: {k}' for k in rep.keys_stripped]
        scrub_block['value_pattern_hits'] += [f'{rep.source}: {h}'
                                              for h in rep.value_pattern_hits]
        notes += [f'{rep.source}: {w}' for w in rep.warnings]

    if scrub_block['keys_stripped']:
        notes.append(
            f"{len(scrub_block['keys_stripped'])} withheld key(s) were stripped from the "
            'inputs before dispatch. The run is valid, but the generator that produced '
            'those inputs is emitting material it should not.')

    return {
        'contaminated': contaminated,
        'runtime_enforced': bool(runtime_enforced),
        'input_scrub': scrub_block,
        'runtime_denials': counters,
        'notes': notes[:200],
    }
