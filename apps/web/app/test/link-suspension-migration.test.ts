import { describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb, loadMigrations } from './sqlite-fixture'

describe('link suspension migration', () => {
  test('adds the suspension columns and the operator event types', () => {
    expect(
      loadMigrations().find((item) => item.name === '0103_link_suspension.sql'),
    ).toBeDefined()
    const { sqlite } = createMigratedInMemoryDb()
    const columns = (
      sqlite.prepare('PRAGMA table_info(shareables)').all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining(['link_suspended_at', 'link_suspended_reason']),
    )
    const events = (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'events'")
        .get() as { sql: string }
    ).sql
    expect(events).toContain("'link_suspended'")
    expect(events).toContain("'link_resumed'")
    expect(events).toContain("'link_appealed'")
    // Operator events carry no actor; an appeal must name the owner.
    expect(events).toMatch(
      /type IN \('artifact_viewed', 'link_reported', 'link_suspended', 'link_resumed'\) OR actor_user_id IS NOT NULL/u,
    )
    expect(events).toMatch(
      /type NOT IN \('link_reported', 'link_suspended', 'link_resumed'\) OR actor_user_id IS NULL/u,
    )
    const indexes = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((index) => index.name)
    expect(indexes).toEqual([
      'events_shareable_created',
      'events_type_created',
      'events_type_subject',
      'events_type_workspace_shareable',
      'events_workspace_created',
    ])
  })
})
