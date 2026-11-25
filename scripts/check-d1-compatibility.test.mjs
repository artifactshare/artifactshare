import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import {
  analyzeD1Source,
  findD1CompatibilityViolations,
  productionSourceFiles,
} from './check-d1-compatibility.mjs'

function rules(source) {
  return analyzeD1Source(source).map((violation) => violation.rule)
}

test('allows ordinary SQL and a five-term top-level compound SELECT', () => {
  assert.deepEqual(rules('const query = sql`SELECT 1`'), [])
  assert.deepEqual(
    rules(
      'const query = sql`SELECT 1 UNION ALL SELECT 2 UNION SELECT 3 INTERSECT SELECT 4 EXCEPT SELECT 5`',
    ),
    [],
  )
})

test('allows bounded compounds inside EXISTS, including builder context', () => {
  assert.deepEqual(
    rules('const query = sql`SELECT 1 WHERE EXISTS (SELECT 1 UNION SELECT 2)`'),
    [],
  )
  assert.deepEqual(
    rules(`
      import { sql } from 'kysely'
      eb.exists(sql\`(SELECT 1 UNION SELECT 2)\`)
    `),
    [],
  )
})

test('rejects six or more terms, including direct builder composition', () => {
  assert.deepEqual(
    rules(
      'const query = sql`SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6`',
    ),
    ['compound-term-limit'],
  )
  assert.deepEqual(
    rules(`
      import { sql } from 'kysely'
      db.selectFrom('a').unionAll(
        sql.raw('SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6')
      )
    `),
    ['compound-term-limit'],
  )
})

test('preserves bounded direct nested SQL fragment branches', () => {
  assert.deepEqual(
    rules(`
      const query = sql\`SELECT EXISTS (\${
        flag ? sql\`SELECT 1 UNION SELECT 2\` : sql\`SELECT 3\`
      })\`
    `),
    [],
  )
})

test('keeps independent scopes separate and ignores quoted SQL words', () => {
  assert.deepEqual(
    rules(`
      const query = sql\`SELECT * FROM
        (SELECT 1 UNION SELECT 2) AS first,
        (SELECT 3 UNION SELECT 4) AS second\`
    `),
    [],
  )
  assert.deepEqual(
    rules(`
      const query = { compile: () => ({
        sql: \`SELECT 'UNION' /* UNION */ UNION SELECT "UNION"\`,
        parameters: [],
      }) }
    `),
    [],
  )
})

test('checks directly written custom compile and prepare SQL', () => {
  assert.deepEqual(
    rules(`
      const query = { compile: () => ({
        sql: \`SELECT \${value} UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6\`,
        parameters: [],
      }) }
    `),
    ['compound-term-limit'],
  )
  assert.deepEqual(
    rules(
      "env.DB.prepare('SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6')",
    ),
    ['compound-term-limit'],
  )
  assert.deepEqual(rules('env.DB.prepare(queryText)'), ['dynamic-raw-sql'])
  assert.deepEqual(rules('database.prepare(compiled.sql)'), [])
})

test('resolves SQL held in a same-file const', () => {
  assert.deepEqual(
    rules(`
      const DELETE_SESSION = 'DELETE FROM sessions WHERE token = ?'
      env.DB.prepare(DELETE_SESSION)
    `),
    [],
  )
  assert.deepEqual(
    rules(`
      const TERMS = 'SELECT 1 UNION SELECT 2 UNION SELECT 3'
      const QUERY = \`\${TERMS} UNION SELECT 4 UNION SELECT 5 UNION SELECT 6\`
      env.DB.prepare(QUERY)
    `),
    ['compound-term-limit'],
  )
  assert.deepEqual(
    rules(`
      import { sql } from 'kysely'
      const QUERY = 'SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6'
      sql.raw(QUERY)
    `),
    ['compound-term-limit'],
  )
  assert.deepEqual(
    rules(`
      let query = 'DELETE FROM sessions WHERE token = ?'
      env.DB.prepare(query)
    `),
    ['dynamic-raw-sql'],
  )
  // Two scopes reusing one name are judged apart: the analyzable one resolves
  // and the one built at runtime is still refused.
  assert.deepEqual(
    rules(`
      function first() {
        const QUERY = 'DELETE FROM sessions WHERE token = ?'
        env.DB.prepare(QUERY)
      }
      function second() {
        const QUERY = buildQuery()
        env.DB.prepare(QUERY)
      }
    `),
    ['dynamic-raw-sql'],
  )
  assert.deepEqual(
    rules(`
      export const DELETE_SESSION = 'DELETE FROM sessions WHERE token = ?'
      env.DB.prepare(DELETE_SESSION)
    `),
    [],
  )
})

