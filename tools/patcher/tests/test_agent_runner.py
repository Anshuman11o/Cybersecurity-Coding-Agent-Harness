"""Effort and reasoning reach the runtime, and a bad value never reaches it.

These exist because the two failure modes here are asymmetric and only one of
them is loud. `--thinking bogus` exits 1 and nothing runs. `--effort bogus`
prints a warning to stderr and runs at the DEFAULT effort with exit 0 -- and the
runner reads only the JSON on stdout, so that warning is discarded. The quiet
failure is a full-price run that reports itself as high effort while having been
anything but, which is precisely the kind of infrastructure event this project
refuses to let read as a reasoning result later.

No network and no real CLI invocation: everything asserted here is the argv the
runner would hand to subprocess, which is the thing that actually carries the
setting.
"""
import json
import os

import pytest

import agent


def _cfg(**agent_keys):
    return {'agent': {'runner': 'claude-cli', 'model': 'opus', **agent_keys}}


def _runner(tmp_path, **agent_keys):
    return agent.ClaudeCliRunner(_cfg(**agent_keys), str(tmp_path / 'sandbox'))


def _argv(tmp_path, **agent_keys):
    return _runner(tmp_path, **agent_keys)._argv(str(tmp_path / 's.json'),
                                                 str(tmp_path))


def _flag(argv, name):
    """The value following `name`, or None. Positional so an accidental
    reordering of _argv cannot make an assertion pass by coincidence."""
    return argv[argv.index(name) + 1] if name in argv else None


# -- the flags are actually on the command line -------------------------------

def test_argv_carries_effort_and_reasoning(tmp_path):
    argv = _argv(tmp_path, effort='high', reasoning=True)
    assert _flag(argv, '--effort') == 'high'
    assert _flag(argv, '--thinking') == 'enabled'


def test_argv_still_carries_everything_it_did_before(tmp_path):
    """The new flags are additions. Nothing that was load-bearing may have been
    displaced -- --settings in particular carries the sandbox hook."""
    argv = _argv(tmp_path, effort='high')
    assert argv[:4] == ['claude', '-p', '--output-format', 'json']
    assert _flag(argv, '--model') == 'opus'
    assert _flag(argv, '--permission-mode') == 'acceptEdits'
    assert _flag(argv, '--settings') == str(tmp_path / 's.json')
    assert _flag(argv, '--max-turns') == '120'
    assert _flag(argv, '--add-dir') == str(tmp_path)
    assert argv[-6:] == ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']


# -- defaults apply when the key is absent ------------------------------------

def test_effort_defaults_to_high_when_key_absent(tmp_path):
    """An existing config, written before these knobs existed, gets high effort
    without being edited."""
    argv = _argv(tmp_path)
    assert _flag(argv, '--effort') == 'high'


def test_reasoning_defaults_to_on_when_key_absent(tmp_path):
    argv = _argv(tmp_path)
    assert _flag(argv, '--thinking') == 'enabled'


def test_absent_agent_block_entirely_still_defaults(tmp_path):
    r = agent.ClaudeCliRunner({}, str(tmp_path / 'sandbox'))
    assert (r.effort, r.reasoning) == ('high', 'enabled')


# -- an explicit value overrides the default ----------------------------------

@pytest.mark.parametrize('level', ['low', 'medium', 'high', 'xhigh', 'max'])
def test_explicit_effort_overrides_default(tmp_path, level):
    """The five levels are the installed CLI's own constant, not a guess:
    `claude --help` documents "low, medium, high, xhigh, max"."""
    assert _flag(_argv(tmp_path, effort=level), '--effort') == level


@pytest.mark.parametrize('value,expected', [
    (True, 'enabled'), (False, 'disabled'),
    ('enabled', 'enabled'), ('adaptive', 'adaptive'), ('disabled', 'disabled'),
    ('on', 'enabled'), ('off', 'disabled'),
])
def test_explicit_reasoning_overrides_default(tmp_path, value, expected):
    assert _flag(_argv(tmp_path, reasoning=value), '--thinking') == expected


def test_effort_value_is_case_and_space_insensitive(tmp_path):
    assert _flag(_argv(tmp_path, effort=' High '), '--effort') == 'high'


