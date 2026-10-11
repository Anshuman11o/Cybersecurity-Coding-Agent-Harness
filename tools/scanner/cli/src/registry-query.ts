/**
 * run.sh's fallback for models that shared/registry-cli.mjs cannot see: those
 * added by a user overlay (SCANNER_MODELS_FILE) or the generic endpoint. Same
 * commands and output as registry-cli.mjs, answered by shared/models.ts — the
 * loader every stage uses — so bash and the stages agree on every key.
 *
 *   tsx registry-query.ts <list|spellings|default|canonical|model|label> [key]
 */
export {}

const [cmd, arg] = process.argv.slice(2)

try {
  const models = await import('../../shared/models.js')
  const provider = await import('../../shared/provider.js')
  const need = () => {
    if (arg === undefined) {
      console.error(`registry-query: ${cmd} requires a provider argument`)
      process.exit(2)
    }
    if (!models.isProvider(arg)) {
      console.error(
        `registry-query: unknown provider "${arg}". Expected one of: ${models.listProviderSpellings().join(', ')}`,
      )
      process.exit(1)
    }
    return models.canonicalize(arg)
  }
  switch (cmd) {
    case 'list': console.log(models.listProviders().join(' ')); break
    case 'spellings': console.log(models.listProviderSpellings().join(' ')); break
    case 'default': console.log(models.defaultProvider()); break
    case 'canonical': console.log(need()); break
    case 'model': console.log(provider.modelFor(need())); break
    case 'label': console.log(provider.labelFor(need())); break
    default:
      console.error('usage: registry-query.ts <list|spellings|default|canonical|model|label> [provider]')
      process.exit(2)
  }
} catch (err: any) {
  // A malformed overlay or generic endpoint surfaces here, before any stage runs.
  console.error(`registry-query: ${err?.message ?? err}`)
  process.exit(1)
}
