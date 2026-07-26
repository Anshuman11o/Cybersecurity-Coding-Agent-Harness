export const playbook = `
Playbook for Vulnerable and Outdated Components (OWASP A06)
===========================================================

Scope: Identify dependencies with known vulnerabilities via lockfile analysis and CVE lookup.

## OWASP Categories Covered
- OWASP A06: Vulnerable and Outdated Components

## Sink Patterns to Hunt For
1. Identify all dependencies and versions from dependency manifest files (lockfiles, requirements files, build configuration, or equivalent for any language ecosystem).
2. Check each dependency version against known CVE databases.
3. Flag known-vulnerable versions, especially in security-critical packages: authentication libraries, cryptographic libraries, XML/YAML/JSON parsers, web frameworks, database drivers.
4. Pay attention to transitive dependencies — a vulnerable sub-dependency can be as impactful as a direct one.

## Distinguishing Real Findings from False Positives
- An outdated dependency without a known CVE is a maintenance concern, NOT a vulnerability finding.
- Only flag when there is a specific, published CVE for the exact version in use.
- Consider reachability: a vulnerable package that is imported but never called in a security-relevant path is lower priority, though still worth flagging for remediation.
- Development-only dependencies (test frameworks, linters, build tools) are typically not exploitable in production unless they leak into the deployed artifact.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The vulnerable package name and exact version in use
2. The CVE identifier(s) and CVSS score
3. The affected function or module within the package
4. Whether the vulnerable code path is reachable from application entrypoints
5. The recommended patched version.
`
