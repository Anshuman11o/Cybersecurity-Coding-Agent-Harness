/** Structural summaries never expose the contents of key/certificate files. */
export function summarizeKeyMaterial(content: string): string {
  const lines = content.split('\n')
  return lines.map((_line, i) => i === 0
    ? `[KEY-MATERIAL SUMMARY: ${lines.length} lines; all file content withheld. Encoding and private-key status are not verified.]`
    : '[REDACTED: key-material content]').join('\n')
}
