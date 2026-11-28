import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { parseSync } from 'oxc-parser'
import plugin, {
  isAccessLintScope,
  SHAREABLE_READ_EXEMPTIONS,
  shareableReads,
} from './access-lint-plugin.mjs'
import { productionSourceFiles } from './check-d1-compatibility.mjs'
import { lintFixturePrefix } from './lib/lint-fixture-paths.mjs'

const root = resolve(import.meta.dirname, '..')
const fixtures = join(import.meta.dirname, 'fixtures', 'access-lint')
const NEW_FILE = 'apps/web/app/services/new-list.server.ts'
const BASELINE_FILE = 'scripts/fixtures/access-lint/exemption-baseline.json'

const PRE_FIX = [
  {
    revision: 'fde8c8d^',
    path: 'apps/web/app/services/events.server.ts',
    fixture: 'fde8c8d.events.server.ts.txt',
    excerpts: [
      [781, 831],
      [90, 174],
    ],
    suffix: '  }\n}\n',
    reads: [
      [791, 'listProjectViewRanking'],
      [120, 'listFeedEvents'],
    ],
  },
  {
    revision: '7741af5^',
    path: 'apps/web/app/services/home.server.ts',
    fixture: '7741af5.home.server.ts.txt',
    excerpts: [[390, 432]],
    suffix: '',
    reads: [[396, 'recentArtifactsQuery']],
  },
  {
    revision: '880e418^',
    path: 'apps/web/app/services/project-membership.server.ts',
    fixture: '880e418.project-membership.server.ts.txt',
    excerpts: [
      [260, 307],
      [330, 388],
    ],
    suffix: '',
    reads: [
      [282, 'listProjectsForIndex'],
      [285, 'listProjectsForIndex'],
      [352, 'listJoinedProjectsForDropdown'],
      [355, 'listJoinedProjectsForDropdown'],
    ],
  },
]

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function violations(file, source) {
  const { program } = parseSync('source.ts', source)
  const names = new Map(
    shareableReads(program).map(({ node, functionName }) => [
      node,
      functionName,
    ]),
  )
  const reports = []
  plugin.rules['no-direct-shareable-read']
    .create({
      filename: join(root, file),
      sourceCode: { text: source },
      report: (report) => reports.push(report),
    })
    .Program?.(program)
  return reports.map(({ node, message }) => ({
    line: lineAt(source, node.start),
    key: `${file}#${names.get(node)}`,
    message,
  }))
}

function preFixSource({ fixture, suffix }) {
  return readFileSync(join(fixtures, fixture), 'utf8') + suffix
}

function originalLine(excerpts, line) {
  let offset = line
  for (const [from, to] of excerpts) {
    if (offset <= to - from + 1) return from + offset - 1
    offset -= to - from + 1
  }
  return null
}

const migrating = new Set(SHAREABLE_READ_EXEMPTIONS.migrating)

test('rejects the reads behind three access leaks, as they were before each fix', () => {
  for (const entry of PRE_FIX) {
    const reports = violations(NEW_FILE, preFixSource(entry))
    assert.deepEqual(
      reports.map(({ line, key }) => [originalLine(entry.excerpts, line), key]),
      entry.reads.map(([line, name]) => [line, `${NEW_FILE}#${name}`]),
      entry.revision,
    )
    for (const { message } of reports) {
      assert.match(message, /only shrinks/u)
      assert.doesNotMatch(message, /SHAREABLE_READ_EXEMPTIONS|#|\.mjs/u)
    }
  }
})

function exportsName(file, name) {
  const source = readFileSync(file, 'utf8')
  return new RegExp(
    `export (?:async )?function ${name}\\b|export \\{[^}]*\\b${name}\\b`,
    'u',
  ).test(source)
}

test('the message names functions that its paths export', () => {
  const [{ message }] = violations(
    NEW_FILE,
    `export function newList(db) {\n  return db.selectFrom('shareables')\n}\n`,
  )
  const quoted = [...message.matchAll(/`([^`]+)`/gu)].map(([, text]) => text)
  const files = [
    ...new Set(quoted.filter((text) => text.startsWith('~/'))),
  ].map((text) =>
    [
      `apps/web/app/${text.slice(2)}.ts`,
      `apps/web/app/${text.slice(2)}/index.ts`,
    ].find((file) => existsSync(join(root, file))),
  )
  assert.ok(files.length > 0 && files.every(Boolean), message)
  const names = quoted.filter((text) => !text.startsWith('~/'))
  assert.deepEqual(names, [
    'facts',
    'viewerAccessAllowed',
    'visibleShareableToViewer',
    'visibleSharedProjectShareableToViewer',
  ])
  for (const name of names)
    assert.ok(
      files.some((file) => exportsName(join(root, file), name)),
      `${name} is not exported from ${files.join(', ')}`,
    )
})

test('exempts those functions only at their own path and name, as migrating', () => {
  for (const entry of PRE_FIX) {
    for (const [, name] of entry.reads)
      assert.ok(migrating.has(`${entry.path}#${name}`), name)
    assert.deepEqual(violations(entry.path, preFixSource(entry)), [])
  }
  const home = PRE_FIX.find(({ revision }) => revision === '7741af5^')
  const renamed = preFixSource(home).replace(
    'function recentArtifactsQuery(',
    'function recentArtifactsForPalette(',
  )
  assert.deepEqual(
    violations(home.path, renamed).map(({ key }) => key),
    [`${home.path}#recentArtifactsForPalette`],
  )
})

