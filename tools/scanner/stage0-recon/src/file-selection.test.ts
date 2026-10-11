/**
 * Tests for file selection (file-selection.ts). Run: npx tsx src/file-selection.test.ts
 *
 * Every fixture is built under os.tmpdir() and removed afterwards; nothing here
 * reads or writes inside the repository.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { selectFiles, selectFilesWithRunsRoot, selectionOptionsFromEnv, DEFAULT_MAX_FILE_BYTES } from './file-selection.js'
import { resolveRunContext } from '../../shared/run-context.js'
import type { ExclusionReason, FileInventoryArtifact, InventoryEntry } from './recon-contract.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'file-selection-test-'))

/** Build a fixture tree: { relPath: content }. */
function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(scratch, name)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  fs.mkdirSync(root, { recursive: true })
  return root
}

const entry = (a: FileInventoryArtifact, p: string): InventoryEntry | undefined => a.files.find((f) => f.path === p)
const inventoried = (a: FileInventoryArtifact, p: string) => entry(a, p) !== undefined
const group = (a: FileInventoryArtifact, r: ExclusionReason) => a.excluded.find((g) => g.reason === r)
const exFile = (a: FileInventoryArtifact, r: ExclusionReason, p: string) => group(a, r)?.files.includes(p) ?? false
const exDir = (a: FileInventoryArtifact, r: ExclusionReason, p: string) => group(a, r)?.dirs.includes(p) ?? false
/** Listed anywhere in the excluded groups, under any reason. */
const listed = (a: FileInventoryArtifact, p: string) => a.excluded.some((g) => g.files.includes(p) || g.dirs.includes(p))
const sorted = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x)
const CODE = 'export const x = 1\n'

