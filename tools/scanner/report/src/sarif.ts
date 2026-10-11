/**
 * SARIF 2.1.0 output (plan §4.4): opens in VS Code's SARIF viewer locally, and
 * is what GitHub code scanning ingests in Option B.
 *
 * - One rule per vulnerability class, so a rule id is stable across runs; a
 *   per-severity rule would open a new alert whenever the model re-rated one.
 * - `partialFingerprints` carries the report's stable fingerprint, which is
 *   what lets code scanning track the same alert across runs instead of
 *   duplicating it (§2.8).
 * - Artifact URIs are relative to %SRCROOT% (the target root), so the file
 *   stays valid when the repository is checked out somewhere else.
 * - The trace becomes a codeFlow; every step location is the lane's file.
 */
import { pathToFileURL } from 'url'
import type { Report, ReportFinding, Severity } from './types.js'

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error', high: 'error', medium: 'warning', low: 'note',
}

// GitHub's security-severity scale (0.1 to 10). Per result, since one rule's
// findings span severities; the rule carries the highest of them.
const SECURITY_SEVERITY: Record<Severity, number> = { critical: 9.5, high: 8.0, medium: 5.5, low: 3.0 }

export const SARIF_FINGERPRINT_KEY = 'secscanFingerprint/v1'

function uri(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** One rule per primary class, the same class the fingerprint is keyed on. */
function ruleIdOf(f: ReportFinding): string {
  return `secscan/${f.classes[0] ?? 'unclassified'}`
}

function region(line: number, snippet?: string) {
  return { startLine: line, ...(snippet !== undefined ? { snippet: { text: snippet } } : {}) }
}

export function toSarif(report: Report): Record<string, unknown> {
  const rules = new Map<string, { id: string; name: string; classes: Set<string>; owasp: Set<string>; cwe: Set<string>; maxSev: number }>()
  for (const f of report.findings) {
    const id = ruleIdOf(f)
    const r = rules.get(id) ?? { id, name: id.split('/')[1], classes: new Set(), owasp: new Set(), cwe: new Set(), maxSev: 0 }
    f.classes.forEach((c) => r.classes.add(c))
    f.owasp.forEach((o) => r.owasp.add(o.code))
    f.cwe.forEach((c) => r.cwe.add(c))
    r.maxSev = Math.max(r.maxSev, SECURITY_SEVERITY[f.severity])
    rules.set(id, r)
  }
  const ruleList = [...rules.values()].sort((a, b) => a.id.localeCompare(b.id))
  const ruleIndex = new Map(ruleList.map((r, i) => [r.id, i]))

  const results = report.findings.map((f) => {
    const sinkStep = f.evidence[f.evidence.length - 1]
    const sinkSnippet = sinkStep?.excerpt?.find((l) => l.cited)?.text
    const message = [
      f.title,
      f.description,
      f.severity_reason ? `Severity ${f.severity}: ${f.severity_reason}` : `Severity ${f.severity}.`,
      `Confidence ${f.confidence_explanation.text}`,
      f.attack_scenario ? `Attack scenario: ${f.attack_scenario}` : '',
      f.remediation ? `Remediation: ${f.remediation}` : '',
    ].filter(Boolean).join('\n\n')

    const location = {
      physicalLocation: {
        artifactLocation: { uri: uri(f.location.path), uriBaseId: '%SRCROOT%' },
        region: region(f.location.line, sinkSnippet),
      },
    }
    return {
      ruleId: ruleIdOf(f),
      ruleIndex: ruleIndex.get(ruleIdOf(f)),
      level: LEVEL[f.severity],
      message: { text: message },
      locations: [location],
      partialFingerprints: { [SARIF_FINGERPRINT_KEY]: f.fingerprint },
      codeFlows: f.evidence.length > 0 ? [{
        threadFlows: [{
          locations: f.evidence.map((s) => ({
            location: {
              physicalLocation: {
                artifactLocation: { uri: uri(s.path), uriBaseId: '%SRCROOT%' },
                region: region(s.line > 0 ? s.line : 1, s.excerpt?.find((l) => l.cited)?.text),
              },
              message: { text: `${s.kind}: ${s.description}` },
            },
            kinds: [s.kind === 'entrypoint' ? 'source' : s.kind === 'sink' ? 'sink' : 'pass-through'],
          })),
        }],
      }] : undefined,
      properties: {
        id: f.id,
        severity: f.severity,
        'security-severity': SECURITY_SEVERITY[f.severity].toFixed(1),
        confidence: f.confidence,
        confidence_band: f.confidence_band,
        classes: f.classes,
        owasp: f.owasp.map((o) => o.code),
        cwe: f.cwe,
        ...(f.location.permalink ? { permalink: f.location.permalink } : {}),
        ...(f.location.resolves ? {} : { location_unresolved: true }),
      },
    }
  })

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: report.tool.name,
          version: report.tool.version,
          semanticVersion: report.tool.version,
          rules: ruleList.map((r) => ({
            id: r.id,
            name: r.name,
            shortDescription: { text: `${r.name} (${[...r.owasp].sort().join(', ')})` },
            fullDescription: { text: `Findings of the ${r.name} vulnerability class, hunted by the ${r.name} playbook.` },
            defaultConfiguration: { level: 'warning' },
            properties: {
              tags: ['security', ...[...r.cwe].sort().map((c) => `external/cwe/${c.toLowerCase()}`)],
              'security-severity': r.maxSev.toFixed(1),
              owasp: [...r.owasp].sort(),
            },
          })),
        },
      },
      originalUriBaseIds: {
        '%SRCROOT%': { uri: pathToFileURL(report.header.root.endsWith('/') ? report.header.root : report.header.root + '/').href },
      },
      ...(report.header.github && report.header.commit ? {
        versionControlProvenance: [{
          repositoryUri: report.header.github,
          revisionId: report.header.commit,
          ...(report.header.branch ? { branch: report.header.branch } : {}),
          mappedTo: { uriBaseId: '%SRCROOT%' },
        }],
      } : {}),
      // GitHub reads everything before the last '/' as the analysis category.
      // It must stay the same from run to run, or every scan is a separate
      // analysis and no alert is ever marked fixed; the run id goes after it.
      automationDetails: { id: `secscan/${report.header.scope.mode}/${report.header.run_id ?? ''}` },
      results,
      properties: {
        status: report.status.state,
        status_reasons: report.status.reasons,
        config_hash: report.header.config_hash,
        model: report.header.model,
      },
    }],
  }
}