test('flags Kysely and raw SQL reads of shareables', () => {
  for (const body of [
    `return db.selectFrom('shareables').selectAll()`,
    `return db.selectFrom('shareables as s').select('s.id')`,
    `return db.selectFrom('events').innerJoin('shareables', 'shareables.id', 'events.shareable_id')`,
    `return db.selectFrom('events').leftJoin('shareables as s', 's.id', 'events.shareable_id')`,
    `return db.selectFrom(['shareables', 'users']).selectAll()`,
    `const table = 'shareables'\n  return db.selectFrom(table).selectAll()`,
    `return eb.exists(eb.selectFrom('shareables').select('id'))`,
    'return sql`SELECT count(*) FROM shareables WHERE container_id = ${id}`',
    'return sql`SELECT 1 FROM users u\n    JOIN shareables s ON s.owner_user_id = u.id`',
    `return sql.raw('select id from shareables')`,
    'return env.DB.prepare(`SELECT name FROM shareables WHERE id = ?`)',
  ]) {
    const source = `export function newList(db, eb, env, id) {\n  ${body}\n}\n`
    assert.deepEqual(
      violations(NEW_FILE, source).map(({ key }) => key),
      [`${NEW_FILE}#newList`],
      body,
    )
  }
  assert.equal(
    violations(
      NEW_FILE,
      "import { sql as raw } from 'kysely'\nconst read = () => raw`select 1 from shareables`\n",
    ).length,
    1,
  )
})

test('allows writes, other tables and column references', () => {
  for (const body of [
    `return db.updateTable('shareables').set({ name: 'x' })`,
    `return db.insertInto('shareables').values(row)`,
    `return db.deleteFrom('shareables').where('id', '=', id)`,
    `return db.selectFrom('shareable_grants').selectAll()`,
    `return db.selectFrom('events').where('events.shareable_id', '=', sql.ref('shareables.id'))`,
    'return sql`UPDATE shareables SET name = ${id}`',
    'return sql`SELECT 1 FROM shareable_viewer_recency`',
    'return fetch(`/api/shareables/${id}/save`)',
    `return 'copied from shareables'`,
  ]) {
    const source = `export function newList(db, id, row) {\n  ${body}\n}\n`
    assert.deepEqual(violations(NEW_FILE, source), [], body)
  }
})

test('scopes the rule to product code outside tests and modules/access', () => {
  for (const file of [
    'apps/web/app/services/events.server.ts',
    'apps/web/app/routes/_protected/projects.$id.tsx',
    'apps/web/app/modules/publish/operations.server.ts',
    'apps/web/workers/bundle-sandbox.ts',
  ])
    assert.equal(isAccessLintScope(file), true, file)
  for (const file of [
    'apps/web/app/modules/access/facts.ts',
    'apps/web/app/modules/access/index.ts',
    'apps/web/app/services/events.server.test.ts',
    'apps/web/app/routes/a.$id/+loader.server.test.ts',
    'apps/web/app/test/sqlite-fixture.ts',
    'apps/web/app/d1-tests/access.test.ts',
    'apps/web/scripts/build-viewers.mjs',
    'packages/cli/src/index.ts',
  ])
    assert.equal(isAccessLintScope(file), false, file)
  const read = `export function facts(db) {\n  return db.selectFrom('shareables').selectAll()\n}\n`
  assert.deepEqual(violations('apps/web/app/modules/access/facts.ts', read), [])
  assert.deepEqual(
    violations('apps/web/app/services/events.server.test.ts', read),
    [],
  )
})

