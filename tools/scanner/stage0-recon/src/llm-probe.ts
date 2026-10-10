/**
 * LLM-based analysis with deterministic fallback:
 * 1. Architecture summary — one call over the repo map (recon v3)
 * 2. Tool-calling detection on the files most likely to define LLM tools
 * 3. Category applicability probe (OWASP Top 10, API Security Top 10, LLM Top 10)
 *
 * Endpoint, credential and model come from the model registry
 * (tools/scanner/shared/models.json) via the resolved provider.
 * Falls back to deterministic analysis when API is unreachable, and every
 * fallback calls markDegraded() so a run that never reached the model cannot
 * pass for one that did.
 *
 * Nothing here may assume a particular target. The deterministic fallbacks used
 * to look for one application's middleware and tool names, which made them
 * answer correctly for that application and wrongly for every other; they now
 * derive what they report from the target's own manifests, symbol table and
 * route table.
 */
import OpenAI from 'openai'
import * as path from 'path'
import type { EscapeHatchFinding } from './frontend-grep.js'
import type {
  ArchitectureInfo,
  AuthMechanism,
  InventoryEntry,
  SymbolTableArtifact,
} from './recon-contract.js'
import { identifierKey, containsWholeWord } from './ast-extractor.js'
import { EXECUTABLE_LANGUAGES } from './repo-map.js'
import { resolveProvider, modelFor, tokenLimitParam, samplingParams, clientConfigFor, outputTokenCap, transportFor } from '../../shared/provider.js'
import { createClaudeCliClient } from '../../shared/claude-cli-client.js'
import { markDegraded } from '../../shared/degraded.js'
import { readCorpusFile } from '../../shared/read-guard.js'
import { REPO_ROOT } from '../../shared/run-context.js'

const PROVIDER = resolveProvider('stage0')

/**
 * Output-token caps for this stage's probes.
 *
 * These were literals — 500 and 5000 — sent regardless of target. That is only
 * safe on a model whose reasoning is cheap or absent, because reasoning tokens
 * are counted against this cap before any content is emitted. It broke the
 * first non-luna run attempted: glm-5.2 spends ~11,800 reasoning tokens on the
 * category probe and needs ~14,100 in total, so at 5000 it returned a truncated
 * body, JSON.parse failed, and the stage marked itself degraded and refused to
 * continue. luna never hit it because it spends far fewer reasoning tokens on
 * the same prompt, so the defect was invisible for six runs.
 *
 * The registry's max_output_tokens is now authoritative, exactly as Stage 2
 * does it. The literals below survive as the fallback for a target that
 * declares no cap, so behaviour is unchanged for any such target. A cap is a
 * ceiling, not a spend — billing is per token generated — so a target that did
 * not need the headroom does not pay for it.
 */
const PROBE_CAP_SMALL = outputTokenCap(PROVIDER, 500)
const PROBE_CAP_LARGE = outputTokenCap(PROVIDER, 5000)
const MODEL = modelFor(PROVIDER)

export interface ToolCallingVerdict {
  hasGenuineToolCalling: boolean
  evidence: string
  toolsDetected: string[]
  confidence: number  // 0-1
}

/** The verdict over every probed file, plus which files those were. */
export interface ToolCallingResult extends ToolCallingVerdict {
  /** Target-relative paths actually read and judged, in rank order. */
  filesProbed: string[]
  /** Probed files whose own verdict was genuine tool-calling. */
  filesWithToolCalling: string[]
}

export interface CategoryVerdict {
  name: string
  framework: 'OWASP Top 10 2021' | 'API Security Top 10' | 'LLM Top 10'
  verdict: 'present' | 'absent' | 'uncertain'
  evidence: string
  confidence: number  // 0-1
}

/**
 * Initialize the LLM client for the resolved provider.
 *
 * Returns null when the credential is absent, so the caller can markDegraded()
 * and fall back to deterministic analysis rather than crash the stage.
 * Proxying via NODE_USE_ENV_PROXY=1; openai v6 has no httpAgent option.
 */
function createClient(): OpenAI | null {
  // Transport branch, not a model branch — the value is registry data. Must
  // precede the credential check: a CLI-backed target authenticates through the
  // Claude Code session and declares no usable api_key_env, so the credential
  // path would return null here and silently degrade Stage 0 to deterministic
  // analysis. That failure is invisible downstream: the stage still emits a
  // category verdict, just not one the model produced.
  if (transportFor(PROVIDER) === 'claude-cli') {
    const effort = samplingParams(PROVIDER).reasoning_effort
    return createClaudeCliClient({
      model: modelFor(PROVIDER),
      effort: typeof effort === 'string' ? effort : undefined,
    }) as unknown as OpenAI
  }
  const { apiKey, baseURL } = clientConfigFor(PROVIDER)
  if (!apiKey) return null
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

/** Target-relative path -> the repo-relative form the read guard takes. */
function guardPath(targetDir: string, relPath: string): string {
  return path.relative(REPO_ROOT, path.join(targetDir, relPath))
}

// ===========================================================================
// 1. Architecture summary
// ===========================================================================

const AUTH_KINDS: readonly AuthMechanism['kind'][] = ['authentication', 'authorization', 'session', 'api_key', 'oauth', 'other']

/** What validation checks the model's answer against. */
export interface ArchitectureValidationContext {
  /** Every target-relative path in file-inventory.json. */
  inventoryPaths: ReadonlySet<string>
  /** Every symbol name in symbols.json. */
  symbolNames: ReadonlySet<string>
  /** The route table's handler and middleware text, newline-joined. */
  routeText: string
  /** Absolute target root, so an absolute path the model writes can be made relative. */
  targetDir?: string
}

export function buildArchitecturePrompt(repoMap: string): string {
  return `You are mapping the architecture of a software repository for a security review. Below is a generated map of the repository: language counts, the directory tree, dependency manifests, the README, entry-point files, route registrations (when they could be extracted) and an outline of exported symbols. Sections may be truncated.

Describe the architecture. Respond with one JSON object and nothing else, in exactly this shape:

{
  "summary": "two to four sentences: what the application is, how it is structured, and how requests or inputs reach its code",
  "frameworks": [{"name": "framework or runtime", "language": "language, or null", "evidence": "where in the map it shows"}],
  "entry_points": [{"file": "path", "kind": "http_server | cli | worker | frontend | library | other", "description": "what starts here"}],
  "auth_mechanisms": [{"name": "what it is", "kind": "authentication | authorization | session | api_key | oauth | other", "identifiers": ["identifier as written at call sites"], "defined_in": ["path"], "protects": ["route, path prefix or file it guards"], "evidence": "where in the map it shows"}],
  "data_stores": [{"name": "database, cache or store", "kind": "relational | document | key_value | file | search | other", "files": ["path"], "evidence": "where in the map it shows"}],
  "trust_boundaries": [{"name": "boundary", "description": "what untrusted input crosses it and where", "files": ["path"]}]
}

Rules:
- auth_mechanisms: every function, middleware, decorator or annotation the code uses to authenticate a caller or authorize access, by the exact identifier used at call sites (as it appears in a route registration's arguments, or as the decorator or annotation is written). Not rate limiting, validation or logging.
- Every path must be a file path that appears in the map, written exactly as the map writes it, relative to the repository root.
- Use only what the map shows. When something cannot be determined from it, leave that list empty rather than guess.
- No markdown and no text outside the JSON object.

Repository map:
${repoMap}`
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean)
  const s = str(v)
  return s ? [s] : []
}

function objArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : []
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

/**
 * A path as the model wrote it -> the inventory's form. Tolerates quoting, a
 * leading './', an absolute path inside the target and a ':line' suffix; does
 * not guess beyond that.
 */
export function normalizeModelPath(p: string, targetDir?: string): string {
  let s = p.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/')
  s = s.replace(/:\d+(?::\d+)?$/, '')
  if (targetDir && path.isAbsolute(s)) {
    const rel = path.relative(targetDir, s)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) s = rel.split(path.sep).join('/')
  }
  return s.replace(/^(?:\.\/)+/, '')
}