// A constant resolves wherever it is genuinely in scope, not only at module
// level, because lifting a query into a local name is the same query.
test('resolves a const in any scope that holds the use site', () => {
  assert.deepEqual(
    rules(`
      export async function revoke(env, token) {
        const deleteSession = 'DELETE FROM sessions WHERE token = ?'
        await env.DB.prepare(deleteSession).bind(token).run()
      }
    `),
    [],
    'a function-local const resolves',
  )
  assert.deepEqual(
    rules(`
      function run() {
        if (ready) {
          const QUERY = 'DELETE FROM sessions WHERE token = ?'
          return env.DB.prepare(QUERY)
        }
      }
    `),
    [],
    'a const declared in an inner block resolves inside that block',
  )
  assert.deepEqual(
    rules(`
      export async function probe(env) {
        const QUERY = 'SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6'
        return env.DB.prepare(QUERY).all()
      }
    `),
    ['compound-term-limit'],
    'a local const still reports the limit it crosses',
  )
  assert.deepEqual(
    rules(`
      const BASE = 'SELECT 1 UNION SELECT 2 UNION SELECT 3'
      function run() {
        const QUERY = \`\${BASE} UNION SELECT 4 UNION SELECT 5 UNION SELECT 6\`
        return env.DB.prepare(QUERY)
      }
    `),
    ['compound-term-limit'],
    'a local const composed from a module const resolves across the scopes',
  )
  assert.deepEqual(
    rules(`
      const QUERY = 'SELECT 1'
      function run() {
        const QUERY = 'SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6'
        return env.DB.prepare(QUERY)
      }
    `),
    ['compound-term-limit'],
    'the nearest binding wins, so the inner const is what gets judged',
  )
})

// Resolution must follow the binding, not the name: a name rebound closer to
// the use site says nothing about the SQL that runs there, so unless that
// nearer binding is itself an analyzable const the use site stays unresolved.
test('does not resolve a const that the use site shadows', () => {
  const shadowed = (declaration) =>
    rules(`
      const QUERY = 'DELETE FROM sessions WHERE token = ?'
      ${declaration}
    `)
  assert.deepEqual(
    shadowed('export function run(db, QUERY) { return db.prepare(QUERY) }'),
    ['dynamic-raw-sql'],
    'a parameter of the same name shadows the constant',
  )
  assert.deepEqual(
    shadowed('export const run = (QUERY) => env.DB.prepare(QUERY)'),
    ['dynamic-raw-sql'],
    'an arrow parameter shadows the constant',
  )
  assert.deepEqual(
    shadowed('export function run(db, { QUERY }) { return db.prepare(QUERY) }'),
    ['dynamic-raw-sql'],
    'a destructured parameter shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { const QUERY = build(); return env.DB.prepare(QUERY) }',
    ),
    ['dynamic-raw-sql'],
    'an inner-block const shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { let QUERY = build(); return env.DB.prepare(QUERY) }',
    ),
    ['dynamic-raw-sql'],
    'an inner let shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { if (x) { var QUERY = build() } return env.DB.prepare(QUERY) }',
    ),
    ['dynamic-raw-sql'],
    'a var hoists out of its block and shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { try { go() } catch (QUERY) { return env.DB.prepare(QUERY) } }',
    ),
    ['dynamic-raw-sql'],
    'a catch clause parameter shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { for (const QUERY of list) env.DB.prepare(QUERY) }',
    ),
    ['dynamic-raw-sql'],
    'a for-of binding shadows the constant',
  )
  assert.deepEqual(
    shadowed(
      'function run() { function QUERY() {} return env.DB.prepare(QUERY) }',
    ),
    ['dynamic-raw-sql'],
    'an inner function declaration shadows the constant',
  )
  assert.deepEqual(
    rules(`
      const QUERY = 'DELETE FROM sessions WHERE token = ?'
      function build() { const QUERY = compose() }
      function run() { return env.DB.prepare(QUERY) }
    `),
    [],
    'a sibling scope rebinding the name leaves this use site resolvable',
  )
  assert.deepEqual(
    rules(`
      const QUERY = 'DELETE FROM sessions WHERE token = ?'
      function QUERY() {}
      env.DB.prepare(QUERY)
    `),
    ['dynamic-raw-sql'],
    'a top-level declaration taking the name leaves the constant unresolved',
  )
})

test('checks sql.raw and namespace imports', () => {
  assert.deepEqual(
    rules(`
      import { sql } from 'kysely'
      sql.raw('SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6')
    `),
    ['compound-term-limit'],
  )
  assert.deepEqual(
    rules(`
      import { sql } from 'kysely'
      sql.raw(queryText)
    `),
    ['dynamic-raw-sql'],
  )
  assert.deepEqual(
    rules(`
      import * as kysely from 'kysely'
      kysely.sql.raw('SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6')
    `),
    ['compound-term-limit'],
  )
})

