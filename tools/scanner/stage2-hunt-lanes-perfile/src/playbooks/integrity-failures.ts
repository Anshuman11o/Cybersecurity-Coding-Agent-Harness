export const playbook = `
Playbook for Software and Data Integrity Failures (OWASP A08)
=============================================================

Scope: Detect unsafe deserialization, file handling, and supply chain integrity gaps.

## OWASP Categories Covered
- OWASP A08: Software and Data Integrity Failures

## Sink Patterns to Hunt For
1. Unsafe deserialization: parsing untrusted input with a parser that can instantiate arbitrary objects or execute code during parse (e.g., unsafe YAML/object deserialization, XML parsing with external entity resolution).
2. File upload processing: accepting unvalidated file types, processing archives (path traversal in extracted paths, decompression bombs) without sandboxing, executing or evaluating uploaded content.
3. Auto-update or plugin loading mechanisms that fetch from untrusted sources without integrity verification (checksums, signatures), enabling supply chain attacks via compromised dependencies or plugins.
4. Parsing data structures where the parsed result influences control flow in ways that enable prototype pollution, mass assignment, or other manipulation of internal object state.

## Distinguishing Real Findings from False Positives
- Parsing data is normal. Parsing untrusted data in a way that can execute code or alter control flow is the finding.
- Parsing to a plain data structure (dictionary, list, string) is generally safe; the risk is in parsers that instantiate objects with constructors or execute embedded expressions.
- File upload is only a finding if the uploaded content can be: executed as code, used to traverse directories, or processed in a way that triggers a parser vulnerability.
- Signed and verified updates or plugins are not a finding.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint accepting untrusted data
2. The deserialization/parsing call and its configuration
3. The code execution or control flow alteration that results
4. The impact: remote code execution, data corruption, unauthorized access.
`