/** An identifier exists when its call-site name is a symbol, or a whole word in the route table. */
export function isVerifiedIdentifier(identifier: string, ctx: ArchitectureValidationContext): boolean {
  const key = identifierKey(identifier)
  if (!key) return false
  return ctx.symbolNames.has(key) || containsWholeWord(ctx.routeText, key)
}

/**
 * Turn the model's JSON (or the deterministic fallback's, which goes through
 * the same gate) into an ArchitectureInfo the rest of the pipeline can trust.
 * A path not in the inventory is removed, an identifier that does not exist is
 * kept in `identifiers` but not in `verified_identifiers`; both are recorded in
 * `dropped`. Null when the answer is not a JSON object at all.
 */
export function validateArchitecture(
  raw: unknown,
  ctx: ArchitectureValidationContext,
  source: ArchitectureInfo['source'],
  model: string | null,
): ArchitectureInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const dropped: ArchitectureInfo['dropped'] = []

  const checkPath = (field: string, value: string): string | null => {
    const n = normalizeModelPath(value, ctx.targetDir)
    if (ctx.inventoryPaths.has(n)) return n
    dropped.push({ field, value, reason: 'path not in the file inventory' })
    return null
  }
  const checkPaths = (field: string, v: unknown): string[] =>
    dedupe(strArr(v).map(p => checkPath(field, p)).filter((p): p is string => p !== null))

  const frameworks = objArr(o.frameworks)
    .filter(f => str(f.name))
    .map(f => ({ name: str(f.name), language: str(f.language) || null, evidence: str(f.evidence) }))

  const entry_points: ArchitectureInfo['entry_points'] = []
  objArr(o.entry_points).forEach((e, i) => {
    const given = str(e.file)
    const file = given ? checkPath(`entry_points[${i}].file`, given) : null
    if (file) entry_points.push({ file, kind: str(e.kind) || 'other', description: str(e.description) })
  })

  const auth_mechanisms: AuthMechanism[] = []
  objArr(o.auth_mechanisms).forEach((m, i) => {
    const identifiers = dedupe(strArr(m.identifiers))
    const name = str(m.name) || identifiers[0] || ''
    if (!name) return
    let kind = str(m.kind) as AuthMechanism['kind']
    if (!AUTH_KINDS.includes(kind)) {
      if (kind) dropped.push({ field: `auth_mechanisms[${i}].kind`, value: kind, reason: 'not a known kind; recorded as other' })
      kind = 'other'
    }
    const verified_identifiers = identifiers.filter(id => {
      const ok = isVerifiedIdentifier(id, ctx)
      if (!ok) dropped.push({ field: `auth_mechanisms[${i}].identifiers`, value: id, reason: 'identifier not found in the symbol table or the route table' })
      return ok
    })
    auth_mechanisms.push({
      name,
      kind,
      identifiers,
      verified_identifiers,
      defined_in: checkPaths(`auth_mechanisms[${i}].defined_in`, m.defined_in),
      protects: strArr(m.protects),
      evidence: str(m.evidence),
    })
  })

  const data_stores = objArr(o.data_stores)
    .map((d, i) => ({ name: str(d.name), kind: str(d.kind) || 'other', files: checkPaths(`data_stores[${i}].files`, d.files), evidence: str(d.evidence) }))
    .filter(d => d.name)

  const trust_boundaries = objArr(o.trust_boundaries)
    .map((t, i) => ({ name: str(t.name), description: str(t.description), files: checkPaths(`trust_boundaries[${i}].files`, t.files) }))
    .filter(t => t.name)

  return {
    source,
    model,
    summary: str(o.summary),
    frameworks,
    entry_points,
    auth_mechanisms,
    data_stores,
    trust_boundaries,
    dropped,
  }
}

// ---- deterministic fallback ------------------------------------------------

type Ecosystem = 'npm' | 'pypi' | 'gem' | 'go' | 'maven' | 'nuget' | 'composer' | 'cargo'

/** Manifest basename (lower-cased) -> its package ecosystem. */
function ecosystemOf(manifestPath: string): Ecosystem | null {
  const base = path.posix.basename(manifestPath.toLowerCase())
  if (base === 'package.json') return 'npm'
  if (base === 'composer.json') return 'composer'
  if (base === 'gemfile') return 'gem'
  if (base === 'go.mod') return 'go'
  if (base === 'cargo.toml') return 'cargo'
  if (base === 'pom.xml' || base.startsWith('build.gradle') || base.startsWith('settings.gradle')) return 'maven'
  if (base.endsWith('.csproj') || base.endsWith('.fsproj') || base.endsWith('.vbproj') || base === 'packages.config') return 'nuget'
  if (base === 'pyproject.toml' || base === 'pipfile' || base === 'setup.cfg' || /^requirements/.test(base) || manifestPath.toLowerCase().includes('requirements/')) return 'pypi'
  return null
}

interface KnownDependency { eco: Ecosystem; dep: string; name: string; language: string; kind: string }

const known = (eco: Ecosystem, language: string, kind: string, pairs: [string, string][]): KnownDependency[] =>
  pairs.map(([dep, name]) => ({ eco, dep, name, language, kind }))

