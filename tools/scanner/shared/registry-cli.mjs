#!/usr/bin/env node
/**
 * Shell-facing view of the model registry.
 *
 * run.sh, diff.sh and seed-upstream.sh need to know which providers exist and
 * how to canonicalize an alias. They read models.json through this script
 * rather than hardcoding a list, so bash and TypeScript cannot disagree about
 * what a valid provider is — a disagreement whose failure mode is silent
 * (run.sh tees logs into runs/openai/ while the stage writes runs/luna/).
 *
 * Plain .mjs, no build step, no dependencies: it must run before any stage's
 * node_modules exists.
 *
 *   node registry-cli.mjs list                 -> canonical keys, space-separated
 *   node registry-cli.mjs spellings            -> keys + aliases, space-separated
 *   node registry-cli.mjs default              -> default provider key
 *   node registry-cli.mjs canonical <key>      -> canonical key, exit 1 if unknown
 *   node registry-cli.mjs model <key>          -> model id (honours env overrides)
 *   node registry-cli.mjs label <key>          -> human label
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const reg = JSON.parse(readFileSync(join(here, 'models.json'), 'utf-8'))

const canonical = (k) => reg.aliases?.[k] ?? k

function need(key, what) {
  if (key === undefined) {
    console.error(`registry-cli: ${what} requires a provider argument`)
    process.exit(2)
  }
  const c = canonical(key)
  if (!reg.targets[c]) {
    console.error(
      `registry-cli: unknown provider "${key}". Expected one of: ` +
        [...Object.keys(reg.targets), ...Object.keys(reg.aliases ?? {})].sort().join(', '),
    )
    process.exit(1)
  }
  return c
}

const [cmd, arg] = process.argv.slice(2)

switch (cmd) {
  case 'list':
    console.log(Object.keys(reg.targets).sort().join(' '))
    break
  case 'spellings':
    console.log(
      [...Object.keys(reg.targets), ...Object.keys(reg.aliases ?? {})].sort().join(' '),
    )
    break
  case 'default':
    console.log(reg.default_provider)
    break
  case 'canonical':
    console.log(need(arg, 'canonical'))
    break
  case 'model': {
    const t = reg.targets[need(arg, 'model')]
    console.log(process.env[t.model_env] ?? process.env.SCANNER_MODEL ?? t.model)
    break
  }
  case 'label':
    console.log(reg.targets[need(arg, 'label')].label)
    break
  default:
    console.error(
      'usage: registry-cli.mjs <list|spellings|default|canonical|model|label> [provider]',
    )
    process.exit(2)
}
