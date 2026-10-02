import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { anchorSeedSql } from '../test/comment-anchor-seed'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
  await database.batch(
    anchorSeedSql
      .split(';')
      .filter((sql) => sql.trim())
      .map((sql) => database.prepare(sql)),
  )
})
afterAll(async () => {
  await server.close()
})
function publication(id: string) {
  return [
    database
      .prepare(
        "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at,published_at) VALUES (?,'s1','html_page','published','/index.html',?,12,'hash','u1','2026-09-01','2026-09-01')",
      )
      .bind(id, id),
    database
      .prepare("UPDATE shareables SET current_version_id = ? WHERE id = 's1'")
      .bind(id),
  ]
}
test('concurrent publication records the actual previous current; failed batches and restoration preserve history', async () => {
  await database.batch(publication('v1'))
  await Promise.all([
    database.batch(publication('v2')),
    database.batch(publication('v3')),
  ])
  const current = await database
    .prepare("SELECT current_version_id FROM shareables WHERE id = 's1'")
    .first<string>('current_version_id')
  const previous = current === 'v2' ? 'v3' : 'v2'
  expect(
    await database
      .prepare('SELECT previous_current_version_id FROM versions WHERE id = ?')
      .bind(current)
      .first('previous_current_version_id'),
  ).toBe(previous)
  expect(
    await database
      .prepare('SELECT previous_current_version_id FROM versions WHERE id = ?')
      .bind(previous)
      .first('previous_current_version_id'),
  ).toBe('v1')
  await expect(
    database.batch([
      ...publication('v4'),
      database.prepare(
        "INSERT INTO workspaces (id,name,created_at) VALUES ('ws1','duplicate','2026-09-01')",
      ),
    ]),
  ).rejects.toThrow()
  expect(
    await database.prepare("SELECT id FROM versions WHERE id = 'v4'").first(),
  ).toBeNull()
  await database
    .prepare("UPDATE shareables SET current_version_id = 'v1' WHERE id = 's1'")
    .run()
  await database.batch(publication('v5'))
  expect(
    await database
      .prepare(
        "SELECT previous_current_version_id FROM versions WHERE id = 'v5'",
      )
      .first('previous_current_version_id'),
  ).toBe('v1')
  expect(
    await database
      .prepare(
        "SELECT previous_current_version_id FROM versions WHERE id = 'v1'",
      )
      .first('previous_current_version_id'),
  ).toBeNull()
})