test('the exemption table lists every current read and nothing stale', () => {
  const categories = Object.keys(SHAREABLE_READ_EXEMPTIONS)
  assert.deepEqual(categories, ['migrating', 'management', 'system', 'write'])
  const listed = Object.values(SHAREABLE_READ_EXEMPTIONS).flat()
  assert.equal(new Set(listed).size, listed.length, 'a key is listed twice')
  const found = new Set()
  for (const path of productionSourceFiles(root)) {
    const file = relative(root, path).replaceAll('\\', '/')
    if (!isAccessLintScope(file)) continue
    const { program } = parseSync(file, readFileSync(path, 'utf8'))
    for (const { functionName } of shareableReads(program))
      found.add(`${file}#${functionName}`)
  }
  assert.deepEqual(listed.toSorted(), [...found].sort())
})

test('the exemption table only shrinks from its frozen baseline', () => {
  const baseline = JSON.parse(readFileSync(join(root, BASELINE_FILE), 'utf8'))
  const entries = (table) =>
    Object.entries(table).flatMap(([category, keys]) =>
      keys.map((key) => `${category}: ${key}`),
    )
  const frozen = entries(baseline)
  const current = entries(SHAREABLE_READ_EXEMPTIONS)
  assert.deepEqual(
    current.filter((entry) => !frozen.includes(entry)),
    [],
    `SHAREABLE_READ_EXEMPTIONS only shrinks. A new read that decides what a viewer sees goes through ~/modules/access, so neither the table nor ${BASELINE_FILE} takes a new key or a key in a new category.`,
  )
  assert.deepEqual(
    frozen.filter((entry) => !current.includes(entry)),
    [],
    `These keys left SHAREABLE_READ_EXEMPTIONS. Delete them from ${BASELINE_FILE} too.`,
  )
})

const historyAvailable = PRE_FIX.every(
  ({ revision }) =>
    spawnSync('git', ['cat-file', '-e', revision], { cwd: root }).status === 0,
)

test(
  'the pre-fix fixtures are verbatim excerpts of their revisions',
  { skip: !historyAvailable && 'needs the fix commits in the clone' },
  () => {
    for (const entry of PRE_FIX) {
      const original = spawnSync(
        'git',
        ['show', `${entry.revision}:${entry.path}`],
        { cwd: root, encoding: 'utf8' },
      ).stdout.split('\n')
      const excerpt = entry.excerpts
        .map(([from, to]) => original.slice(from - 1, to).join('\n'))
        .join('\n')
      assert.equal(
        readFileSync(join(fixtures, entry.fixture), 'utf8'),
        `${excerpt}\n`,
        entry.revision,
      )
    }
  },
)

test('the configured lint reports the pre-fix reads in app code', () => {
  const directory = mkdtempSync(join(root, lintFixturePrefix('access')))
  try {
    const files = PRE_FIX.map((entry) => {
      const file = join(directory, entry.fixture.replace(/\.txt$/u, ''))
      writeFileSync(file, preFixSource(entry))
      return relative(root, file)
    })
    const result = spawnSync(
      'pnpm',
      ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', '-f', 'json', directory],
      { cwd: root, encoding: 'utf8' },
    )
    const output = result.stdout + result.stderr
    assert.ok([0, 1].includes(result.status), output)
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    const reads = report.diagnostics.filter(({ code }) =>
      /access\(no-direct-shareable-read\)|access\/no-direct-shareable-read/u.test(
        code,
      ),
    )
    assert.deepEqual(
      files.map(
        (file) => reads.filter(({ filename }) => filename === file).length,
      ),
      PRE_FIX.map((entry) => entry.reads.length),
      output,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