/** Web and application frameworks, by the dependency that declares them. */
const KNOWN_FRAMEWORKS: KnownDependency[] = [
  ...known('npm', 'javascript', 'framework', [
    ['express', 'Express'], ['koa', 'Koa'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'],
    ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@hapi/hapi', 'hapi'], ['restify', 'Restify'],
    ['@angular/core', 'Angular'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'],
    ['@sveltejs/kit', 'SvelteKit'], ['socket.io', 'Socket.IO'], ['@apollo/server', 'Apollo Server'],
    ['apollo-server', 'Apollo Server'], ['electron', 'Electron'],
  ]),
  ...known('pypi', 'python', 'framework', [
    ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['starlette', 'Starlette'],
    ['tornado', 'Tornado'], ['aiohttp', 'aiohttp'], ['pyramid', 'Pyramid'], ['sanic', 'Sanic'],
    ['djangorestframework', 'Django REST framework'],
  ]),
  ...known('gem', 'ruby', 'framework', [['rails', 'Rails'], ['sinatra', 'Sinatra'], ['grape', 'Grape'], ['hanami', 'Hanami']]),
  ...known('go', 'go', 'framework', [
    ['github.com/gin-gonic/gin', 'Gin'], ['github.com/labstack/echo', 'Echo'], ['github.com/gofiber/fiber', 'Fiber'],
    ['github.com/gorilla/mux', 'gorilla/mux'], ['github.com/go-chi/chi', 'chi'],
  ]),
  ...known('maven', 'java', 'framework', [
    ['spring-boot-starter-web', 'Spring Boot'], ['spring-webmvc', 'Spring MVC'], ['quarkus-resteasy', 'Quarkus'],
    ['micronaut-http-server', 'Micronaut'], ['jersey-server', 'Jersey'], ['dropwizard-core', 'Dropwizard'],
  ]),
  ...known('nuget', 'csharp', 'framework', [['Microsoft.AspNetCore', 'ASP.NET Core'], ['Microsoft.NET.Sdk.Web', 'ASP.NET Core']]),
  ...known('composer', 'php', 'framework', [
    ['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony'], ['slim/slim', 'Slim'],
    ['cakephp/cakephp', 'CakePHP'], ['yiisoft/yii2', 'Yii'],
  ]),
  ...known('cargo', 'rust', 'framework', [['actix-web', 'Actix Web'], ['axum', 'Axum'], ['rocket', 'Rocket'], ['warp', 'warp']]),
]

/** Databases, caches and their drivers or ORMs; `kind` is the data store kind. */
const KNOWN_DATA_STORES: KnownDependency[] = [
  ...known('npm', 'javascript', 'relational', [
    ['sequelize', 'Sequelize (SQL ORM)'], ['pg', 'PostgreSQL'], ['mysql', 'MySQL'], ['mysql2', 'MySQL'],
    ['sqlite3', 'SQLite'], ['better-sqlite3', 'SQLite'], ['typeorm', 'TypeORM (SQL ORM)'],
    ['@prisma/client', 'Prisma (ORM)'], ['knex', 'Knex (SQL query builder)'], ['drizzle-orm', 'Drizzle (SQL ORM)'],
  ]),
  ...known('npm', 'javascript', 'document', [['mongoose', 'MongoDB (Mongoose)'], ['mongodb', 'MongoDB']]),
  ...known('npm', 'javascript', 'key_value', [['redis', 'Redis'], ['ioredis', 'Redis']]),
  ...known('npm', 'javascript', 'search', [['@elastic/elasticsearch', 'Elasticsearch']]),
  ...known('pypi', 'python', 'relational', [
    ['sqlalchemy', 'SQLAlchemy (SQL ORM)'], ['psycopg2', 'PostgreSQL'], ['psycopg2-binary', 'PostgreSQL'],
    ['psycopg', 'PostgreSQL'], ['peewee', 'Peewee (SQL ORM)'], ['mysqlclient', 'MySQL'], ['pymysql', 'MySQL'],
  ]),
  ...known('pypi', 'python', 'document', [['pymongo', 'MongoDB'], ['motor', 'MongoDB']]),
  ...known('pypi', 'python', 'key_value', [['redis', 'Redis']]),
  ...known('gem', 'ruby', 'relational', [['pg', 'PostgreSQL'], ['mysql2', 'MySQL'], ['sqlite3', 'SQLite'], ['activerecord', 'ActiveRecord (SQL ORM)']]),
  ...known('gem', 'ruby', 'document', [['mongoid', 'MongoDB']]),
  ...known('gem', 'ruby', 'key_value', [['redis', 'Redis']]),
  ...known('go', 'go', 'relational', [
    ['gorm.io/gorm', 'GORM (SQL ORM)'], ['github.com/lib/pq', 'PostgreSQL'], ['github.com/jackc/pgx', 'PostgreSQL'],
    ['github.com/go-sql-driver/mysql', 'MySQL'], ['github.com/mattn/go-sqlite3', 'SQLite'],
  ]),
  ...known('go', 'go', 'document', [['go.mongodb.org/mongo-driver', 'MongoDB']]),
  ...known('go', 'go', 'key_value', [['github.com/redis/go-redis', 'Redis'], ['github.com/go-redis/redis', 'Redis']]),
  ...known('maven', 'java', 'relational', [
    ['spring-boot-starter-data-jpa', 'JPA'], ['hibernate-core', 'Hibernate (SQL ORM)'], ['mysql-connector-java', 'MySQL'],
    ['mysql-connector-j', 'MySQL'], ['postgresql', 'PostgreSQL'], ['h2', 'H2'],
  ]),
  ...known('maven', 'java', 'document', [['spring-boot-starter-data-mongodb', 'MongoDB']]),
  ...known('maven', 'java', 'key_value', [['jedis', 'Redis']]),
  ...known('nuget', 'csharp', 'relational', [['Microsoft.EntityFrameworkCore', 'Entity Framework Core'], ['Npgsql', 'PostgreSQL'], ['Dapper', 'Dapper (SQL)']]),
  ...known('nuget', 'csharp', 'document', [['MongoDB.Driver', 'MongoDB']]),
  ...known('nuget', 'csharp', 'key_value', [['StackExchange.Redis', 'Redis']]),
  ...known('composer', 'php', 'relational', [['doctrine/orm', 'Doctrine (SQL ORM)'], ['illuminate/database', 'Eloquent (SQL ORM)']]),
  ...known('composer', 'php', 'document', [['mongodb/mongodb', 'MongoDB']]),
  ...known('composer', 'php', 'key_value', [['predis/predis', 'Redis']]),
  ...known('cargo', 'rust', 'relational', [['diesel', 'Diesel (SQL ORM)'], ['sqlx', 'SQLx'], ['rusqlite', 'SQLite'], ['sea-orm', 'SeaORM']]),
  ...known('cargo', 'rust', 'document', [['mongodb', 'MongoDB']]),
  ...known('cargo', 'rust', 'key_value', [['redis', 'Redis']]),
]

/** Authentication and authorization libraries; `kind` is the AuthMechanism kind. */
const KNOWN_AUTH_LIBRARIES: KnownDependency[] = [
  ...known('npm', 'javascript', 'authentication', [
    ['passport', 'passport'], ['passport-jwt', 'passport-jwt'], ['jsonwebtoken', 'jsonwebtoken (JWT)'],
    ['express-jwt', 'express-jwt (JWT)'], ['jose', 'jose (JWT)'], ['next-auth', 'NextAuth'],
    ['@nestjs/passport', '@nestjs/passport'], ['@nestjs/jwt', '@nestjs/jwt (JWT)'],
  ]),
  ...known('npm', 'javascript', 'session', [['express-session', 'express-session'], ['cookie-session', 'cookie-session']]),
  ...known('npm', 'javascript', 'oauth', [['express-openid-connect', 'express-openid-connect'], ['keycloak-connect', 'keycloak-connect']]),
  ...known('pypi', 'python', 'authentication', [
    ['flask-jwt-extended', 'Flask-JWT-Extended'], ['djangorestframework-simplejwt', 'Simple JWT'],
    ['pyjwt', 'PyJWT'], ['python-jose', 'python-jose (JWT)'], ['fastapi-users', 'FastAPI Users'],
    ['flask-security', 'Flask-Security'], ['django-allauth', 'django-allauth'],
  ]),
  ...known('pypi', 'python', 'session', [['flask-login', 'Flask-Login']]),
  ...known('pypi', 'python', 'oauth', [['authlib', 'Authlib'], ['django-oauth-toolkit', 'Django OAuth Toolkit']]),
  ...known('gem', 'ruby', 'authentication', [['devise', 'Devise'], ['jwt', 'ruby-jwt']]),
  ...known('gem', 'ruby', 'authorization', [['pundit', 'Pundit'], ['cancancan', 'CanCanCan']]),
  ...known('gem', 'ruby', 'oauth', [['omniauth', 'OmniAuth'], ['doorkeeper', 'Doorkeeper']]),
  ...known('go', 'go', 'authentication', [['github.com/golang-jwt/jwt', 'golang-jwt'], ['github.com/dgrijalva/jwt-go', 'jwt-go']]),
  ...known('go', 'go', 'oauth', [['golang.org/x/oauth2', 'x/oauth2']]),
  ...known('go', 'go', 'authorization', [['github.com/casbin/casbin', 'Casbin']]),
  ...known('maven', 'java', 'authentication', [
    ['spring-boot-starter-security', 'Spring Security'], ['spring-security-core', 'Spring Security'],
    ['jjwt', 'JJWT'], ['java-jwt', 'java-jwt'],
  ]),
  ...known('maven', 'java', 'oauth', [['spring-boot-starter-oauth2-resource-server', 'Spring OAuth2 resource server']]),
  ...known('nuget', 'csharp', 'authentication', [
    ['Microsoft.AspNetCore.Authentication', 'ASP.NET Core authentication'], ['Microsoft.AspNetCore.Identity', 'ASP.NET Core Identity'],
    ['System.IdentityModel.Tokens.Jwt', 'JWT tokens'],
  ]),
  ...known('nuget', 'csharp', 'oauth', [['IdentityServer4', 'IdentityServer'], ['Duende.IdentityServer', 'IdentityServer']]),
  ...known('composer', 'php', 'authentication', [
    ['laravel/sanctum', 'Laravel Sanctum'], ['tymon/jwt-auth', 'jwt-auth'], ['firebase/php-jwt', 'php-jwt'],
    ['lexik/jwt-authentication-bundle', 'LexikJWT'], ['symfony/security-bundle', 'Symfony Security'],
  ]),
  ...known('composer', 'php', 'oauth', [['laravel/passport', 'Laravel Passport']]),
  ...known('cargo', 'rust', 'authentication', [['jsonwebtoken', 'jsonwebtoken (JWT)'], ['axum-login', 'axum-login']]),
  ...known('cargo', 'rust', 'session', [['actix-identity', 'actix-identity']]),
  ...known('cargo', 'rust', 'oauth', [['oauth2', 'oauth2']]),
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Dependency names a manifest declares. JSON manifests are parsed; the rest are matched as text. */
function manifestDeclares(manifest: { path: string; content: string }, eco: Ecosystem): (dep: string) => boolean {
  if (eco === 'npm' || eco === 'composer') {
    let names = new Set<string>()
    try {
      const j = JSON.parse(manifest.content)
      const blocks = eco === 'npm'
        ? [j.dependencies, j.devDependencies, j.peerDependencies, j.optionalDependencies]
        : [j.require, j['require-dev']]
      names = new Set(blocks.flatMap(b => (b && typeof b === 'object' ? Object.keys(b) : [])))
    } catch { /* unparseable manifest declares nothing */ }
    return (dep) => names.has(dep)
  }
  // Text manifests: the name bounded so `flask` does not match `flask-login`
  // and `pg` does not match `pgx`; a following '.' is allowed for dotted
  // package prefixes (Microsoft.AspNetCore.Authentication.JwtBearer).
  return (dep) => new RegExp(`(?<![\\w.@/-])${escapeRegExp(dep)}(?![\\w-])`, 'i').test(manifest.content)
}

/**
 * Exported names that read as an authentication or authorization guard, in the
 * common spellings: isAuthenticated / is_admin / requireUser / verifyJwt /
 * authenticateToken / login_required / authorize / authMiddleware / AdminGuard.
 * Deliberately about shape, never about a particular codebase's names.
 */
const AUTH_NAME_PATTERNS: RegExp[] = [
  /^(?:is|ensure|require|requires|check|verify|validate|has|must|authenticate|authorize|authorise)(?:Auth|Authenticated|Authorized|Authorised|LoggedIn|SignedIn|Login|Admin|Role|Roles|Permission|Permissions|Scope|Scopes|Access|Session|User|Token|Jwt|JWT|ApiKey|Owner)(?:[A-Z]\w*)?$/,
  /^(?:is|ensure|require|requires|check|verify|validate|has|must)_(?:auth|authenticated|authorized|authorised|logged_in|signed_in|login|admin|role|roles|permission|permissions|scope|scopes|access|session|user|token|jwt|api_key|owner)(?:_\w+)?$/,
  /^(?:authenticate|authorize|authorise|login_required|permission_required|auth_required|jwt_required|token_required|requires_auth|admin_required|roles_required)$/,
  /^(?:auth|authentication|authorization)(?:Middleware|Guard|Filter|Handler)?$/i,
  /^[a-z]*(?:auth|role|roles|permission|permissions|admin|login|session|token|jwt)_?(?:middleware|guard|filter|required|check)$/i,
  /^[A-Z]\w*Guard$/,
]
const MAX_DETERMINISTIC_AUTH_SYMBOLS = 20

export interface DeterministicArchitectureInput {
  /** Dependency manifests, read in full through the guard. */
  manifests: { path: string; content: string }[]
  symbols: SymbolTableArtifact
  /** Non-test files the guard allows; auth candidates come only from these. */
  eligiblePaths: ReadonlySet<string>
  entryPoints: readonly { path: string; reason: string }[]
  /** Language -> file count, for the summary sentence. */
  languages: Record<string, number>
  fileCount: number
  routeCount: number
  /** The enricher that produced the routes, or null. */
  routeSource: string | null
}

function entryKind(reason: string): string {
  if (reason === 'Express entry file') return 'http_server'
  if (reason === 'declares main') return 'main'
  if (reason.startsWith('framework entry file')) return 'framework'
  return 'conventional'
}

/**
 * The architecture block when no model answered: frameworks, data stores and
 * auth libraries from the manifests; auth guards from exported symbol names;
 * entry points from the repo map's selection. Raw form — the caller passes it
 * through validateArchitecture like a model answer.
 */
export function deterministicArchitecture(input: DeterministicArchitectureInput): Record<string, unknown> {
  const hits = (table: KnownDependency[]) => {
    const out = new Map<string, { dep: KnownDependency; files: string[] }>()
    for (const m of input.manifests) {
      const eco = ecosystemOf(m.path)
      if (!eco) continue
      const declares = manifestDeclares(m, eco)
      for (const d of table) {
        if (d.eco !== eco || !declares(d.dep)) continue
        const key = `${d.name}\u0000${d.kind}`
        const hit = out.get(key) ?? { dep: d, files: [] }
        if (!hit.files.includes(m.path)) hit.files.push(m.path)
        out.set(key, hit)
      }
    }
    return [...out.values()]
  }

  const frameworks = hits(KNOWN_FRAMEWORKS).map(h => ({
    name: h.dep.name, language: h.dep.language, evidence: `declared in ${h.files.join(', ')}`,
  }))
  const data_stores = hits(KNOWN_DATA_STORES).map(h => ({
    name: h.dep.name, kind: h.dep.kind, files: h.files, evidence: `dependency declared in ${h.files.join(', ')}`,
  }))
  const authLibraries = hits(KNOWN_AUTH_LIBRARIES).map(h => ({
    name: `${h.dep.name} (dependency)`, kind: h.dep.kind, identifiers: [], defined_in: h.files, protects: [],
    evidence: `authentication/authorization library declared in ${h.files.join(', ')}`,
  }))

  // name -> defining files, from exported symbols in eligible files only
  const authSymbols = new Map<string, { kind: string; files: string[] }>()
  for (const p of Object.keys(input.symbols.files).sort()) {
    if (!input.eligiblePaths.has(p)) continue
    for (const s of input.symbols.files[p].symbols) {
      if (!s.exported || !AUTH_NAME_PATTERNS.some(re => re.test(s.name))) continue
      const entry = authSymbols.get(s.name) ?? { kind: s.kind, files: [] }
      if (!entry.files.includes(p)) entry.files.push(p)
      authSymbols.set(s.name, entry)
    }
  }
  const symbolMechanisms = [...authSymbols.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_DETERMINISTIC_AUTH_SYMBOLS)
    .map(([name, e]) => ({
      name,
      kind: /author|admin|role|permission|scope|access|guard/i.test(name) ? 'authorization' : 'authentication',
      identifiers: [name],
      defined_in: e.files.slice(0, 5),
      protects: [],
      evidence: `exported ${e.kind} whose name reads as an authentication or authorization check`,
    }))

  const topLanguages = Object.entries(input.languages)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([l, n]) => `${l} ${n}`)
    .join(', ')
  const summary =
    `Deterministic fallback: no model call was made. ${input.fileCount} files described (${topLanguages || 'no languages'}). ` +
    `Frameworks declared in manifests: ${frameworks.length > 0 ? dedupe(frameworks.map(f => f.name)).join(', ') : 'none recognised'}. ` +
    `${input.routeCount} routes extracted${input.routeSource ? ` by the ${input.routeSource}` : ''}.`

  return {
    summary,
    frameworks,
    entry_points: input.entryPoints.map(e => ({ file: e.path, kind: entryKind(e.reason), description: e.reason })),
    auth_mechanisms: [...authLibraries, ...symbolMechanisms],
    data_stores,
    trust_boundaries: [],
  }
}

/**
 * One LLM call over the repo map -> the `architecture` block. On no client, a
 * failed call or an answer that is not a JSON object: markDegraded() and the
 * deterministic fallback (`source: 'deterministic'`).
 */
export async function summarizeArchitecture(
  repoMap: string,
  ctx: ArchitectureValidationContext,
  fallback: DeterministicArchitectureInput,
): Promise<ArchitectureInfo> {
  const client = createClient()
  if (!client) {
    markDegraded('architecture summary: no API key for provider — used deterministic fallback')
  } else {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildArchitecturePrompt(repoMap) }],
        ...samplingParams(PROVIDER),
        ...tokenLimitParam(PROVIDER, PROBE_CAP_LARGE),
      })
      const text = response.choices[0]?.message?.content ?? ''
      console.log('  [LLM OK] Architecture summary received a real API response')
      let parsed: unknown = null
      try {
        parsed = JSON.parse(extractJson(text))
      } catch { /* handled below */ }
      const info = validateArchitecture(parsed, ctx, 'llm', MODEL)
      if (info) return info
      console.error('  Architecture JSON unusable (first 200 chars of response:', JSON.stringify(text.substring(0, 200)), ')')
      markDegraded('architecture summary: LLM returned unparseable JSON — used deterministic fallback')
    } catch (err: any) {
      markDegraded(`architecture summary: LLM call failed (${err.message}) — used deterministic fallback`)
    }
  }
  // Never null: the fallback is always an object.
  return validateArchitecture(deterministicArchitecture(fallback), ctx, 'deterministic', null)!
}

