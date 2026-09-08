import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

describe('free link expiry migration', () => {
  test('preserves indistinguishable existing expiry policies', () => {
    const migrations = loadMigrations()
    const upTo = migrations.filter(
      (item) => item.name < '0105_free_link_expiry_unlimited.sql',
    )
    expect(upTo.length).toBeGreaterThan(0)
    const sqlite = new DatabaseSync(':memory:')
    applyMigrations(sqlite, upTo)
    const insert = sqlite.prepare(
      `INSERT INTO workspaces (id, hd, name, created_at, plan, link_sharing_enabled, external_posting_enabled, link_expiry_default_days, link_expiry_max_days)
       VALUES (?, NULL, ?, '2026-09-01T00:00:00.000Z', ?, 1, 0, 30, ?)`,
    )
    insert.run('free-ambiguous-90', 'Free ambiguous 90', 'free', 90)
    insert.run('free-chosen-60', 'Free chosen 60', 'free', 60)
    insert.run('free-unlimited', 'Free unlimited', 'free', null)
    insert.run('plus-ambiguous-90', 'Plus ambiguous 90', 'plus', 90)
    insert.run('team-ambiguous-90', 'Team ambiguous 90', 'team', 90)
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, stripe_customer_id,
        link_sharing_enabled, external_posting_enabled,
        link_expiry_default_days, link_expiry_max_days
      ) VALUES
        ('personal-paid-90', NULL, 'Personal paid 90',
         '2026-09-01T00:00:00.000Z', 'free', 'cus_paid', 1, 0, 30, 90),
        ('domain-free-90', 'example.com', 'Domain Free 90',
         '2026-09-01T00:00:00.000Z', 'free', NULL, 1, 0, 30, 90),
        ('free-no-default', NULL, 'Free no default',
         '2026-09-01T00:00:00.000Z', 'free', NULL, 1, 0, NULL, NULL)
    `)
    const migration = migrations.find(
      (item) => item.name === '0105_free_link_expiry_unlimited.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)
    const rows = sqlite
      .prepare(
        `SELECT id, link_expiry_default_days, link_expiry_max_days
         FROM workspaces ORDER BY id`,
      )
      .all() as Array<{
      id: string
      link_expiry_default_days: number | null
      link_expiry_max_days: number | null
    }>
    expect(rows).toEqual([
      {
        id: 'domain-free-90',
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'free-ambiguous-90',
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'free-chosen-60',
        link_expiry_default_days: 30,
        link_expiry_max_days: 60,
      },
      {
        id: 'free-no-default',
        link_expiry_default_days: null,
        link_expiry_max_days: null,
      },
      {
        id: 'free-unlimited',
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      },
      {
        id: 'personal-paid-90',
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'plus-ambiguous-90',
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'team-ambiguous-90',
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
    ])
  })
})