test('rejects directly visible compound-generating joins', () => {
  assert.deepEqual(rules("parts.join(' UNION ALL ')"), [
    'dynamic-compound-select',
  ])
  assert.deepEqual(rules('sql.join(queries, sql` UNION ALL `)'), [
    'dynamic-compound-select',
  ])
  assert.deepEqual(rules('sql.join(values)'), [])
  assert.deepEqual(rules('sql.join(values, separator)'), [
    'dynamic-compound-select',
  ])
})

test('requires the compatibility plugin on Kysely constructors', () => {
  assert.deepEqual(
    rules(`
      import { Kysely as Database } from 'kysely'
      new Database({ dialect })
    `),
    ['missing-kysely-d1-guard'],
  )
  assert.deepEqual(
    rules(`
      import { Kysely } from 'kysely'
      new Kysely({ dialect, plugins: [d1CompatibilityPlugin] })
    `),
    [],
  )
  assert.deepEqual(
    rules(`
      import * as kysely from 'kysely'
      new kysely.Kysely({ dialect })
    `),
    ['missing-kysely-d1-guard'],
  )
})

test('scans production sources and excludes tests', () => {
  const scanRoot = mkdtempSync(join(tmpdir(), 'd1-compatibility-'))
  try {
    mkdirSync(join(scanRoot, 'apps/web/app'), { recursive: true })
    mkdirSync(join(scanRoot, 'apps/web/workers'), { recursive: true })
    writeFileSync(
      join(scanRoot, 'apps/web/app/example.ts'),
      'const query = sql`SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6`',
    )
    writeFileSync(
      join(scanRoot, 'apps/web/app/example.test.ts'),
      'const query = sql`SELECT 1 UNION SELECT 2 UNION SELECT 3`',
    )
    assert.deepEqual(
      findD1CompatibilityViolations(scanRoot).map(({ file, rule }) => ({
        file,
        rule,
      })),
      [{ file: 'apps/web/app/example.ts', rule: 'compound-term-limit' }],
    )
  } finally {
    rmSync(scanRoot, { recursive: true, force: true })
  }
})

test('prunes only the ephemeral lint fixture namespaces before scanning sources', () => {
  const scanRoot = mkdtempSync(join(tmpdir(), 'd1-compatibility-'))
  const fixtureDirectories = [
    'apps/web/app/analytics-lint-fixture-demo',
    'apps/web/app/module-boundary-lint-fixture-demo',
    'apps/web/app/modules/module-boundary-lint-fixture-demo',
  ]
  const productionFiles = [
    'apps/web/app/example.ts',
    'apps/web/app/modules/demo/internal.ts',
    'apps/web/workers/example.ts',
    'apps/web/app/example-fixture-demo/example.ts',
    'apps/web/app/analytics-lint-fixture-/example.ts',
    'apps/web/app/module-boundary-lint-fixture-/example.ts',
    'apps/web/app/modules/module-boundary-lint-fixture-/example.ts',
    'apps/web/app/modules/analytics-lint-fixture-demo/example.ts',
    'apps/web/app/demo/analytics-lint-fixture-demo/example.ts',
    'apps/web/app/demo/module-boundary-lint-fixture-demo/example.ts',
    'apps/web/workers/analytics-lint-fixture-demo/example.ts',
    'apps/web/workers/module-boundary-lint-fixture-demo/example.ts',
  ].sort()
  const violatingSource =
    'export const query = sql`SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6`'
  try {
    for (const file of [
      ...productionFiles,
      ...fixtureDirectories.map(
        (directory) => `${directory}/case-0/example.ts`,
      ),
      `${fixtureDirectories[2]}/index.ts`,
      `${fixtureDirectories[2]}/internal.ts`,
      `${fixtureDirectories[2]}/same-module.ts`,
    ]) {
      const path = join(scanRoot, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        file.endsWith('/same-module.ts')
          ? `import { query as internalQuery } from './internal'\nvoid internalQuery\n${violatingSource}`
          : violatingSource,
      )
    }
    const assertScan = (root) => {
      assert.deepEqual(
        productionSourceFiles(root).map((file) => relative(root, file)),
        productionFiles,
      )
      assert.deepEqual(
        findD1CompatibilityViolations(root).map(({ file, rule }) => ({
          file,
          rule,
        })),
        productionFiles.map((file) => ({ file, rule: 'compound-term-limit' })),
      )
    }
    assertScan(scanRoot)
    assertScan(relative(process.cwd(), scanRoot))
    for (const directory of fixtureDirectories)
      rmSync(join(scanRoot, directory), { recursive: true, force: true })
    assertScan(scanRoot)
  } finally {
    rmSync(scanRoot, { recursive: true, force: true })
  }
})
