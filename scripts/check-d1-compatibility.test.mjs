import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  analyzeD1Source,
  findD1CompatibilityViolations,
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
})

test('current repository has no violations', () =>
  assert.deepEqual(findD1CompatibilityViolations(), []))
