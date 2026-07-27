/**
 * Stage 0 Recon — main orchestrator.
 *
 * Reads the target app, runs deterministic AST extraction, swagger diff,
 * frontend grep, and LLM probes, then writes the two output files:
 * - architecture-summary.json
 * - category-applicability.json
 */
import * as fs from 'fs'
import * as path from 'path'

import { extract, extractDependencies } from './ast-extractor.js'
import { diff as swaggerDiff } from './swagger-diff.js'
import { scan as frontendGrep } from './frontend-grep.js'
import { detectToolCalling, probeCategoryApplicability } from './llm-probe.js'
import { runPath } from '../../shared/run-paths.js'
import { resolveProvider, modelFor } from '../../shared/provider.js'
import { writeMeta, failIfDegraded } from '../../shared/meta.js'

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../../')
const TARGET_DIR = path.join(PROJECT_ROOT, 'target-apps', 'juice-shop-blind')
const OUTPUT_DIR = runPath(resolveProvider('stage0'), 'stage0-recon')

const SERVER_TS = path.join(TARGET_DIR, 'server.ts')
const SWAGGER_YML = path.join(TARGET_DIR, 'swagger.yml')
const PACKAGE_JSON = path.join(TARGET_DIR, 'package.json')
const CHAT_TS = path.join(TARGET_DIR, 'routes', 'chat.ts')
const FRONTEND_SRC = path.join(TARGET_DIR, 'frontend', 'src', 'app')

async function main() {
  console.log('=== Stage 0: Recon ===')
  console.log(`Target: ${TARGET_DIR}`)
  console.log()

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // ---- Step 1: Deterministic AST extraction ----
  console.log('[1/5] AST extraction from server.ts...')
  const astResult = extract(SERVER_TS)
  const dependencies = extractDependencies(PACKAGE_JSON)
  astResult.dependencies = dependencies
  console.log(`  Found ${astResult.routes.length} route registrations`)
  console.log(`  Found ${astResult.autoCrudRoutes.length} auto-CRUD resources`)
  console.log(`  Persistence: ${astResult.persistence.orm} / ${astResult.persistence.database}`)
  console.log(`  Models: ${astResult.persistence.models.join(', ')}`)
  console.log()

  // ---- Step 2: Swagger diff ----
  console.log('[2/5] Diffing routes against swagger.yml...')
  const swaggerResult = swaggerDiff(SWAGGER_YML, astResult.routes, astResult.autoCrudRoutes)
  console.log(`  Documented paths: ${swaggerResult.documentedPaths.length}`)
  console.log(`  Undocumented surfaces: ${swaggerResult.undocumentedSurfaces.length}`)
  console.log(`  Coverage: ${swaggerResult.coverageNote}`)
  console.log()

  // ---- Step 3: Frontend grep (escape-hatch detection) ----
  console.log('[3/5] Scanning frontend for Angular escape-hatch APIs...')
  const escapeHatchFindings = frontendGrep(FRONTEND_SRC)
  console.log(`  Found ${escapeHatchFindings.length} escape-hatch occurrences`)
  if (escapeHatchFindings.length > 0) {
    const byFile = new Map<string, number>()
    for (const f of escapeHatchFindings) {
      byFile.set(f.file, (byFile.get(f.file) || 0) + 1)
    }
    for (const [file, count] of byFile) {
      console.log(`    ${file}: ${count} occurrence(s)`)
    }
  }
  console.log()

  // ---- Step 4: LLM tool-calling detection ----
  console.log('[4/5] Analyzing chat.ts for tool-calling capabilities...')
  const toolCallingVerdict = await detectToolCalling(CHAT_TS)
  console.log(`  Genuine tool-calling: ${toolCallingVerdict.hasGenuineToolCalling}`)
  console.log(`  Tools detected: ${toolCallingVerdict.toolsDetected.join(', ') || 'none'}`)
  console.log(`  Confidence: ${toolCallingVerdict.confidence}`)
  console.log(`  Evidence: ${toolCallingVerdict.evidence}`)
  console.log()

  // ---- Step 5: Build architecture summary and run category probe ----
  console.log('[5/5] Building architecture summary and running category applicability probe...')

  const archSummary = buildArchitectureSummary(
    astResult,
    swaggerResult,
    escapeHatchFindings,
    toolCallingVerdict,
  )

  const categoryVerdicts = await probeCategoryApplicability(
    archSummary,
    toolCallingVerdict,
    escapeHatchFindings,
    swaggerResult.coverageNote,
  )

  console.log(`  Category verdicts: ${categoryVerdicts.length}`)
  const presentCount = categoryVerdicts.filter(c => c.verdict === 'present').length
  const absentCount = categoryVerdicts.filter(c => c.verdict === 'absent').length
  const uncertainCount = categoryVerdicts.filter(c => c.verdict === 'uncertain').length
  console.log(`  Present: ${presentCount}, Absent: ${absentCount}, Uncertain: ${uncertainCount}`)
  console.log()

  // ---- Write output files ----
  const archSummaryPath = path.join(OUTPUT_DIR, 'architecture-summary.json')
  const catApplicPath = path.join(OUTPUT_DIR, 'category-applicability.json')
  const __provider = resolveProvider('stage0')
  const __started = new Date().toISOString()

  fs.writeFileSync(archSummaryPath, JSON.stringify(archSummary, null, 2))
  console.log(`Written: ${archSummaryPath}`)

  fs.writeFileSync(catApplicPath, JSON.stringify(categoryVerdicts, null, 2))
  writeMeta(__provider, 'stage0-recon', modelFor(__provider), __started)
  failIfDegraded('stage0', 'stage0-recon')
  console.log(`Written: ${catApplicPath}`)

  console.log()
  console.log('=== Stage 0 Recon complete ===')
}

