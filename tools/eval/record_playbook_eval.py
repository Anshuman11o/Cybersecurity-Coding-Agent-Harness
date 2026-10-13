#!/usr/bin/env python3
"""Append one playbook-agent evaluation to results/eval-history/playbook-agent.jsonl.

A playbook-agent eval runs Stage 0 recon and the playbook agent on a held-out
target and scores the agent's final class set with that target's private
answer-key scorer (`score.py --level combined`). This writes the aggregate half:
counts, rates, cost and identity. The scorer's class-by-class matches stay in
the answer-key repo, which is where `--located-detail-at` points.

    python3 tools/eval/record_playbook_eval.py \\
        --run-dir <target>/.secscan/runs/<run-id>/<provider> \\
        --score <combined-evaluation.json> \\
        --run-id playbook-<date>-<target>-<provider> \\
        --target <public repo name> \\
        --ground-truth-set "<answer key, version, commit>" \\
        --located-detail-at "<answer-key repo, path, commit>" \\
        --notes "<what happened, including cost and failure>"

The row is built from named fields only and re-checked by the same guard the
patcher archiver uses (`assert_publishable`). If it fires, rephrase the notes;
never loosen the guard. `--dry-run` prints the row without writing.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'tools', 'patcher', 'src'))
from archive_run import assert_publishable  # noqa: E402

HISTORY = os.path.join(REPO, 'results', 'eval-history', 'playbook-agent.jsonl')
# Only these keys of the scorer output are aggregate; matches/unexpected/covered/missed are not.
SCORE_KEYS = ('level', 'scope', 'ground_truth_version', 'public_commit', 'predicted_class_count',
              'true_positive_count', 'false_positive_count', 'ground_truth_class_count',
              'covered_class_count', 'false_negative_count', 'recall', 'precision')


def read_json(path):
    with open(path) as f:
        return json.load(f)


def build_row(a):
    agent_dir = os.path.join(a.run_dir, 'stage-playbook-agent')
    recon_meta = read_json(os.path.join(a.run_dir, 'stage0-recon', 'meta.json'))
    agent_meta = read_json(os.path.join(agent_dir, 'meta.json'))
    # A run whose research failed has no plan or selection, but keeps the decision it saved first.
    if os.path.exists(os.path.join(agent_dir, 'class-selection.json')):
        plan = read_json(os.path.join(agent_dir, 'playbook-plan.json'))
        selection = read_json(os.path.join(agent_dir, 'class-selection.json'))
        scored = 'class-selection.json'
    else:
        plan = selection = read_json(os.path.join(agent_dir, 'class-decision.json'))
        scored = 'class-decision.json (stage failed after the decision)'
    usage = read_json(os.path.join(agent_dir, 'usage.json'))
    score = read_json(a.score)
    with open(os.path.join(a.run_dir, 'spend-ledger.jsonl')) as f:
        ledger = [json.loads(line) for line in f if line.strip()]

    def tokens(stage):
        rows = [r for r in ledger if r.get('stage') == stage]
        u = [r.get('usage') or {} for r in rows]
        return {'calls': len(rows), 'input': sum(x.get('prompt_tokens') or 0 for x in u),
                'cached_input': sum(x.get('cached_tokens') or 0 for x in u),
                'output': sum(x.get('completion_tokens') or 0 for x in u),
                'cost_usd': round(sum(r.get('cost_usd') or 0 for r in rows), 6)}

    loop = plan.get('loop') or {'enabled': False, 'max_passes': 0, 'passes_run': 0}
    secs = lambda m: round((datetime.fromisoformat(m['ended'].replace('Z', '+00:00')) -
                            datetime.fromisoformat(m['started'].replace('Z', '+00:00'))).total_seconds())
    return {
        'run_id': a.run_id,
        'timestamp': agent_meta['ended'],
        'component': 'playbook agent (stage0-recon -> stage-playbook-agent, product profile)',
        'version': agent_meta['git_sha'],
        'target': a.target,
        'target_sha': score['public_commit'],
        'ground_truth_set': a.ground_truth_set,
        'models_used': agent_meta['model'],
        'arm': {'loop_enabled': loop['enabled'], 'loop_max_passes': loop['max_passes'],
                'turn2_passes_run': loop['passes_run'], 'turns_run': len(plan.get('turns') or [])},
        'metrics': {**{k: score[k] for k in SCORE_KEYS},
                    'builtin_selected': len(selection['builtin']), 'additional_selected': len(selection['added']),
                    'scored_artifact': scored},
        'web_search_calls': sum(c.get('web_search_calls') or 0 for c in usage['calls']),
        'tokens': {'stage0-recon': tokens('stage0-recon'), 'stage-playbook-agent': tokens('stage-playbook-agent')},
        'est_cost_usd': round(sum(r.get('cost_usd') or 0 for r in ledger), 6),
        'wall_clock_s': {'stage0-recon': secs(recon_meta), 'stage-playbook-agent': secs(agent_meta)},
        'health': {'recon_exit': recon_meta['exit_code'], 'agent_exit': agent_meta['exit_code'],
                   'blocked_reads': recon_meta['blocked_reads'] + agent_meta['blocked_reads']},
        'located_detail_at': a.located_detail_at,
        'notes': a.notes,
        'recorded_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ('--run-dir', '--score', '--run-id', '--target', '--ground-truth-set', '--located-detail-at', '--notes'):
        p.add_argument(name, required=True)
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()
    row = build_row(a)
    assert_publishable(row)
    if os.path.exists(HISTORY):
        with open(HISTORY) as f:
            if any(json.loads(l).get('run_id') == a.run_id for l in f if l.strip()):
                p.error(f'run_id {a.run_id} is already recorded; this file is append-only')
    line = json.dumps(row)
    if a.dry_run:
        print(line)
        return
    with open(HISTORY, 'a') as f:
        f.write(line + '\n')
    print(f'appended {a.run_id} to {os.path.relpath(HISTORY, REPO)}')


if __name__ == '__main__':
    main()
