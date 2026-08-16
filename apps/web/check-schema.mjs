import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  partitionMigrationNames,
  rebuildBaselineUrl,
} from './db/rebuild-baseline.mjs'

// db/schema.sql is a hand-maintained reference of the current schema; it is NOT
// applied at runtime (migrations are). Nothing else enforces that the two agree,
// so this guard rebuilds the schema from db/migrations/ and from db/schema.sql in
// memory and fails if they diverge in tables, columns, indexes, or triggers.
//
// Columns are compared as a set (order-insensitive): a column added by ALTER TABLE
// lands at the end of the migrated table but inline in schema.sql, and that
// cosmetic ordering difference must not trip the check.

const migrationsDir = fileURLToPath(new URL('./db/migrations', import.meta.url))
const schemaPath = fileURLToPath(new URL('./db/schema.sql', import.meta.url))
function applySql(statements) {
  const db = new DatabaseSync(':memory:')
  for (const sql of statements) db.exec(sql)
  return db
}

function fromMigrations() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const { afterBaseline } = partitionMigrationNames(files)
  return applySql([
    readFileSync(fileURLToPath(rebuildBaselineUrl), 'utf8'),
    ...afterBaseline.map((f) => readFileSync(join(migrationsDir, f), 'utf8')),
  ])
}

function fromSchema() {
  return applySql([readFileSync(schemaPath, 'utf8')])
}

// Named tables, indexes, and triggers. Excludes sqlite_* internals and rows
// without DDL (autoindexes backing UNIQUE/PRIMARY KEY have no sql).
function namedObjects(db) {
  return new Set(
    db
      .prepare(
        "SELECT type || ' ' || name AS o FROM sqlite_master" +
          " WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.o),
  )
}

function tableNames(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'" +
        " AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
}

function tableColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map(
        (c) =>
          `${c.name} ${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`,
      ),
  )
}

function createTableSql(db, table) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row?.sql ?? null
}

const migrated = fromMigrations()
const declared = fromSchema()
const problems = []

const migObjs = namedObjects(migrated)
const schemaObjs = namedObjects(declared)
for (const o of migObjs) {
  if (!schemaObjs.has(o)) {
    problems.push(`missing from db/schema.sql: ${o} (produced by migrations)`)
  }
}
for (const o of schemaObjs) {
  if (!migObjs.has(o)) {
    problems.push(`stale in db/schema.sql: ${o} (not produced by migrations)`)
  }
}

const tables = [
  ...new Set([...tableNames(migrated), ...tableNames(declared)]),
].toSorted()
for (const t of tables) {
  // Skip tables whose very presence already differs; reported above.
  if (!migObjs.has(`table ${t}`) || !schemaObjs.has(`table ${t}`)) continue
  const migCols = tableColumns(migrated, t)
  const schemaCols = tableColumns(declared, t)
  for (const c of migCols) {
    if (!schemaCols.has(c))
      problems.push(`db/schema.sql ${t}: missing column [${c}]`)
  }
  for (const c of schemaCols) {
    if (!migCols.has(c))
      problems.push(`db/schema.sql ${t}: extra column [${c}]`)
  }
}

const migratedShareablesSql = createTableSql(migrated, 'shareables')
const declaredShareablesSql = createTableSql(declared, 'shareables')
if (migratedShareablesSql !== declaredShareablesSql) {
  problems.push(
    'db/schema.sql shareables: CREATE TABLE SQL differs from migrations',
  )
}

const migratedSlackChannelsSql = createTableSql(
  migrated,
  'container_slack_channels',
)
const declaredSlackChannelsSql = createTableSql(
  declared,
  'container_slack_channels',
)
if (migratedSlackChannelsSql !== declaredSlackChannelsSql) {
  problems.push(
    'db/schema.sql container_slack_channels: CREATE TABLE SQL differs from migrations',
  )
}
if (
  !declaredShareablesSql?.includes(
    "CHECK (visibility IN ('private', 'workspace', 'project', 'link'))",
  )
) {
  problems.push(
    'db/schema.sql shareables.visibility: missing CHECK for private | workspace | project | link',
  )
}

if (problems.length > 0) {
  console.error('db/schema.sql is out of sync with db/migrations/:')
  for (const p of problems) console.error(`- ${p}`)
  console.error(
    '\nUpdate db/schema.sql to match the current migrations' +
      ' (it is the hand-maintained schema reference).',
  )
  process.exit(1)
}

console.log('db/schema.sql matches db/migrations/.')
