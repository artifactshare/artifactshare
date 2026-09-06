import { describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb, loadMigrations } from './sqlite-fixture'

describe('link abuse database migration', () => {
  test('creates signal, gate, and judgment tables with indexes and constraints', () => {
    const migration = loadMigrations().at(-1)
    expect(migration?.name).toBe('0101_link_abuse_signals.sql')
    const { sqlite } = createMigratedInMemoryDb()
    const objects = sqlite
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name IN (
           'anonymous_view_signals',
           'anonymous_view_signals_shareable_viewed',
           'anonymous_view_signals_viewed',
           'link_abuse_judgment_gates',
           'link_abuse_judgments',
           'link_abuse_judgments_shareable_created'
         ) ORDER BY name`,
      )
      .all() as Array<{ type: string; name: string; sql: string }>
    expect(objects.map(({ type, name }) => `${type}:${name}`)).toEqual([
      'table:anonymous_view_signals',
      'index:anonymous_view_signals_shareable_viewed',
      'index:anonymous_view_signals_viewed',
      'table:link_abuse_judgment_gates',
      'table:link_abuse_judgments',
      'index:link_abuse_judgments_shareable_created',
    ])
    expect(
      objects.find((item) => item.name === 'anonymous_view_signals')?.sql,
    ).toContain('ON DELETE CASCADE')
    expect(
      objects.find((item) => item.name === 'link_abuse_judgment_gates')?.sql,
    ).toMatch(
      /ON DELETE CASCADE[\s\S]*kind IN \('automatic', 'manual'\)[\s\S]*PRIMARY KEY \(shareable_id, kind\)/u,
    )
    expect(
      objects.find((item) => item.name === 'link_abuse_judgments')?.sql,
    ).toContain("risk IN ('low', 'medium', 'high')")
  })
})
