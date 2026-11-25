import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { metricQueries, parseArgs } from './link-open-metrics.mjs'

const schema = readFileSync(
  new URL('../apps/web/db/schema.sql', import.meta.url),
  'utf8',
)
const since = '2026-10-01T00:00:00.000Z'

// The reported rows come from running the queries on the shipped schema, so a
// renamed column or a changed filter shows up here as different counts.
function seeded() {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  const insert = (table, row) =>
    db
      .prepare(
        `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(
          row,
        )
          .map(() => '?')
          .join(', ')})`,
      )
      .run(...Object.values(row))
  const start = '2026-09-01T00:00:00.000Z'
  for (const [id, plan] of [
    ['w-free', 'free'],
    ['w-plus', 'plus'],
  ]) {
    insert('workspaces', { id, name: id, plan, created_at: start })
    insert('users', {
      id: `user-${id}`,
      email: `owner@${id}.example`,
      created_at: start,
      updated_at: start,
      workspace_id: id,
    })
    insert('artifact_containers', {
      id: `container-${id}`,
      workspace_id: id,
      kind: 'inbox',
      owner_user_id: `user-${id}`,
      name: id,
      created_at: start,
      updated_at: start,
    })
  }
  for (const [id, workspace, visibility] of [
    ['art-free-1', 'w-free', 'link'],
    ['art-free-2', 'w-free', 'link'],
    ['art-plus-1', 'w-plus', 'link'],
    ['art-plus-2', 'w-plus', 'private'],
  ])
    insert('shareables', {
      id,
      workspace_id: workspace,
      owner_user_id: `user-${workspace}`,
      name: id,
      artifact_kind: 'markdown_page',
      visibility,
      container_id: `container-${workspace}`,
      created_at: start,
      updated_at: start,
    })
  const publish = (id, workspace, shareable, to, createdAt) =>
    insert('events', {
      id,
      workspace_id: workspace,
      type: 'visibility_changed',
      shareable_id: shareable,
      actor_user_id: `user-${workspace}`,
      subject_id: id,
      payload: JSON.stringify({ to }),
      created_at: createdAt,
    })
  publish('ev-1', 'w-free', 'art-free-1', 'link', '2026-10-05T00:00:00.000Z')
  publish('ev-2', 'w-free', 'art-free-1', 'link', '2026-10-06T00:00:00.000Z')
  publish('ev-3', 'w-plus', 'art-plus-1', 'link', '2026-10-07T00:00:00.000Z')
  publish(
    'ev-4',
    'w-free',
    'art-free-2',
    'workspace',
    '2026-10-08T00:00:00.000Z',
  )
  publish('ev-5', 'w-free', 'art-free-2', 'link', '2026-09-01T00:00:00.000Z')
  const view = (id, workspace, shareable, actor, createdAt) =>
    insert('events', {
      id,
      workspace_id: workspace,
      type: 'artifact_viewed',
      shareable_id: shareable,
      actor_user_id: actor,
      created_at: createdAt,
    })
  view('ev-6', 'w-free', 'art-free-1', null, '2026-10-10T00:00:00.000Z')
  view('ev-7', 'w-free', 'art-free-1', null, '2026-10-11T00:00:00.000Z')
  view('ev-8', 'w-plus', 'art-plus-1', null, '2026-10-12T00:00:00.000Z')
  view(
    'ev-9',
    'w-free',
    'art-free-1',
    'user-w-free',
    '2026-10-13T00:00:00.000Z',
  )
  view('ev-10', 'w-plus', 'art-plus-2', null, '2026-10-14T00:00:00.000Z')
  view('ev-11', 'w-free', 'art-free-1', null, '2026-09-15T00:00:00.000Z')
  return db
}

const rows = (db, sql) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }))

test('parses the reporting window and target', () => {
  assert.deepEqual(parseArgs([]), { days: 7, remote: false })
  assert.deepEqual(parseArgs(['--', '--days', '30', '--remote']), {
    days: 30,
    remote: true,
  })
  assert.throws(() => parseArgs(['--days', '0']))
  assert.throws(() => parseArgs(['--verbose']))
})

test('counts link publishes in the window by plan, and nothing else', () => {
  const db = seeded()
  assert.deepEqual(rows(db, metricQueries(since).linkPublishes), [
    { plan: 'free', publishes: 2, workspaces: 1, artifacts: 1 },
    { plan: 'plus', publishes: 1, workspaces: 1, artifacts: 1 },
  ])
})

test('counts only anonymous views of link-visible artifacts by plan', () => {
  const db = seeded()
  assert.deepEqual(rows(db, metricQueries(since).anonymousViews), [
    { plan: 'free', anonymous_views: 2, artifacts: 1 },
    { plan: 'plus', anonymous_views: 1, artifacts: 1 },
  ])
})

test('counts the artifacts that are link-visible now by plan', () => {
  const db = seeded()
  assert.deepEqual(rows(db, metricQueries(since).linkVisibleNow), [
    { plan: 'free', link_visible_artifacts: 2 },
    { plan: 'plus', link_visible_artifacts: 1 },
  ])
})

test('a quoted window is data, not more SQL', () => {
  const db = seeded()
  const queries = metricQueries(`${since}'; DROP TABLE workspaces;--`)
  assert.deepEqual(rows(db, queries.linkPublishes), [
    { plan: 'free', publishes: 2, workspaces: 1, artifacts: 1 },
    { plan: 'plus', publishes: 1, workspaces: 1, artifacts: 1 },
  ])
  assert.deepEqual(rows(db, queries.anonymousViews), [
    { plan: 'free', anonymous_views: 2, artifacts: 1 },
    { plan: 'plus', anonymous_views: 1, artifacts: 1 },
  ])
  assert.equal(rows(db, 'SELECT count(*) AS n FROM workspaces')[0].n, 2)
})