// ===========================================================================
// 2. Tool-calling detection
// ===========================================================================

/** Text that marks a file as one that defines tools for an LLM, rather than one that merely calls a model. */
export const TOOL_DEFINITION_INDICATORS: readonly { label: string; re: RegExp }[] = [
  { label: 'tool({', re: /\btool\s*\(\s*\{/g },
  { label: 'tools: / tools=', re: /\btools\s*[:=]/g },
  { label: 'tool_calls', re: /\btool_calls\b/g },
  { label: 'function_call', re: /\bfunction_call\b/g },
  { label: '@tool', re: /@tool\b/g },
  { label: 'bind_tools', re: /\bbind_tools\b/g },
  { label: 'tool_choice', re: /\btool_choice\b/g },
  { label: '"type": "function"', re: /["']?type["']?\s*:\s*["']function["']/g },
]

/** At most this many files are judged; the verdicts are OR-ed. */
export const TOOL_CALLING_MAX_FILES = 3

export interface ToolCallingCandidate {
  path: string
  language: string
  /** Distinct indicators present. */
  score: number
  /** Total indicator occurrences, the tie-break. */
  occurrences: number
  indicators: string[]
}

/**
 * Files worth asking about, best first: inventory files that are not test,
 * oversize or empty, in an executable language, carrying the llm_call signal,
 * with at least one tool-definition indicator. Ranked by distinct indicators,
 * then total occurrences, then path. `read` returns a target-relative file's
 * content or null; recon passes the read guard, so a refused file never ranks.
 */
export function rankToolCallingCandidates(
  entries: readonly InventoryEntry[],
  signals: Readonly<Record<string, readonly string[]>>,
  read: (relPath: string) => string | null,
): ToolCallingCandidate[] {
  const out: ToolCallingCandidate[] = []
  for (const e of entries) {
    if (e.test || e.oversize || e.empty) continue
    if (!EXECUTABLE_LANGUAGES.has(e.language)) continue
    if (!(signals[e.path] ?? []).includes('llm_call')) continue
    const content = read(e.path)
    if (content === null) continue
    const indicators: string[] = []
    let occurrences = 0
    for (const ind of TOOL_DEFINITION_INDICATORS) {
      const n = content.match(ind.re)?.length ?? 0
      if (n > 0) {
        indicators.push(ind.label)
        occurrences += n
      }
    }
    if (indicators.length === 0) continue
    out.push({ path: e.path, language: e.language, score: indicators.length, occurrences, indicators })
  }
  return out.sort((a, b) =>
    b.score - a.score || b.occurrences - a.occurrences || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** A fence the content cannot close. */
function fenceFor(content: string): string {
  let fence = '```'
  while (content.includes(fence)) fence += '`'
  return fence
}

export function buildToolCallingPrompt(relPath: string, language: string, content: string): string {
  const fence = fenceFor(content)
  return `You are analyzing one source file for genuine agentic tool-calling capabilities.

File: ${relPath} (${language})

Tool-calling means the application defines tools/functions that an LLM can invoke during a conversation, with real side-effects (DB queries, API calls, state changes) -- NOT merely an "AI-sounding" route name or a plain text-completion call with no tools.

Here is the file content. Analyze it and determine:
1. Does this file contain genuine tool-calling?
2. What tools are defined? List each tool name.
3. Rate your confidence (0-1).

File content:
${fence}${language}
${content}
${fence}

Respond in JSON format only:
{
  "hasGenuineToolCalling": true/false,
  "toolsDetected": ["toolName1", "toolName2"],
  "evidence": "brief explanation",
  "confidence": 0.0-1.0
}`
}

/** The model's JSON -> a verdict, or throw so the caller falls back. */
function coerceToolVerdict(raw: unknown): ToolCallingVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('response is not a JSON object')
  const o = raw as Record<string, unknown>
  const confidence = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence)
  return {
    hasGenuineToolCalling: o.hasGenuineToolCalling === true || o.hasGenuineToolCalling === 'true',
    toolsDetected: strArr(o.toolsDetected),
    evidence: str(o.evidence),
    confidence: Number.isFinite(confidence) ? confidence : 0,
  }
}

/**
 * Judge each candidate (at most TOOL_CALLING_MAX_FILES), reading it through
 * readCorpusFile, and combine: genuine if any file is, tools unioned in rank
 * order. No candidates is an answer — not tool-calling — not a degradation.
 */
export async function detectToolCalling(
  targetDir: string,
  candidates: readonly ToolCallingCandidate[],
): Promise<ToolCallingResult> {
  const chosen = candidates.slice(0, TOOL_CALLING_MAX_FILES)
  if (chosen.length === 0) {
    return {
      hasGenuineToolCalling: false,
      evidence: 'No tool-calling candidate: no non-test source file with an LLM call carries a tool-definition indicator.',
      toolsDetected: [],
      confidence: 0,
      filesProbed: [],
      filesWithToolCalling: [],
    }
  }

  const client = createClient()
  if (!client) {
    markDegraded('tool-calling probe: no API key for provider — used deterministic analysis')
  }

  const perFile: { path: string; verdict: ToolCallingVerdict }[] = []
  for (const c of chosen) {
    const content = readCorpusFile(guardPath(targetDir, c.path))
    if (content === null) continue
    let verdict: ToolCallingVerdict | null = null
    if (client) {
      try {
        const response = await client.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: buildToolCallingPrompt(c.path, c.language, content) }],
          ...samplingParams(PROVIDER),
          ...tokenLimitParam(PROVIDER, PROBE_CAP_SMALL),
        })
        const text = response.choices[0]?.message?.content ?? '{}'
        const jsonStr = extractJson(text)
        console.log(`  [LLM OK] Tool-calling detection received a real API response (${c.path})`)
        verdict = coerceToolVerdict(JSON.parse(jsonStr))
      } catch (err: any) {
        markDegraded(`tool-calling probe: LLM call failed for ${c.path} (${err.message}) — used deterministic analysis`)
      }
    }
    perFile.push({ path: c.path, verdict: verdict ?? detectToolCallingDeterministic(content) })
  }

  // Tools are unioned over every probed file. Evidence and confidence come from
  // the files that carry the verdict: a file judged not to call tools would
  // otherwise lend its evidence text ("state-changing ...") to the category
  // probe as if it described the tools that do exist.
  const positive = perFile.filter(f => f.verdict.hasGenuineToolCalling)
  const hasGenuineToolCalling = positive.length > 0
  const agreeing = hasGenuineToolCalling ? positive : perFile
  const others = perFile.filter(f => !agreeing.includes(f)).map(f => f.path)
  return {
    hasGenuineToolCalling,
    toolsDetected: dedupe(perFile.flatMap(f => f.verdict.toolsDetected)),
    evidence: agreeing.map(f => `${f.path}: ${f.verdict.evidence}`.trim()).join(' | ') +
      (others.length > 0 ? ` | Also probed, no tool-calling found: ${others.join(', ')}` : ''),
    confidence: agreeing.length > 0 ? Math.max(...agreeing.map(f => f.verdict.confidence)) : 0,
    filesProbed: perFile.map(f => f.path),
    filesWithToolCalling: positive.map(f => f.path),
  }
}