try {
  // -------------------------------------------------------------------------
  console.log('\n-- ignore files: .gitignore (nested, negation) and .secscanignore --')
  {
    const root = fixture('ignore', {
      // Juice Shop's own lines, verbatim: app/ then !frontend/src/app, and
      // assets/ then !frontend/src/assets/. Both directories must stay in.
      '.gitignore': [
        '# App', 'app/', '!frontend/src/app', 'ignored-*.ts', 'config/*.yml', '!config/default.yml',
        '', '# Branch ghpages', 'assets/', '!frontend/src/assets/', 'gen/', 'caps.ts', '*.gen.ts',
      ].join('\n') + '\n',
      'Caps.ts': CODE,
      'app/server.ts': CODE,
      'app/.gitignore': 'nothing-here.ts\n',
      'frontend/src/app/main.ts': CODE,
      'frontend/src/app/nested/deep.ts': CODE,
      'frontend/src/assets/i18n/en.json': '{}\n',
      'frontend/src/assets/public/theme.css': 'a{}\n',
      'assets/logo.css': 'a{}\n',
      'lib/assets/x.ts': CODE,
      'config/default.yml': 'a: 1\n',
      'config/local.yml': 'a: 1\n',
      'ignored-root.ts': CODE,
      'ignored-secscan-keep.ts': CODE,
      'local.ts': CODE,
      'anchored.ts': CODE,
      // A deeper .gitignore: re-includes one file, ignores two of its own.
      'sub/.gitignore': '!ignored-keep.ts\nlocal.ts\n/anchored.ts\n',
      'sub/ignored-keep.ts': CODE,
      'sub/ignored-drop.ts': CODE,
      'sub/local.ts': CODE,
      'sub/anchored.ts': CODE,
      'sub/deeper/anchored.ts': CODE,
      // A deeper .gitignore re-including a directory the root one excludes.
      'gen/b.ts': CODE,
      'pkg/.gitignore': '!gen/\n',
      'pkg/gen/a.ts': CODE,
      'pkg/gen/c.gen.ts': CODE,
      '.secscanignore': 'skipme/\n*.skip.ts\n!ignored-secscan-keep.ts\n',
      'skipme/x.ts': CODE,
      'a.skip.ts': CODE,
    })
    const a = selectFiles(root)

    check('app/ is gitignored as a directory', exDir(a, 'gitignore', 'app/'))
    check('frontend/src/app is re-included (!frontend/src/app)', inventoried(a, 'frontend/src/app/main.ts'))
    check('frontend/src/app subdirectories too', inventoried(a, 'frontend/src/app/nested/deep.ts'))
    check('assets/ is gitignored as a directory', exDir(a, 'gitignore', 'assets/'))
    check('assets/ matches at any depth', exDir(a, 'gitignore', 'lib/assets/'))
    check('frontend/src/assets is re-included (!frontend/src/assets/)',
      inventoried(a, 'frontend/src/assets/i18n/en.json') && inventoried(a, 'frontend/src/assets/public/theme.css'))
    check('config/*.yml minus a negation', exFile(a, 'gitignore', 'config/local.yml') && inventoried(a, 'config/default.yml'))
    check('root pattern ignores a file', exFile(a, 'gitignore', 'ignored-root.ts'))
    check('deeper !pattern re-includes', inventoried(a, 'sub/ignored-keep.ts'))
    check('root pattern still applies below a deeper file', exFile(a, 'gitignore', 'sub/ignored-drop.ts'))
    check('deeper pattern applies to its own directory', exFile(a, 'gitignore', 'sub/local.ts'))
    check('deeper pattern does not reach the root', inventoried(a, 'local.ts'))
    check('deeper /anchored is anchored to its directory',
      exFile(a, 'gitignore', 'sub/anchored.ts') && inventoried(a, 'sub/deeper/anchored.ts') && inventoried(a, 'anchored.ts'))
    check('patterns are case-sensitive, as git is by default', inventoried(a, 'Caps.ts'))
    check('root gen/ excludes the root directory', exDir(a, 'gitignore', 'gen/'))
    check('a deeper .gitignore can re-include a directory', inventoried(a, 'pkg/gen/a.ts'))
    check('a shallower pattern still applies inside the re-included directory', exFile(a, 'gitignore', 'pkg/gen/c.gen.ts'))
    check('.secscanignore excludes a directory', exDir(a, 'secscanignore', 'skipme/'))
    check('.secscanignore excludes a file', exFile(a, 'secscanignore', 'a.skip.ts'))
    check('.secscanignore is applied after .gitignore', inventoried(a, 'ignored-secscan-keep.ts'))
    check('ignore_files lists every honoured file',
      JSON.stringify(a.ignore_files) === JSON.stringify(['.gitignore', '.secscanignore', 'pkg/.gitignore', 'sub/.gitignore']))
    check('a .gitignore inside an ignored directory is never read', !a.ignore_files.includes('app/.gitignore'))
  }

  {
    // Only ignore files at or below the target count: scanning a subdirectory
    // of a repo must not apply the repo's own .gitignore.
    const outer = fixture('outer', { '.gitignore': '*.ts\n', 'inner/a.ts': CODE })
    const a = selectFiles(path.join(outer, 'inner'))
    check('a .gitignore above the target is not applied', inventoried(a, 'a.ts') && a.ignore_files.length === 0)
  }

  // -------------------------------------------------------------------------
  console.log('\n-- directory classes --')
  {
    const tool = ['.git', '.hg', '.svn', '.secscan', '.qwen']
    const vendor = [
      'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', '.venv', 'venv',
      'virtualenv', 'site-packages', '__pycache__', '.tox', '.nox', '.eggs', '.bundle', 'Pods',
      'Carthage', '.gradle', '.yarn', '.pnpm-store', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    ]
    const build = [
      'dist', 'build', 'out', 'target', 'coverage', '.nyc_output', '.next', '.nuxt', '.output',
      '.angular', '.svelte-kit', '.parcel-cache', '.cache', '.turbo', '.vercel', '.serverless',
      '.terraform', 'storybook-static',
    ]
    const files: Record<string, string> = {
      'src/keep.ts': CODE,
      'myenv/pyvenv.cfg': 'home = /usr/bin\n',
      'myenv/lib/site.py': 'x = 1\n',
      'deep/er/node_modules/pkg/index.js': CODE,
      'node_modules/.gitignore': '*\n',
    }
    for (const d of [...tool, ...vendor, ...build]) files[`${d}/f.ts`] = CODE
    const a = selectFiles(fixture('classes', files))

    check('every tool_dir name excluded', tool.every((d) => exDir(a, 'tool_dir', d + '/')))
    check('every vendor_dir name excluded', vendor.every((d) => exDir(a, 'vendor_dir', d + '/')))
    check('every build_dir name excluded', build.every((d) => exDir(a, 'build_dir', d + '/')))
    check('a directory holding pyvenv.cfg is vendor_dir', exDir(a, 'vendor_dir', 'myenv/'))
    check('class names match at any depth', exDir(a, 'vendor_dir', 'deep/er/node_modules/'))
    check('nothing inside an excluded directory is walked',
      a.files.every((f) => f.path === 'src/keep.ts') && a.files.length === 1 && a.unsupported.count === 0)
    check('a .gitignore inside an excluded directory is never read', a.ignore_files.length === 0)
    check('excluded_dirs total', a.totals.excluded_dirs === tool.length + vendor.length + build.length + 2)

    // Pre-v3 exclusions: Stage 0's EXCLUDED_DIRS and Stage 0.5's walk list.
    const legacy = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output',
      '.angular', '.cache', 'out', '.turbo', '.vercel', '.secscan', '.qwen']
    check('every pre-v3 Stage 0 / Stage 0.5 exclusion still excluded', legacy.every((d) => listed(a, d + '/')))
  }

  // -------------------------------------------------------------------------
  console.log('\n-- lockfiles, manifests, new extensions, unsupported --')
  {
    const a = selectFiles(fixture('kinds', {
      'package.json': '{"name":"x"}\n',
      'package-lock.json': '{}\n',
      'web/pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'yarn.lock': '# yarn\n',
      'rust/Cargo.lock': '# cargo\n',
      'go.sum': 'x v1 h1:\n',
      'Gemfile.lock': 'GEM\n',
      'py/poetry.lock': '# poetry\n',
      'requirements.txt': 'flask==3.0.0\n',
      'requirements/dev.txt': 'pytest\n',
      'go.mod': 'module x\n',
      'Gemfile': "gem 'rails'\n",
      'a.mjs': CODE, 'b.cjs': CODE, 'c.mts': CODE, 'd.c': 'int x;\n', 'd.h': 'int x;\n',
      'e.cpp': 'int x;\n', 'f.swift': 'let x = 1\n', 'g.dart': 'var x = 1;\n',
      'README.md': '# hi\n', 'logo.png': 'png', 'LICENSE': 'MIT\n',
    }))
    check('package-lock.json excluded as lockfile', exFile(a, 'lockfile', 'package-lock.json'))
    check('pnpm-lock.yaml excluded as lockfile', exFile(a, 'lockfile', 'web/pnpm-lock.yaml'))
    for (const p of ['yarn.lock', 'rust/Cargo.lock', 'go.sum', 'Gemfile.lock', 'py/poetry.lock']) {
      check(`${p} (no language) excluded as lockfile, not unsupported`, exFile(a, 'lockfile', p) && !inventoried(a, p))
    }
    check('lockfile group lists every lockfile, sorted', JSON.stringify(group(a, 'lockfile')?.files) === JSON.stringify(
      ['Gemfile.lock', 'go.sum', 'package-lock.json', 'py/poetry.lock', 'rust/Cargo.lock', 'web/pnpm-lock.yaml', 'yarn.lock']))
    check('package.json inventoried as json', entry(a, 'package.json')?.language === 'json')
    check('requirements.txt inventoried as manifest', entry(a, 'requirements.txt')?.language === 'manifest')
    check('requirements/dev.txt inventoried as manifest', entry(a, 'requirements/dev.txt')?.language === 'manifest')
    check('go.mod inventoried as manifest', entry(a, 'go.mod')?.language === 'manifest')
    check('Gemfile inventoried as manifest', entry(a, 'Gemfile')?.language === 'manifest')
    const langs: [string, string][] = [['a.mjs', 'javascript'], ['b.cjs', 'javascript'], ['c.mts', 'typescript'],
      ['d.c', 'c'], ['d.h', 'c'], ['e.cpp', 'cpp'], ['f.swift', 'swift'], ['g.dart', 'dart']]
    for (const [p, lang] of langs) check(`${path.extname(p)} inventoried as ${lang}`, entry(a, p)?.language === lang)
    check('files with no language are counted, never listed',
      a.unsupported.count === 3 && !listed(a, 'README.md') && !inventoried(a, 'README.md'))
    check('unsupported by extension',
      JSON.stringify(a.unsupported.by_extension) === JSON.stringify({ '(none)': 1, '.md': 1, '.png': 1 }))
  }

  // -------------------------------------------------------------------------
  console.log('\n-- minified and generated --')
  {
    const longLine = 'var a=' + '1+'.repeat(3500) + '1;\n'           // one 7,000-character line
    const shortLines = 'var a = 1\n'.repeat(400)                     // 4,000 bytes of short lines
    const oneLongManyShort = longLine + 'x\n'.repeat(400)            // longest > 5,000, mean < 250
    const a = selectFiles(fixture('minigen', {
      'static/app.min.js': CODE, 'static/style.min.css': 'a{}\n', 'static/esm.min.mjs': CODE,
      'static/cjs.min.cjs': CODE, 'static/lib-min.js': CODE,
      'static/bundle.js': longLine, 'static/bundle.css': 'a{color:red}'.repeat(600),
      'static/readable.js': shortLines, 'static/one-long-line.js': oneLongManyShort,
      'src/long.ts': longLine,
      'api.pb.go': CODE, 'msg_pb2.py': CODE, 'msg_pb2_grpc.py': CODE, 'x.pb.cc': CODE, 'x.pb.h': CODE,
      'm.g.dart': CODE, 'm.freezed.dart': CODE, 'Form1.Designer.cs': CODE, 'R.g.cs': CODE,
      'types.generated.ts': CODE,
      'gen1.go': '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x\n',
      'gen2.ts': '/* @generated */\nexport const x = 1\n',
      'gen3.cs': '// <auto-generated />\nclass X {}\n',
      'gen4.py': '# This file was automatically generated\nx = 1\n',
      'gen5.java': '// This file is auto-generated\nclass X {}\n',
      'gen6.cc': '// Generated by the protocol buffer compiler.  DO NOT EDIT!\nint x;\n',
      'Entity.java': 'import javax.persistence.*;\nclass E { @Id @GeneratedValue Long id; }\n',
      'late.ts': '// ' + 'x'.repeat(1100) + '\n// @generated\n',
    }))
    for (const p of ['static/app.min.js', 'static/style.min.css', 'static/esm.min.mjs', 'static/cjs.min.cjs', 'static/lib-min.js']) {
      check(`minified by name: ${path.basename(p)}`, exFile(a, 'minified', p))
    }
    check('minified by content: javascript', exFile(a, 'minified', 'static/bundle.js'))
    check('minified by content: css', exFile(a, 'minified', 'static/bundle.css'))
    check('short-lined javascript is kept', inventoried(a, 'static/readable.js'))
    check('one long line among many short ones is kept', inventoried(a, 'static/one-long-line.js'))
    check('typescript is never judged minified by content', inventoried(a, 'src/long.ts'))
    for (const p of ['api.pb.go', 'msg_pb2.py', 'msg_pb2_grpc.py', 'x.pb.cc', 'x.pb.h', 'm.g.dart',
      'm.freezed.dart', 'Form1.Designer.cs', 'R.g.cs', 'types.generated.ts']) {
      check(`generated by name: ${p}`, exFile(a, 'generated', p))
    }
    for (const p of ['gen1.go', 'gen2.ts', 'gen3.cs', 'gen4.py', 'gen5.java', 'gen6.cc']) {
      check(`generated by header: ${p}`, exFile(a, 'generated', p))
    }
    check('@GeneratedValue is not a generated header', inventoried(a, 'Entity.java'))
    check('a marker past the first 1 KB is not a header', inventoried(a, 'late.ts'))
  }

  // -------------------------------------------------------------------------
  console.log('\n-- byte cap and empty files --')
  {
    const root = fixture('cap', {
      'small.ts': CODE,
      'at-cap.ts': 'x'.repeat(100),
      'big.ts': 'x'.repeat(101),
      'big-gen.ts': '// @generated\n' + 'x'.repeat(200),
      'big-space.ts': ' '.repeat(200),
      'big-mini.js': 'var a=' + '1+'.repeat(3500) + '1;',
      'big.min.js': 'x'.repeat(200),
    })
    // Record every path file selection opens, to prove an oversize file's
    // content is never read. The positive control below shows the hook works.
    const require = createRequire(import.meta.url)
    const fsCjs = require('node:fs') as typeof fs & Record<string, unknown>
    const orig = { readFileSync: fsCjs.readFileSync, openSync: fsCjs.openSync }
    const opened: string[] = []
    fsCjs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      opened.push(String(p)); return (orig.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readFileSync
    fsCjs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p)); return (orig.openSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    let a: FileInventoryArtifact
    try {
      a = selectFiles(root, { max_file_bytes: 100 })
    } finally {
      fsCjs.readFileSync = orig.readFileSync
      fsCjs.openSync = orig.openSync
      syncBuiltinESMExports()
    }
    const readOf = (p: string) => opened.includes(path.join(fs.realpathSync(root), p))

    check('options recorded', a.options.max_file_bytes === 100 && a.options.include_tests === false)
    check('at the cap is not oversize', entry(a, 'at-cap.ts')?.oversize === false)
    check('over the cap is oversize', entry(a, 'big.ts')?.oversize === true && entry(a, 'big.ts')?.bytes === 101)
    check('oversize: generated header not read', entry(a, 'big-gen.ts')?.oversize === true)
    check('oversize: whitespace-only not read, so not empty', entry(a, 'big-space.ts')?.empty === false)
    check('oversize: minified content not read', entry(a, 'big-mini.js')?.oversize === true)
    check('oversize: name rules still apply', exFile(a, 'minified', 'big.min.js'))
    check('positive control: a small file is read', readOf('small.ts'))
    check('no oversize file is ever opened',
      !['big.ts', 'big-gen.ts', 'big-space.ts', 'big-mini.js', 'big.min.js'].some(readOf))
    check('oversize total', a.totals.oversize === 4)

    const b = selectFiles(fixture('empty', {
      'zero.ts': '',
      'spaces.ts': '  \n\t\n',
      'long-spaces.ts': ' '.repeat(2000) + '\n',
      'spaces-then-code.ts': ' '.repeat(1500) + 'x',
      'code.ts': CODE,
    }))
    check('zero bytes is empty', entry(b, 'zero.ts')?.empty === true)
    check('whitespace only is empty', entry(b, 'spaces.ts')?.empty === true)
    check('whitespace only past the first 1 KB is empty', entry(b, 'long-spaces.ts')?.empty === true)
    check('code after 1 KB of whitespace is not empty', entry(b, 'spaces-then-code.ts')?.empty === false)
    check('code is not empty', entry(b, 'code.ts')?.empty === false)
    check('empty files stay inventoried', b.totals.inventoried === 5 && b.totals.empty === 3)
  }

  // -------------------------------------------------------------------------
  console.log('\n-- test files --')
  {
    const testPaths = [
      'test/a.ts', 'tests/b.py', 'src/__tests__/c.js', 'src/__test__/c.js', 'spec/d.rb', 'specs/d.rb',
      'e2e/e.ts', 'cypress/f.ts', 'pkg/testdata/g.go', 'src/__mocks__/h.ts', 'src/__fixtures__/i.ts',
      'src/a.spec.ts', 'src/b.test.js', 'x_test.go', 'test_y.py', 'y_test.py', 'FooTest.java',
      'FooTests.java', 'FooTest.kt', 'foo_spec.rb', 'foo_test.rb', 'FooTest.php', 'FooTests.cs', 'FooTest.cs',
    ]
    const notTest = [
      'Latest.java', 'contest.py', 'attest.go', 'testing/x.ts', 'src/test.ts', 'src/testHelpers.ts',
      'Tests/x.swift', // directory names are matched exactly, as listed
    ]
    const files: Record<string, string> = {}
    for (const p of [...testPaths, ...notTest]) files[p] = CODE
    const root = fixture('tests', files)
    const a = selectFiles(root)
    for (const p of testPaths) check(`test: ${p}`, entry(a, p)?.test === true)
    for (const p of notTest) check(`not test: ${p}`, entry(a, p)?.test === false)
    check('test files stay inventoried', a.totals.inventoried === testPaths.length + notTest.length)
    check('test total', a.totals.test === testPaths.length)
    const b = selectFiles(root, { include_tests: true })
    check('include_tests clears every test flag', b.files.every((f) => !f.test) && b.totals.test === 0)
    check('include_tests recorded', b.options.include_tests === true)
  }

  // -------------------------------------------------------------------------
  console.log('\n-- symlinks --')
  {
    const root = fixture('links', { 'real/target.ts': CODE })
    fs.symlinkSync('real/target.ts', path.join(root, 'link-file.ts'))
    fs.symlinkSync('real', path.join(root, 'link-dir'))
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
    fs.symlinkSync('real/.gitignore-target', path.join(root, '.gitignore'))
    fs.writeFileSync(path.join(root, 'real/.gitignore-target'), 'target.ts\n')
    const a = selectFiles(root)
    check('the real file is inventoried once', a.files.length === 1 && inventoried(a, 'real/target.ts'))
    check('a symlinked file is not inventoried', !inventoried(a, 'link-file.ts') && exFile(a, 'symlink', 'link-file.ts'))
    check('a symlinked directory is not followed', !a.files.some((f) => f.path.startsWith('link-dir/')) && exFile(a, 'symlink', 'link-dir'))
    check('a symlink out of the target is not followed', exFile(a, 'symlink', 'escape'))
    check('a symlinked .gitignore is not honoured', a.ignore_files.length === 0 && exFile(a, 'symlink', '.gitignore'))
  }

  // -------------------------------------------------------------------------
  console.log('\n-- the run\'s artifact root inside the target --')
  {
    const root = fixture('runsroot', {
      'src/a.ts': CODE,
      'scan-out/luna/stage0-recon/file-signals.json': '{}',
      'nested/deeper/runs/luna/x.json': '{}',
      'nested/deeper/keep.ts': CODE,
      'Scan-Out-Sibling/b.ts': CODE,
    })
    const real = fs.realpathSync(root)
    // Built the way guard.test.ts builds one: an explicit env, no argv.
    const ctxFor = (env: Record<string, string>) => resolveRunContext(env, [], real)
    const inside = ctxFor({ SCANNER_TARGET: real, SCANNER_RUNS_ROOT: path.join(real, 'scan-out') })
    check('fixture context is a product run with runsRoot inside the target',
      inside.profile === 'product' && inside.runsRoot === path.join(real, 'scan-out'))
    const a = selectFilesWithRunsRoot(root, {}, inside.runsRoot)
    check('runsRoot inside the target is excluded as tool_dir', exDir(a, 'tool_dir', 'scan-out/'))
    check('nothing under it is inventoried', !a.files.some((f) => f.path.startsWith('scan-out/')))
    check('the rest of the target is still selected', inventoried(a, 'src/a.ts') && inventoried(a, 'Scan-Out-Sibling/b.ts'))

    const deep = selectFilesWithRunsRoot(root, {}, ctxFor({ SCANNER_TARGET: real, SCANNER_RUNS_ROOT: path.join(real, 'nested/deeper/runs') }).runsRoot)
    check('a deeper runsRoot is excluded at its own level', exDir(deep, 'tool_dir', 'nested/deeper/runs/') && inventoried(deep, 'nested/deeper/keep.ts'))
    check('relative SCANNER_RUNS_ROOT resolves the same way',
      exDir(selectFilesWithRunsRoot(root, {}, ctxFor({ SCANNER_TARGET: real, SCANNER_RUNS_ROOT: 'scan-out' }).runsRoot), 'tool_dir', 'scan-out/'))
    const linkToRoot = path.join(scratch, 'runsroot-link')
    fs.symlinkSync(real, linkToRoot)
    check('runsRoot is compared after resolving symlinks',
      exDir(selectFilesWithRunsRoot(root, {}, path.join(linkToRoot, 'scan-out')), 'tool_dir', 'scan-out/'))

    const baseline = JSON.stringify({ ...selectFilesWithRunsRoot(root, {}, null), generated_at: null })
    const same = (runsRoot: string) => JSON.stringify({ ...selectFilesWithRunsRoot(root, {}, runsRoot), generated_at: null }) === baseline
    check('runsRoot equal to the target excludes nothing', same(ctxFor({ SCANNER_TARGET: real, SCANNER_RUNS_ROOT: real }).runsRoot))
    check('runsRoot above the target excludes nothing', same(ctxFor({ SCANNER_TARGET: real, SCANNER_RUNS_ROOT: scratch }).runsRoot))
    check('runsRoot elsewhere excludes nothing', same(os.tmpdir()))
    check('a runsRoot that is a prefix but not a parent excludes nothing', same(path.join(real, 'scan')))
    check('without a runsRoot the artifacts are just files', inventoried(selectFilesWithRunsRoot(root, {}, null), 'scan-out/luna/stage0-recon/file-signals.json'))
    // selectFiles takes the process's context; in this test process that is
    // the benchmark, whose runs root is outside every fixture.
    check('selectFiles resolves the context lazily and excludes nothing here', JSON.stringify({ ...selectFiles(root), generated_at: null }) === baseline)
  }

  // -------------------------------------------------------------------------
  console.log('\n-- determinism and ordering --')
  {
    const root = fixture('order', {
      'b.ts': CODE, 'a-b.ts': CODE, 'a/b.ts': CODE, 'A.ts': CODE, 'z/y/x.ts': CODE,
      'dist/x.js': CODE, 'build/x.js': CODE, 'node_modules/x.js': CODE, 'out/x.js': CODE,
      'yarn.lock': '', 'package-lock.json': '{}', 'z/package-lock.json': '{}', 'm.min.js': CODE, 'a.min.js': CODE,
      '.gitignore': 'zz-ignored.ts\naa-ignored.ts\n', 'zz-ignored.ts': CODE, 'aa-ignored.ts': CODE,
    })
    const strip = (x: FileInventoryArtifact) => JSON.stringify({ ...x, generated_at: null })
    const one = selectFiles(root)
    const two = selectFiles(root)
    check('two calls are identical apart from generated_at', strip(one) === strip(two))
    check('generated_at is an ISO timestamp', !Number.isNaN(Date.parse(one.generated_at)))
    const paths = one.files.map((f) => f.path)
    check('files sorted by path', sorted(paths))
    check('code-unit order, not walk order: a-b.ts before a/b.ts', paths.indexOf('a-b.ts') < paths.indexOf('a/b.ts'))
    check('excluded groups sorted by reason', sorted(one.excluded.map((g) => g.reason)))
    check('paths in each group sorted', one.excluded.every((g) => sorted(g.dirs) && sorted(g.files)))
    check('build_dir group', JSON.stringify(group(one, 'build_dir')?.dirs) === JSON.stringify(['build/', 'dist/', 'out/']))
    check('lockfile group', JSON.stringify(group(one, 'lockfile')?.files) === JSON.stringify(['package-lock.json', 'yarn.lock', 'z/package-lock.json']))
    check('gitignore group', JSON.stringify(group(one, 'gitignore')?.files) === JSON.stringify(['aa-ignored.ts', 'zz-ignored.ts']))
    check('no empty groups', one.excluded.every((g) => g.dirs.length + g.files.length > 0))
    check('totals add up',
      one.totals.inventoried === one.files.length &&
      one.totals.excluded_files === one.excluded.reduce((n, g) => n + g.files.length, 0) &&
      one.totals.excluded_dirs === one.excluded.reduce((n, g) => n + g.dirs.length, 0))
    check('target_dir is absolute and resolved', one.target_dir === fs.realpathSync(root))
    check('schema_version 1', one.schema_version === 1)
  }

  // -------------------------------------------------------------------------
  console.log('\n-- options --')
  {
    const d = selectionOptionsFromEnv({})
    check('env defaults', d.max_file_bytes === DEFAULT_MAX_FILE_BYTES && d.include_tests === false)
    check('default cap is 1,000,000', DEFAULT_MAX_FILE_BYTES === 1_000_000)
    check('SCANNER_MAX_FILE_BYTES parsed', selectionOptionsFromEnv({ SCANNER_MAX_FILE_BYTES: '5000' }).max_file_bytes === 5000)
    check('SCANNER_MAX_FILE_BYTES empty means default',
      selectionOptionsFromEnv({ SCANNER_MAX_FILE_BYTES: '' }).max_file_bytes === DEFAULT_MAX_FILE_BYTES)
    check('SCANNER_INCLUDE_TESTS=1', selectionOptionsFromEnv({ SCANNER_INCLUDE_TESTS: '1' }).include_tests === true)
    check('SCANNER_INCLUDE_TESTS=0', selectionOptionsFromEnv({ SCANNER_INCLUDE_TESTS: '0' }).include_tests === false)
    const throws = (f: () => unknown) => { try { f(); return false } catch { return true } }
    for (const bad of ['0', '-1', '1.5', 'abc', '1e6', ' 100', '100 ', '0x10', '99999999999999999999']) {
      check(`SCANNER_MAX_FILE_BYTES='${bad}' rejected`, throws(() => selectionOptionsFromEnv({ SCANNER_MAX_FILE_BYTES: bad })))
    }
    for (const bad of ['true', 'yes', '2', ' 1']) {
      check(`SCANNER_INCLUDE_TESTS='${bad}' rejected`, throws(() => selectionOptionsFromEnv({ SCANNER_INCLUDE_TESTS: bad })))
    }
    const root = fixture('opts', { 'a.ts': CODE })
    check('selectFiles rejects a zero cap', throws(() => selectFiles(root, { max_file_bytes: 0 })))
    check('selectFiles rejects a fractional cap', throws(() => selectFiles(root, { max_file_bytes: 1.5 })))
    check('selectFiles rejects a file as target', throws(() => selectFiles(path.join(root, 'a.ts'))))
    check('selectFiles rejects a missing target', throws(() => selectFiles(path.join(root, 'missing'))))
    const p = selectFiles(root, { include_tests: true })
    check('partial options keep the other default', p.options.max_file_bytes === DEFAULT_MAX_FILE_BYTES)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