function buildArchitectureSummary(
  ast: ReturnType<typeof extract>,
  swagger: ReturnType<typeof swaggerDiff>,
  escapeHatch: ReturnType<typeof frontendGrep>,
  toolCalling: Awaited<ReturnType<typeof detectToolCalling>>,
): any {
  // Build a concise, structured architecture summary
  const handWrittenRoutes = ast.routes
    .filter(r => r.method !== 'USE' && r.routePath !== '*')
    .map(r => ({
      method: r.method,
      path: r.routePath,
      handler: r.handler,
      auth: r.auth,
      middleware: r.middleware,
      file: r.file,
      line: r.line,
    }))

  const middlewareRoutes = ast.routes
    .filter(r => r.method === 'USE' && r.routePath !== '*')
    .map(r => ({
      method: r.method,
      path: r.routePath,
      middleware: r.middleware,
      auth: r.auth,
      file: r.file,
      line: r.line,
    }))

  const autoCrud = ast.autoCrudRoutes.map(ac => ({
    pathPattern: ac.pathPattern,
    model: ac.model,
    excludeAttributes: ac.excludeAttributes,
    hasPagination: ac.hasPagination,
    hasCustomHooks: ac.hasCustomHooks,
  }))

  const summary = {
    route_table: {
      hand_written_routes: handWrittenRoutes,
      middleware_routes: middlewareRoutes,
      auto_crud_routes: autoCrud,
      total_routes: handWrittenRoutes.length + middlewareRoutes.length,
      total_auto_crud: autoCrud.length,
    },
    persistence_layer: {
      orm: ast.persistence.orm,
      database: ast.persistence.database,
      models: ast.persistence.models,
      raw_queries: ast.persistence.rawQueries,
      raw_query_files: ast.persistence.rawQueryFiles,
      mongodb_detected: ast.persistence.database === 'mongodb',
    },
    dependencies: {
      total: ast.dependencies.length,
      security_relevant: ast.dependencies
        .filter(d => isSecurityRelevantDependency(d.name))
        .map(d => ({ name: d.name, version: d.version })),
    },
    api_documentation: {
      swagger_paths: swagger.documentedPaths,
      undocumented_surfaces: swagger.undocumentedSurfaces.map(u => ({
        type: u.type,
        method: u.method,
        path: u.routePath,
      })),
      coverage_note: swagger.coverageNote,
    },
    client_side: {
      escape_hatch_findings: escapeHatch.map(f => ({
        file: f.file,
        line: f.line,
        type: f.type,
      })),
      total_escape_hatch_count: escapeHatch.length,
    },
    llm_ai: {
      has_genuine_tool_calling: toolCalling.hasGenuineToolCalling,
      tools_detected: toolCalling.toolsDetected,
      evidence: toolCalling.evidence,
      confidence: toolCalling.confidence,
    },
  }

  return summary
}

function isSecurityRelevantDependency(name: string): boolean {
  const securityKeywords = [
    'helmet', 'cors', 'jsonwebtoken', 'jwt', 'bcrypt', 'argon2', 'passport',
    'express-rate-limit', 'csurf', 'crypto', 'validator', 'sanitize',
    'xml', 'yaml', 'js-yaml', 'multer', 'compression',
    'sequelize', 'mongoose', 'mongo',
    'ai-sdk', 'openai', 'ai', 'langchain',
    'express-ipfilter', 'feature-policy',
  ]
  const lower = name.toLowerCase()
  return securityKeywords.some(kw => lower.includes(kw))
}

main().catch(err => {
  console.error('Stage 0 Recon failed:', err)
  process.exit(1)
})
