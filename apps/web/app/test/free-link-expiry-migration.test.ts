import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

describe('free link expiry migration', () => {
  test('lifts the old 90-day starting maximum on Free workspaces only', () => {
    const upTo = loadMigrations().filter(
      (item) => item.name < '0105_free_link_expiry_unlimited.sql',
    )
    expect(upTo.length).toBeGreaterThan(0)
    const sqlite = new DatabaseSync(':memory:')
    applyMigrations(sqlite, upTo)
    const insert = sqlite.prepare(
      `INSERT INTO workspaces (id, hd, name, created_at, plan, link_sharing_enabled, external_posting_enabled, link_expiry_default_days, link_expiry_max_days)
       VALUES (?, NULL, ?, '2026-09-01T00:00:00.000Z', ?, 1, 0, 30, ?)`,
    )
    insert.run('free-default', 'Free default', 'free', 90)
    insert.run('free-chosen', 'Free chosen', 'free', 60)
    insert.run('plus-default', 'Plus default', 'plus', 90)
    const migration = loadMigrations().find(
      (item) => item.name === '0105_free_link_expiry_unlimited.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)
    const rows = sqlite
      .prepare('SELECT id, link_expiry_max_days FROM workspaces ORDER BY id')
      .all() as Array<{ id: string; link_expiry_max_days: number | null }>
    expect(rows).toEqual([
      { id: 'free-chosen', link_expiry_max_days: 60 },
      { id: 'free-default', link_expiry_max_days: null },
      { id: 'plus-default', link_expiry_max_days: 90 },
    ])
  })
})
