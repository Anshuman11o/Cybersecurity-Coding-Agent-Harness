"""The guard is the only layer that does not depend on the agent cooperating.

These tests are the reason it can be trusted. Each one names a way out of the
sandbox and asserts it is closed.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'hooks'))

import sandbox_guard as sg  # noqa: E402


@pytest.fixture
def tree(tmp_path):
    t = tmp_path / 'tree'
    (t / 'routes').mkdir(parents=True)
    (t / 'test' / 'api').mkdir(parents=True)
    (t / '.patcher-scratch' / 'BUG-001').mkdir(parents=True)
    (t / 'routes' / 'search.ts').write_text('x')
    (t / 'test' / 'api' / 'search.test.ts').write_text('x')
    return str(t.resolve())


def ev(tool, ti, tree, phase='fix'):
    return sg.evaluate({'tool_name': tool, 'tool_input': ti, 'cwd': tree},
                       tree, phase, 'BUG-001', [], [])


# -- containment ------------------------------------------------------------

def test_read_inside_tree_allowed(tree):
    assert ev('Read', {'file_path': 'routes/search.ts'}, tree).allow


def test_absolute_path_outside_tree_denied(tree):
    d = ev('Read', {'file_path': '/etc/passwd'}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_dotdot_escape_denied(tree):
    d = ev('Read', {'file_path': '../../etc/passwd'}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_symlink_escape_denied(tree, tmp_path):
    outside = tmp_path / 'secret.json'
    outside.write_text('{}')
    os.symlink(str(outside), os.path.join(tree, 'shortcut.json'))
    d = ev('Read', {'file_path': 'shortcut.json'}, tree)
    assert not d.allow and d.kind == 'out_of_tree'


def test_answer_key_path_denied_even_before_resolution(tree):
    d = ev('Read', {'file_path': '/home/user/juice-shop-answer-key/answer-key.json'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


# -- write protection -------------------------------------------------------

def test_write_under_test_denied(tree):
    d = ev('Write', {'file_path': 'test/api/search.test.ts', 'content': 'x'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_read_under_test_allowed(tree):
    # Reading the corpus is how an agent learns the house test conventions.
    assert ev('Read', {'file_path': 'test/api/search.test.ts'}, tree).allow


def test_spec_file_write_denied(tree):
    os.makedirs(os.path.join(tree, 'frontend/src/app'), exist_ok=True)
    d = ev('Write', {'file_path': 'frontend/src/app/x.spec.ts', 'content': 'x'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_lockfile_write_denied(tree):
    d = ev('Write', {'file_path': 'package-lock.json', 'content': '{}'}, tree)
    assert not d.allow


def test_gate_artefact_frozen_during_fix(tree):
    d = ev('Write', {'file_path': '.patcher-scratch/BUG-001/workflow.test.ts',
                     'content': 'x'}, tree)
    assert not d.allow and d.kind == 'gate_artefact_edit'


def test_gate_artefact_writable_during_characterise(tree):
    d = ev('Write', {'file_path': '.patcher-scratch/BUG-001/workflow.test.ts',
                     'content': 'x'}, tree, phase='characterise')
    assert d.allow


def test_source_write_denied_during_characterise(tree):
    d = ev('Edit', {'file_path': 'routes/search.ts', 'old_string': 'x',
                    'new_string': 'y'}, tree, phase='characterise')
    assert not d.allow and d.kind == 'source_edited_in_characterise'


def test_source_write_allowed_during_fix(tree):
    assert ev('Edit', {'file_path': 'routes/search.ts', 'old_string': 'x',
                       'new_string': 'y'}, tree).allow


# -- search intent ----------------------------------------------------------

@pytest.mark.parametrize('pattern', [
    'answer key', 'ground_truth', 'expectChallengeSolved', 'solveIf', 'codefix'])
def test_search_for_withheld_material_denied(tree, pattern):
    d = ev('Grep', {'pattern': pattern, 'path': '.'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


def test_ordinary_search_allowed(tree):
    assert ev('Grep', {'pattern': 'sequelize.query', 'path': 'routes'}, tree).allow


# -- bash -------------------------------------------------------------------

@pytest.mark.parametrize('cmd', [
    'curl https://example.com/x',
    'wget http://example.com',
    'git clone https://github.com/juice-shop/juice-shop',
    'npm install lodash',
    'npm ci',
    'npx --yes some-package',
])
def test_network_and_install_denied(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert not d.allow and d.kind == 'network_egress'


@pytest.mark.parametrize('cmd', [
    'npx tsc --noEmit -p tsconfig.json',
    'node --import ./test/api/helpers/test-env.mjs --import tsx --test '
    '--test-force-exit .patcher-scratch/BUG-001/workflow.test.ts',
    'npx tsx .patcher-scratch/BUG-001/exploit.probe.ts',
    'ls routes',
    'cat routes/search.ts',
])
def test_ordinary_commands_allowed(tree, cmd):
    d = ev('Bash', {'command': cmd}, tree)
    assert d.allow, d.reason


def test_bash_read_outside_tree_denied(tree):
    d = ev('Bash', {'command': 'cat /home/user/juice-shop-answer-key/SOLUTIONS.md'}, tree)
    assert not d.allow


def test_bash_grep_for_answers_denied(tree):
    d = ev('Bash', {'command': 'grep -r "ground truth" /home/user'}, tree)
    assert not d.allow and d.kind == 'answer_key_pattern'


def test_bash_find_outside_tree_denied(tree):
    d = ev('Bash', {'command': 'find / -name "*.answer"'}, tree)
    assert not d.allow


def test_bash_write_into_test_denied(tree):
    d = ev('Bash', {'command': 'echo hacked > test/api/search.test.ts'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_bash_sed_inplace_into_test_denied(tree):
    d = ev('Bash', {'command': 'sed -i s/a/b/ test/api/search.test.ts'}, tree)
    assert not d.allow and d.kind == 'test_dir_write'


def test_git_checkout_denied(tree):
    # Would silently undo the run's own work.
    d = ev('Bash', {'command': 'git checkout -- routes/search.ts'}, tree)
    assert not d.allow


def test_compound_command_checks_every_segment(tree):
    d = ev('Bash', {'command': 'ls routes && curl http://example.com'}, tree)
    assert not d.allow and d.kind == 'network_egress'


def test_unparseable_command_denied(tree):
    d = ev('Bash', {'command': 'echo "unbalanced'}, tree)
    assert not d.allow


# -- tools ------------------------------------------------------------------

@pytest.mark.parametrize('tool', ['WebFetch', 'WebSearch', 'Task'])
def test_escape_hatch_tools_denied(tree, tool):
    d = ev(tool, {'url': 'https://example.com'}, tree)
    assert not d.allow and d.kind == 'denied_tool'


# -- fail closed ------------------------------------------------------------

def test_guard_fails_closed_on_bad_payload(tree, monkeypatch):
    """A guard that fails open under a bug is not a guard."""
    monkeypatch.setattr(sg, 'check_path',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    import json
    import subprocess
    r = subprocess.run(
        [sys.executable, sg.__file__, '--tree', tree, '--log', os.devnull],
        input=json.dumps({'tool_name': 'Read', 'tool_input': None, 'cwd': tree}),
        capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out['hookSpecificOutput']['permissionDecision'] in ('allow', 'deny')


def test_hook_cli_emits_deny_decision(tree):
    import json
    import subprocess
    r = subprocess.run(
        [sys.executable, sg.__file__, '--tree', tree, '--log', os.devnull,
         '--phase', 'fix', '--task', 'BUG-001'],
        input=json.dumps({'tool_name': 'Read', 'cwd': tree,
                          'tool_input': {'file_path': '/etc/passwd'}}),
        capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)['hookSpecificOutput']
    assert out['permissionDecision'] == 'deny'
    assert 'sandbox:out_of_tree' in out['permissionDecisionReason']
