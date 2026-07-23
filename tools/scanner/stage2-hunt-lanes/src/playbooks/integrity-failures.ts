export const playbook = `
Playbook for Software and Data Integrity Failures (OWASP A08)
=============================================================

Scope: Detect unsafe deserialization, file handling, and supply chain integrity gaps.

## OWASP Categories Covered
- OWASP A08: Software and Data Integrity Failures

## Sink Patterns to Hunt For
1. Unsafe deserialization: JSON.parse on untrusted input (JSON.parse is generally safe in JS, but the parsed object may influence control flow if used unsafely), YAML.load without safe mode (arbitrary object instantiation), XML parsing with external entity resolution (XXE), protobuf/deserialization libraries that execute code during parse.
2. File upload processing: accepting unvalidated file types, processing archives (ZIP bombs, path traversal in extracted paths) without sandboxing, executing or evaluating uploaded content.
3. CI/CD pipeline manipulation: unsigned plugin loading, auto-update mechanisms that fetch from untrusted sources without integrity verification (checksums, signatures), supply chain attacks via compromised dependencies.
4. Web3/smart contract interactions: accepting untrusted contract inputs without validation, executing transactions based on external contract state without independent verification.

## Distinguishing Real Findings from False Positives
- Parsing data is normal. Parsing untrusted data in a way that can execute code or alter control flow is the finding.
- JSON.parse in JavaScript is safe by itself (no code execution); the risk is in how the resulting object is used (prototype pollution, mass assignment, etc.).
- YAML.load (vs yaml.safeLoad) is inherently dangerous because it can instantiate arbitrary objects, including those with constructors that execute code.
- File upload is only a finding if the uploaded content can be: executed as code, used to traverse directories, or processed in a way that triggers a parser vulnerability.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint accepting untrusted data
2. The deserialization/parsing call and its configuration
3. The code execution or control flow alteration that results
4. The impact: RCE, data corruption, unauthorized access.
`;