/**
 * Deterministic fallback for tool-calling detection, over the SDK shapes that
 * define tools: AI SDK `name: tool({`, Python `@tool` functions, LangChain
 * `Tool(name=...)`, OpenAI-style `function: { name: ... }` schemas.
 */
export function detectToolCallingDeterministic(content: string): ToolCallingVerdict {
  const toolsDetected: string[] = []
  const toolPatterns = [
    /(\w+)\s*:\s*tool\(\s*\{/g,
    /@tool\b[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/g,
    /\bTool\(\s*name\s*=\s*["'](\w+)["']/g,
    /["']?function["']?\s*:\s*\{\s*["']?name["']?\s*:\s*["'](\w+)["']/g,
  ]
  for (const re of toolPatterns) {
    let match
    while ((match = re.exec(content)) !== null) {
      if (!toolsDetected.includes(match[1])) toolsDetected.push(match[1])
    }
  }

  const hasLlmCall = /\b(?:streamText|generateText|streamObject|generateObject)\s*\(|chat\.completions\.create|responses\.create|messages\.create|\.invoke\s*\(|\bChat(?:OpenAI|Anthropic)\b|generateContent\s*\(/.test(content)
  const hasToolWiring = /\bexecute\s*:|\btool_calls\b|\bfunction_call\b|\bbind_tools\b|\btool_choice\b|\btools\s*[:=]/.test(content)
  const hasStateChange = /\.(?:create|update|delete|destroy|save|insert|upsert|remove)\s*\(|\b(?:INSERT|UPDATE|DELETE)\s/.test(content)
  const hasDataRead = /\.(?:findAll|findOne|findByPk|findById|findMany|find)\s*\(|\bSELECT\s/.test(content)

  const hasGenuineToolCalling = toolsDetected.length > 0 && hasLlmCall && hasToolWiring

  let evidence = ''
  if (hasLlmCall) evidence += 'Calls an LLM API. '
  if (toolsDetected.length > 0) evidence += `Defines ${toolsDetected.length} tool(s): ${toolsDetected.join(', ')}. `
  if (hasToolWiring) evidence += 'Tools are wired into the model call or their calls are handled. '
  if (hasStateChange) evidence += 'At least one tool performs state-changing operations. '
  if (hasDataRead) evidence += 'Tools perform database reads. '

  return {
    hasGenuineToolCalling,
    evidence,
    toolsDetected,
    confidence: hasGenuineToolCalling ? 0.95 : 0.5,
  }
}

// ===========================================================================
// 3. Category applicability
// ===========================================================================

/**
 * Whether the target has authentication or authorization at all, from what
 * recon established about this target: an auth mechanism in the architecture
 * block, or a route the auth tagging marked.
 */
export function authPresence(summary: Record<string, any>): boolean {
  if ((summary?.architecture?.auth_mechanisms?.length ?? 0) > 0) return true
  const rt = summary?.route_table ?? {}
  return [...(rt.hand_written_routes ?? []), ...(rt.middleware_routes ?? [])].some((r: any) => !!r?.auth)
}

/**
 * Category applicability probe.
 * Tries LLM first, falls back to deterministic analysis based on architecture summary.
 */
export async function probeCategoryApplicability(
  architectureSummary: Record<string, any>,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): Promise<CategoryVerdict[]> {
  const client = createClient()
  if (!client) {
    markDegraded('category probe: no API key for provider — used deterministic analysis')
  }
  if (client) {
    try {
      const result = await probeViaLLM(client, JSON.stringify(architectureSummary), toolCallingVerdict, escapeHatchFindings, swaggerDiffNote)
      if (result !== null) return result
      markDegraded('category probe: LLM returned unparseable JSON — used deterministic analysis')
    } catch (err: any) {
      console.error('LLM category probe failed:', err.message)
    }
  }
  return probeDeterministic(JSON.stringify(architectureSummary), authPresence(architectureSummary), toolCallingVerdict, escapeHatchFindings, swaggerDiffNote)
}

async function probeViaLLM(
  client: OpenAI,
  architectureSummary: string,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): Promise<CategoryVerdict[] | null> {
  const hasApiSurface = swaggerDiffNote !== '' || architectureSummary.includes('/api/')
  const hasToolCalling = toolCallingVerdict.hasGenuineToolCalling

  const categories = buildCategoryList(hasApiSurface, hasToolCalling)
  const categoryListStr = categories.map(c => `- ${c.name} (${c.framework})`).join('\n')

  const prompt = `You are a security architecture analyst. Given an architecture summary, determine which vulnerability categories are APPLICABLE (present), NOT APPLICABLE (absent), or UNCERTAIN.

APPLICABLE = structural prerequisites are present.
NOT APPLICABLE = clearly lacks prerequisites.
UNCERTAIN = genuinely ambiguous from architecture alone.

Architecture summary:
---
${architectureSummary}
---

Swagger API coverage note: ${swaggerDiffNote}

${escapeHatchFindings.length > 0 ?
  `Frontend escape-hatch usage (${escapeHatchFindings.length} occurrences, frameworks: ${[...new Set(escapeHatchFindings.map(f => f.framework))].join(', ')}): ` +
  escapeHatchFindings.map(f => `${f.file}:${f.line} - ${f.type} [${f.framework}]`).join('; ')
  : 'No frontend escape-hatch usage detected.'}

Evaluate:
${categoryListStr}

Per-category evidence logic:
- A01: Applicable if authenticated, resource-scoped routes with ID params exist.
- A02: Applicable if crypto/hash operations, JWT, password handling exist.
- A03: Applicable if raw SQL, NoSQL operators, string interpolation into queries, eval/exec.
- A04: Hard to determine from architecture alone -- often uncertain.
- A05: Applicable if XML parsers with entity resolution, missing security headers, permissive CORS.
- A06: Nearly always applicable for any app with dependencies.
- A07: Applicable if auth infrastructure with login, password reset, rate limiting.
- A08: Applicable if deserialization, webhook handling, plugin loading.
- A09: Applicable if any logging module exists.
- A10: Applicable if outbound HTTP calls with dynamic URLs.
- API categories: Only if REST/API surface beyond server-rendered pages.
- LLM categories: Only if genuine tool-calling with real capabilities.

Respond in JSON array:
[{"name":"category name","framework":"framework name","verdict":"present|absent|uncertain","evidence":"brief evidence","confidence":0.0-1.0}]`

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    ...samplingParams(PROVIDER),
    ...tokenLimitParam(PROVIDER, PROBE_CAP_LARGE),
  })

  console.log('  [LLM OK] Category applicability probe received a real API response')
  const text = response.choices[0]?.message?.content ?? '[]'
  const jsonStr = extractJson(text)
  try {
    const raw = JSON.parse(jsonStr) as CategoryVerdict[]
    // Normalize verdict values: LLM may use APPLICABLE/NOT_APPLICABLE instead of present/absent
    for (const c of raw) {
      const v = (c.verdict as string).toUpperCase()
      if (v === 'APPLICABLE' || v === 'PRESENT') c.verdict = 'present'
      else if (v === 'NOT_APPLICABLE' || v === 'NOT APPLICABLE' || v === 'ABSENT') c.verdict = 'absent'
      else if (v === 'UNCERTAIN' || v === 'UNKNOWN') c.verdict = 'uncertain'
    }
    return raw
  } catch (e: any) {
    console.error('  LLM JSON parse error:', e.message, '(first 200 chars of response:', JSON.stringify(text.substring(0, 200)), ')')
    // Fall back to deterministic
    return null
  }
}

/**
 * Deterministic category applicability probe based on architecture summary.
 * Follows the evidence logic from the implementation plan's Design Notes §1.
 * `hasAuth` is authPresence() of the summary: whether this target's own auth
 * mechanisms were found, not whether its text mentions some known guard name.
 */
export function probeDeterministic(
  architectureSummary: string,
  hasAuth: boolean,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): CategoryVerdict[] {
  const verdicts: CategoryVerdict[] = []
  const s = architectureSummary

  // Detect structural signals from the summary
  const hasApiRoutes = s.includes('/api/')
  const hasRestRoutes = s.includes('"method"') && hasApiRoutes
  const hasAuthMiddleware = hasAuth
  const hasResourceScopedRoutes = s.includes('/:id') || s.includes(':id')
  const hasSequelize = s.includes('sequelize')
  const hasMongoDB = s.includes('mongodb') || s.includes('mongo')
  const hasJWT = s.includes('jwt') || s.includes('jsonwebtoken')
  const hasPasswordHandling = s.toLowerCase().includes('password')
  const hasCors = s.includes('cors')
  const hasHelmet = s.includes('helmet')
  const hasLogging = s.includes('morgan') || s.includes('logger') || s.includes('log')
  const hasRateLimit = s.includes('rateLimit') || s.includes('rate-limit')
  const hasXmlParsing = s.includes('xml') && s.toLowerCase().includes('parser')
  const hasDependencies = s.includes('dependencies')
  const hasFileUpload = s.includes('multer') || s.includes('file-upload')
  const hasOutboundHttp = false // Would need route handler inspection for this
  const hasDeserialization = s.includes('JSON.parse') || s.includes('yaml') || s.includes('js-yaml')
  const hasUndocumentedApis = swaggerDiffNote.includes('undocumented')
  const hasToolCalling = toolCallingVerdict.hasGenuineToolCalling

  // ---- OWASP Top 10 2021 ----

  // A01: Broken Access Control
  if (hasAuthMiddleware && hasResourceScopedRoutes) {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `Authenticated routes with resource-scoped access detected. Auth middleware present: routes use ${hasAuthMiddleware ? 'authorization checks' : 'various middleware'}. ID-based resource routing found.`,
      confidence: 0.9,
    })
  } else if (hasAuthMiddleware) {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication middleware detected. Whether ownership is checked per resource requires deeper analysis.',
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear authentication/access control pattern detected from architecture summary alone.',
      confidence: 0.4,
    })
  }

  // A02: Cryptographic Failures
  if (hasJWT || hasPasswordHandling) {
    verdicts.push({
      name: 'A02: Cryptographic Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `JWT usage detected${hasPasswordHandling ? ', password handling present' : ''}. Cryptographic operations exist in the application.`,
      confidence: 0.8,
    })
  } else {
    verdicts.push({
      name: 'A02: Cryptographic Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'absent',
      evidence: 'No cryptographic operations detected in architecture summary.',
      confidence: 0.5,
    })
  }

  // A03: Injection
  const hasRawSql = hasSequelize
  const hasNoSql = hasMongoDB
  if (hasRawSql || hasNoSql) {
    const parts: string[] = []
    if (hasRawSql) parts.push('Sequelize ORM detected (potential for SQL injection via raw queries)')
    if (hasNoSql) parts.push('MongoDB/NoSQL detected (potential for NoSQL operator injection)')
    verdicts.push({
      name: 'A03: Injection',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: parts.join('. ') + '. String interpolation into query execution paths requires investigation.',
      confidence: 0.8,
    })
  } else {
    verdicts.push({
      name: 'A03: Injection',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear injection sinks detected from architecture alone, but all web apps have some injection surface.',
      confidence: 0.4,
    })
  }

  // A04: Insecure Design
  verdicts.push({
    name: 'A04: Insecure Design',
    framework: 'OWASP Top 10 2021',
    verdict: 'uncertain',
    evidence: 'Insecure design is a business-logic concern that cannot be determined from architectural signals alone. Requires Stage 2 hunt lane analysis.',
    confidence: 0.3,
  })

  // A05: Security Misconfiguration
  const misconfigSignals: string[] = []
  if (hasCors) misconfigSignals.push('CORS enabled')
  if (!hasHelmet) misconfigSignals.push('No helmet middleware detected')
  if (hasXmlParsing) misconfigSignals.push('XML parsing detected (potential XXE)')

  if (misconfigSignals.length > 0) {
    verdicts.push({
      name: 'A05: Security Misconfiguration',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: misconfigSignals.join('; ') + '. Configuration review warranted.',
      confidence: 0.6,
    })
  } else {
    verdicts.push({
      name: 'A05: Security Misconfiguration',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No obvious misconfiguration markers from architecture alone, but configuration audit needed.',
      confidence: 0.4,
    })
  }

  // A06: Vulnerable and Outdated Components
  verdicts.push({
    name: 'A06: Vulnerable and Outdated Components',
    framework: 'OWASP Top 10 2021',
    verdict: hasDependencies ? 'present' : 'uncertain',
    evidence: hasDependencies
      ? 'Application has dependencies. CVE/OSV scan warranted to identify outdated or vulnerable components.'
      : 'Unable to determine dependency status from architecture alone.',
    confidence: hasDependencies ? 0.9 : 0.3,
  })

  // A07: Identification and Authentication Failures
  if (hasAuthMiddleware && hasRateLimit) {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication infrastructure present with rate limiting on some endpoints. Login/password reset flows detected.',
      confidence: 0.8,
    })
  } else if (hasAuthMiddleware) {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication infrastructure present. Whether rate limiting, brute-force protection, and credential policies are adequate requires deeper analysis.',
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'absent',
      evidence: 'No authentication infrastructure detected in architecture summary.',
      confidence: 0.5,
    })
  }

  // A08: Software and Data Integrity Failures
  if (hasDeserialization || hasFileUpload) {
    verdicts.push({
      name: 'A08: Software and Data Integrity Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `Deserialization and/or file upload capabilities detected.${hasFileUpload ? ' File upload with zip/xml/yaml handling present.' : ''}`,
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A08: Software and Data Integrity Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear deserialization or integrity-sensitive patterns detected from architecture alone.',
      confidence: 0.3,
    })
  }

  // A09: Security Logging and Monitoring Failures
  verdicts.push({
    name: 'A09: Security Logging and Monitoring Failures',
    framework: 'OWASP Top 10 2021',
    verdict: hasLogging ? 'present' : 'uncertain',
    evidence: hasLogging
      ? 'Logging infrastructure present (morgan/logger). Whether logs reach a monitored destination in production is a deployment concern.'
      : 'No clear logging infrastructure detected.',
    confidence: hasLogging ? 0.6 : 0.3,
  })

  // A10: SSRF
  verdicts.push({
    name: 'A10: Server-Side Request Forgery (SSRF)',
    framework: 'OWASP Top 10 2021',
    verdict: hasOutboundHttp ? 'present' : 'uncertain',
    evidence: hasOutboundHttp
      ? 'Outbound HTTP calls detected. Whether URLs are user-controllable requires handler-level analysis.'
      : 'No outbound HTTP calls detected from architecture summary. May still exist in route handlers not visible at this level.',
    confidence: hasOutboundHttp ? 0.7 : 0.3,
  })

  // ---- API Security Top 10 ----
  if (hasRestRoutes) {
    const hasIdParams = s.includes('/:id') || s.includes(':id')
    const hasMassAssignment = s.includes('excludeAttributes') // Mass assignment signal from auto-CRUD
    const hasUndocumented = swaggerDiffNote.includes('undocumented')

    verdicts.push({
      name: 'API1: Broken Object Level Authorization (BOLA)',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware && hasIdParams ? 'present' : 'uncertain',
      evidence: hasAuthMiddleware && hasIdParams
        ? 'REST API routes with ID-shaped parameters detected. Whether per-request ownership is validated requires hunt lane analysis.'
        : 'API surface detected but BOLA applicability unclear.',
      confidence: hasAuthMiddleware && hasIdParams ? 0.8 : 0.4,
    })

    verdicts.push({
      name: 'API2: Broken Authentication',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware ? 'present' : 'uncertain',
      evidence: 'API surface with authentication detected.',
      confidence: 0.6,
    })

    verdicts.push({
      name: 'API3: Broken Object Property Level Authorization',
      framework: 'API Security Top 10',
      verdict: hasMassAssignment ? 'present' : 'uncertain',
      evidence: hasMassAssignment
        ? 'Auto-CRUD framework with excludeAttributes detected. Mass assignment surface exists; excluded fields need review.'
        : 'Auto-CRUD or mass assignment surface unclear.',
      confidence: hasMassAssignment ? 0.8 : 0.4,
    })

    verdicts.push({
      name: 'API4: Unrestricted Resource Consumption',
      framework: 'API Security Top 10',
      verdict: 'present',
      evidence: 'API routes detected. Whether pagination, rate limiting, and request size limits are enforced on all endpoints requires per-endpoint analysis.',
      confidence: 0.6,
    })

    verdicts.push({
      name: 'API5: Broken Function Level Authorization',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware ? 'present' : 'uncertain',
      evidence: 'Multiple API endpoints with varying auth levels detected. Whether role-based access control is consistently enforced requires analysis.',
      confidence: 0.7,
    })

    verdicts.push({
      name: 'API6: Unrestricted Access to Sensitive Business Flows',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'Whether sensitive business flows (purchases, sign-up, redemption and the like) are protected against automation requires deeper analysis.',
      confidence: 0.4,
    })

    verdicts.push({
      name: 'API7: Server Side Request Forgery',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'SSRF in API context requires identifying outbound calls with user-controlled URLs. Not determinable from architecture summary alone.',
      confidence: 0.3,
    })

    verdicts.push({
      name: 'API8: Security Misconfiguration',
      framework: 'API Security Top 10',
      verdict: 'present',
      evidence: swaggerDiffNote || 'API configuration review warranted.',
      confidence: 0.5,
    })

    verdicts.push({
      name: 'API9: Improper Inventory Management',
      framework: 'API Security Top 10',
      verdict: hasUndocumented ? 'present' : 'uncertain',
      evidence: hasUndocumented
        ? swaggerDiffNote
        : 'API inventory completeness cannot be assessed from architecture alone.',
      confidence: hasUndocumented ? 0.9 : 0.4,
    })

    verdicts.push({
      name: 'API10: Unsafe Consumption of APIs',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'Whether the app consumes third-party APIs and validates their responses requires route handler analysis.',
      confidence: 0.3,
    })
  }

  // ---- LLM Top 10 ----
  if (hasToolCalling) {
    verdicts.push({
      name: 'LLM01: Prompt Injection',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: `Genuine tool-calling detected with ${toolCallingVerdict.toolsDetected.length} tools. Whether untrusted input reaches the prompt and whether prompt fencing is adequate requires Stage 2 analysis.`,
      confidence: 0.7,
    })

    verdicts.push({
      name: 'LLM02: Sensitive Information Disclosure',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: 'LLM tool handlers can reach application data. Whether sensitive fields are properly filtered requires analysis.',
      confidence: 0.7,
    })

    verdicts.push({
      name: 'LLM03: Supply Chain',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: 'LLM SDK dependencies detected. Whether model provider URL and API key are properly configured vs. dynamically controllable from untrusted sources requires analysis.',
      confidence: 0.5,
    })

    // LLM05: Improper Output Handling
    const hasClientSideRendering = escapeHatchFindings.length > 0
    verdicts.push({
      name: 'LLM05: Improper Output Handling',
      framework: 'LLM Top 10',
      verdict: hasClientSideRendering ? 'present' : 'uncertain',
      evidence: hasClientSideRendering
        ? `LLM tool-calling detected AND ${escapeHatchFindings.length} frontend escape-hatch usage points found (${[...new Set(escapeHatchFindings.map(f => f.framework))].join(', ')}). LLM output reaching HTML rendering sinks without sanitization is a concrete concern.`
        : 'LLM tool-calling detected but client-side rendering sinks not identified from architecture alone.',
      confidence: hasClientSideRendering ? 0.8 : 0.5,
    })

    // LLM06: Excessive Agency
    const hasStateChangingTools = toolCallingVerdict.evidence.includes('state-changing')
    verdicts.push({
      name: 'LLM06: Excessive Agency',
      framework: 'LLM Top 10',
      verdict: hasStateChangingTools ? 'present' : 'uncertain',
      evidence: hasStateChangingTools
        ? `Tools with state-changing capabilities detected (${toolCallingVerdict.toolsDetected.join(', ')}). Whether authorization is independently re-derived inside each handler requires analysis.`
        : 'LLM tools detected but state-changing nature unclear.',
      confidence: hasStateChangingTools ? 0.8 : 0.5,
    })

    // LLM10: Unbounded Consumption. Uncertain either way: whether the tool
    // loop is capped is a property of the call site, not of the architecture.
    verdicts.push({
      name: 'LLM10: Unbounded Consumption',
      framework: 'LLM Top 10',
      verdict: 'uncertain',
      evidence: 'Whether a step/turn cap and a per-request budget bound the tool-calling loop requires config analysis; not determinable from architecture alone.',
      confidence: 0.5,
    })
  }

  return verdicts
}

