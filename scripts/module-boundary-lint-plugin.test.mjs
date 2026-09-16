import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { parseSync } from 'oxc-parser'
import test from 'node:test'
import plugin, {
  createModuleBoundaryRule,
  findModuleBoundary,
} from './module-boundary-lint-plugin.mjs'

const root = resolve(import.meta.dirname, '..')

function writeFixture(directory, relativePath, content) {
  const file = join(directory, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit)
    } else if (child && typeof child === 'object') walk(child, visit)
  }
}

function lintSource({ fixtureRoot, filename, source }) {
  const reports = []
  const visitor = createModuleBoundaryRule({ root: fixtureRoot }).create({
    filename,
    report(report) {
      reports.push(report)
    },
  })
  const ast = parseSync(filename, source, { lang: 'ts' }).program
  walk(ast, (node) => visitor[node.type]?.(node))
  return reports
}

test('resolves alias and relative imports and excludes public or same-module files', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'module-boundary-unit-'))
  try {
    writeFixture(
      fixtureRoot,
      'apps/web/app/modules/demo/index.ts',
      'export const value = 1\nexport type InternalType = string\n',
    )
    writeFixture(
      fixtureRoot,
      'apps/web/app/modules/demo/internal.ts',
      'export const value = 1\nexport type InternalType = string\n',
    )
    const outside = join(fixtureRoot, 'apps/web/app/routes/consumer.ts')
    const inside = join(fixtureRoot, 'apps/web/app/modules/demo/consumer.ts')
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: outside,
        specifier: '~/modules/demo/internal',
      })?.moduleName,
      'demo',
    )
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: outside,
        specifier: '../modules/demo/internal',
      })?.target,
      join(fixtureRoot, 'apps/web/app/modules/demo/internal.ts'),
    )
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: outside,
        specifier: '~/modules/demo',
      }),
      null,
    )
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: outside,
        specifier: '../modules/demo/index',
      }),
      null,
    )
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: inside,
        specifier: './internal',
      }),
      null,
    )
    assert.equal(
      findModuleBoundary({
        root: fixtureRoot,
        importer: outside,
        specifier: '~/lib/unrelated',
      }),
      null,
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('reports value, type, re-export, static dynamic, and TS import forms without excluding tests', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'module-boundary-forms-'))
  try {
    writeFixture(
      fixtureRoot,
      'apps/web/app/modules/demo/index.ts',
      'export const value = 1\nexport type InternalType = string\n',
    )
    writeFixture(
      fixtureRoot,
      'apps/web/app/modules/demo/internal.ts',
      'export const value = 1\nexport type InternalType = string\n',
    )
    const filename = join(fixtureRoot, 'apps/web/app/routes/consumer.test.ts')
    const reports = lintSource({
      fixtureRoot,
      filename,
      source: `
import { value } from '~/modules/demo/internal'
import type { InternalType } from '../modules/demo/internal'
export { value as exportedValue } from '~/modules/demo/internal'
export type { InternalType as ExportedType } from '../modules/demo/internal'
export * from '~/modules/demo/internal'
const dynamicValue = import('../modules/demo/internal')
type DynamicType = import('~/modules/demo/internal').InternalType
vi.mock('~/modules/demo/internal', () => ({}))
const ignoredDynamic = import(moduleName)
const ignoredUnrelated = import('external-package')
`,
    })
    assert.equal(reports.length, 8)
    for (const report of reports) {
      assert.match(report.message, /consumer\.test\.ts/)
      assert.match(
        report.message,
        /apps\/web\/app\/modules\/demo\/internal\.ts/,
      )
      assert.match(report.message, /~\/modules\/demo/)
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the configured error rejects violations while public-entry and same-module imports succeed', () => {
  const directory = mkdtempSync(
    join(root, 'apps/web/app/module-boundary-lint-fixture-'),
  )
  const moduleName = basename(directory)
  const moduleDirectory = join(root, 'apps/web/app/modules', moduleName)
  try {
    writeFixture(
      root,
      `apps/web/app/modules/${moduleName}/index.ts`,
      'export const publicValue = 1\n',
    )
    writeFixture(
      root,
      `apps/web/app/modules/${moduleName}/internal.ts`,
      'export const internalValue = 1\n',
    )
    const violating = join(directory, 'violating.test.ts')
    const publicEntry = join(directory, 'public-entry.ts')
    const sameModule = join(moduleDirectory, 'same-module.ts')
    writeFileSync(
      violating,
      `import { internalValue } from '~/modules/${moduleName}/internal'\nvoid internalValue\n`,
    )
    writeFileSync(
      publicEntry,
      `import { publicValue } from '~/modules/${moduleName}'\nvoid publicValue\n`,
    )
    writeFileSync(
      sameModule,
      `import { internalValue } from './internal'\nvoid internalValue\n`,
    )

    const lint = (file) =>
      spawnSync('pnpm', ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', file], {
        cwd: root,
        encoding: 'utf8',
      })
    const violationResult = lint(violating)
    const violationOutput = violationResult.stdout + violationResult.stderr
    assert.notEqual(violationResult.status, 0, violationOutput)
    assert.match(
      violationOutput,
      /module-boundary\(no-internal-imports\)|module-boundary\/no-internal-imports/,
    )
    assert.match(violationOutput, /violating\.test\.ts/)
    assert.match(violationOutput, new RegExp(`${moduleName}/internal[.]ts`))

    for (const file of [publicEntry, sameModule]) {
      const result = lint(file)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /module-boundary\(no-internal-imports\)|module-boundary\/no-internal-imports/,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(moduleDirectory, { recursive: true, force: true })
  }
})

assert.equal(plugin.meta.name, 'module-boundary')
