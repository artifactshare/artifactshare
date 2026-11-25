import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('publisher migration preserves populated authorities, device requests and child links', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (entry) => entry.name === '0112_publisher_clients.sql',
    )
    expect(index).toBeGreaterThan(0)
    applyMigrations(sqlite, migrations.slice(0, index))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-01-01');
      INSERT INTO users (id, google_sub, email, workspace_id, created_at, updated_at) VALUES ('u1', 'sub-u1', 'owner@example.test', 'ws1', '2026-01-01', '2026-01-01');
      INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('s1', 'u1', 'session-test', '2099-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO cli_family_authorities (family_id, user_id, preset, status, created_at, updated_at) VALUES ('f1', 'u1', 'unrestricted', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO cli_session_authorities (session_id, family_id, kind, preset, created_at) VALUES ('s1', 'f1', 'family', 'unrestricted', '2026-01-01');
      INSERT INTO deviceCode (id, deviceCode, userCode, userId, expiresAt, status, preset, deviceName, approvalNonce, requestedProjectSelector) VALUES ('d1', 'device-test', 'ABCD1234', 'u1', '2099-01-01', 'pending', 'agent', 'Local client', 'nonce-test', 'Reports');
    `)
    const tables = [
      'cli_family_authorities',
      'cli_session_authorities',
      'deviceCode',
    ]
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all(),
    )
    const indexesAndTriggers = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    sqlite.exec(migrations[index]!.sql)
    tables.forEach((table, i) => {
      const column =
        table === 'deviceCode'
          ? 'selectedPublisherClientId'
          : 'publisher_client_id'
      expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(
        before[i]!.map((row) => ({ ...row, [column]: null })),
      )
    })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const afterNames = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    expect(afterNames).toEqual(expect.arrayContaining(indexesAndTriggers))
    sqlite.exec(
      `INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('pc1', 'u1', 'ws1', 'Reports', '2026-01-01')`,
    )
    expect(() =>
      sqlite.exec(
        `INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('pc2', 'u1', 'ws1', 'Reports', '2026-01-01')`,
      ),
    ).toThrow()
    expect(() =>
      sqlite.exec(
        `UPDATE cli_family_authorities SET preset = 'publisher' WHERE family_id = 'f1'`,
      ),
    ).toThrow()
    expect(() =>
      sqlite.exec(
        `UPDATE cli_family_authorities SET publisher_client_id = 'pc1' WHERE family_id = 'f1'`,
      ),
    ).toThrow()
    sqlite.exec(
      `UPDATE cli_family_authorities SET preset = 'publisher', workspace_id = 'ws1', publisher_client_id = 'pc1' WHERE family_id = 'f1'`,
    )
    expect(() =>
      sqlite.exec(`DELETE FROM publisher_clients WHERE id = 'pc1'`),
    ).toThrow()
  } finally {
    sqlite.close()
  }
})