function buildCategoryList(hasApiSurface: boolean, hasToolCalling: boolean): { name: string; framework: string }[] {
  const categories: { name: string; framework: string }[] = [
    { name: 'A01: Broken Access Control', framework: 'OWASP Top 10 2021' },
    { name: 'A02: Cryptographic Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A03: Injection', framework: 'OWASP Top 10 2021' },
    { name: 'A04: Insecure Design', framework: 'OWASP Top 10 2021' },
    { name: 'A05: Security Misconfiguration', framework: 'OWASP Top 10 2021' },
    { name: 'A06: Vulnerable and Outdated Components', framework: 'OWASP Top 10 2021' },
    { name: 'A07: Identification and Authentication Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A08: Software and Data Integrity Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A09: Security Logging and Monitoring Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A10: Server-Side Request Forgery (SSRF)', framework: 'OWASP Top 10 2021' },
  ]

  if (hasApiSurface) {
    categories.push(
      { name: 'API1: Broken Object Level Authorization (BOLA)', framework: 'API Security Top 10' },
      { name: 'API2: Broken Authentication', framework: 'API Security Top 10' },
      { name: 'API3: Broken Object Property Level Authorization', framework: 'API Security Top 10' },
      { name: 'API4: Unrestricted Resource Consumption', framework: 'API Security Top 10' },
      { name: 'API5: Broken Function Level Authorization', framework: 'API Security Top 10' },
      { name: 'API6: Unrestricted Access to Sensitive Business Flows', framework: 'API Security Top 10' },
      { name: 'API7: Server Side Request Forgery', framework: 'API Security Top 10' },
      { name: 'API8: Security Misconfiguration', framework: 'API Security Top 10' },
      { name: 'API9: Improper Inventory Management', framework: 'API Security Top 10' },
      { name: 'API10: Unsafe Consumption of APIs', framework: 'API Security Top 10' },
    )
  }

  if (hasToolCalling) {
    categories.push(
      { name: 'LLM01: Prompt Injection', framework: 'LLM Top 10' },
      { name: 'LLM02: Sensitive Information Disclosure', framework: 'LLM Top 10' },
      { name: 'LLM03: Supply Chain', framework: 'LLM Top 10' },
      { name: 'LLM05: Improper Output Handling', framework: 'LLM Top 10' },
      { name: 'LLM06: Excessive Agency', framework: 'LLM Top 10' },
      { name: 'LLM10: Unbounded Consumption', framework: 'LLM Top 10' },
    )
  }

  return categories
}

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()
  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
  if (jsonMatch) return jsonMatch[1].trim()
  return text.trim()
}
