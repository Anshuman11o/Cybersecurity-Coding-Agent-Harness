/** Android declarative security surfaces, independent of application names.
 * Manifests declare component access; res/xml holds network, backup and sharing
 * policies. Layouts and value resources require their consuming code's context.
 * Resource qualifiers (xml-v24, etc.) carry the same configuration semantics.
 */
export function androidConfigSignals(file: string, language: string): string[] {
  if (language.toLowerCase() !== 'xml') return []
  const normalized = file.replaceAll('\\', '/')
  if (/(^|\/)AndroidManifest\.xml$/.test(normalized)) {
    return ['config_file', 'route_handler', 'auth_check', 'crypto_op']
  }
  if (/(^|\/)res\/xml(?:-[^/]+)?\/[^/]+\.xml$/.test(normalized)) {
    return ['config_file', 'auth_check', 'crypto_op']
  }
  return []
}