def test_reasoning_off_is_not_confused_with_absent(tmp_path):
    """`false` must reach the CLI as an explicit disable, not fall through to the
    default. A config that says reasoning off and gets reasoning on is the same
    class of silent lie as an ignored effort."""
    assert _flag(_argv(tmp_path, reasoning=False), '--thinking') == 'disabled'


# -- an invalid value is rejected, loudly, at config load ---------------------

@pytest.mark.parametrize('bad', ['bogus', 'HIGHEST', 'ultra', '', 'none', 7])
def test_invalid_effort_is_rejected(tmp_path, bad):
    with pytest.raises(ValueError) as ex:
        _runner(tmp_path, effort=bad)
    assert 'effort' in str(ex.value)


@pytest.mark.parametrize('bad', ['bogus', 'high', 'maybe', ''])
def test_invalid_reasoning_is_rejected(tmp_path, bad):
    with pytest.raises(ValueError) as ex:
        _runner(tmp_path, reasoning=bad)
    assert 'reasoning' in str(ex.value)


def test_invalid_effort_message_names_the_silent_failure(tmp_path):
    """Whoever reads this error is about to launch an hour-long paid run. The
    message has to say why a typo is not self-correcting."""
    with pytest.raises(ValueError) as ex:
        _runner(tmp_path, effort='bogus')
    msg = str(ex.value)
    assert 'low, medium, high, xhigh, max' in msg
    assert 'default' in msg


def test_bad_value_fails_at_config_load_not_first_invocation(tmp_path):
    """build_runner is the config-load gate, in the spirit of --check: it runs
    before the loop, so the failure costs nothing."""
    with pytest.raises(ValueError):
        agent.build_runner(_cfg(effort='bogus'), str(tmp_path / 'sb'))


def test_bad_value_is_rejected_for_the_fake_runner_too(tmp_path):
    """A rehearsal on `fake` is how a config gets checked before it is paid for.
    Letting a typo survive that rehearsal defeats the point of rehearsing."""
    cfg = {'agent': {'runner': 'fake', 'effort': 'bogus'}}
    with pytest.raises(ValueError):
        agent.build_runner(cfg, str(tmp_path / 'sb'))


def test_validate_agent_settings_returns_the_resolved_pair():
    assert agent.validate_agent_settings({}) == {'effort': 'high',
                                                 'reasoning': 'enabled'}
    assert agent.validate_agent_settings(
        {'agent': {'effort': 'max', 'reasoning': False}}) == {
            'effort': 'max', 'reasoning': 'disabled'}


# -- describe() reports what was used ----------------------------------------

def test_describe_reports_effort_and_reasoning(tmp_path):
    """describe() feeds the report's agent_desc. The runtime's result JSON has no
    effort field, so if describe() does not carry it, nothing does."""
    d = _runner(tmp_path, effort='xhigh', reasoning=False).describe()
    assert d['effort'] == 'xhigh'
    assert d['reasoning'] == 'disabled'


def test_describe_reports_the_defaults_when_keys_absent(tmp_path):
    d = _runner(tmp_path).describe()
    assert d['effort'] == 'high'
    assert d['reasoning'] == 'enabled'


def test_describe_reports_what_argv_carries(tmp_path):
    """The report and the command line must not be able to disagree."""
    r = _runner(tmp_path, effort='low', reasoning='adaptive')
    argv = r._argv(str(tmp_path / 's.json'), str(tmp_path))
    d = r.describe()
    assert _flag(argv, '--effort') == d['effort']
    assert _flag(argv, '--thinking') == d['reasoning']


def test_describe_keeps_the_fields_it_already_had(tmp_path):
    d = _runner(tmp_path).describe()
    assert d['runner'] == 'claude-cli'
    assert d['model'] == 'opus'
    assert d['max_turns'] == 120


# -- the shipped configs say what they run at ---------------------------------

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'config')


@pytest.mark.parametrize('name', ['run-config.example.json',
                                  'subset4.run-config.json'])
def test_shipped_configs_state_effort_and_reasoning_explicitly(name):
    """subset4's numbers get compared across runs. A config that leans on a
    default records what the default was, not what the run ran at."""
    with open(os.path.join(CONFIG_DIR, name)) as fh:
        cfg = json.load(fh)
    assert cfg['agent']['effort'] == 'high'
    assert cfg['agent']['reasoning'] is True
    # and they are values the runner will actually accept
    assert agent.validate_agent_settings(cfg) == {'effort': 'high',
                                                  'reasoning': 'enabled'}
