import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('0133 repairs eligible workspaces once and preserves membership history', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0133_repair_ownerless_workspaces.sql',
    )
    expect(index).toBeGreaterThan(0)
    applyMigrations(db, migrations.slice(0, index))
    const workspaces = [
      'admins',
      'contributors',
      'registered',
      'removed',
      'bots',
      'owned',
      'empty',
    ]
    for (const id of workspaces)
      db.prepare(
        "INSERT INTO workspaces (id,name,created_at) VALUES (?,?, '2025')",
      ).run(id, id)
    const candidates = [
      // workspace, user, registration, role, contribution, last modification
      ['admins', 'audited', '2020', 'admin', '2021', '2023'],
      ['admins', 'first-admin', '2021', 'admin', '2020', '2024'],
      ['admins', 'early-member', '2018', 'member', '2019', '2020'],
      ['contributors', 'writer', '2021', 'member', '2022', '2025'],
      ['contributors', 'second-writer', '2020', 'member', '2023', '2025'],
      ['contributors', 'reader', '2020', 'member', null, '2020'],
      // Insert the higher ID first so insertion order cannot resolve the tie.
      ['registered', 'b', '2020', 'member', null, '2020'],
      ['registered', 'a', '2020', null, null, null],
      ['registered', '0-younger', '2021', 'member', null, '2021'],
      ['owned', 'owner', '2021', 'owner', null, '2022'],
      ['owned', 'older', '2020', 'admin', null, '2020'],
      ['bots', 'bot', '2020', 'admin', null, '2020'],
      ['bots', 'departed', '2019', 'owner', null, '2025'],
      ['removed', 'former', '2020', 'owner', '2020', '2025'],
      ['removed', 'replacement', '2022', 'member', '2023', '2024'],
    ] as const
    for (const [
      workspace,
      id,
      created,
      role,
      contribution,
      updated,
    ] of candidates) {
      db.prepare(
        'INSERT INTO users (id,email,workspace_id,kind,created_at,updated_at,google_sub) VALUES (?,?,?,?,?,?,?)',
      ).run(
        id,
        id + '@example.com',
        workspace,
        id === 'bot' ? 'bot' : 'human',
        created,
        '2026',
        id,
      )
      if (role) {
        const removed = id === 'former' || id === 'departed'
        db.prepare(
          'INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at,first_contributed_at,removed_at,removed_by) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(
          workspace,
          id,
          role,
          removed ? 'removed' : 'active',
          created,
          updated,
          contribution,
          removed ? '2025' : null,
          removed ? id : null,
        )
      }
    }
    db.exec(`
      INSERT INTO audit_events (id,workspace_id,actor_user_id,subject_type,subject_id,action,created_at) VALUES
        ('1','admins',NULL,'user','audited','admin.grant','2020');
    `)
    const memberships = db.prepare(
      'SELECT * FROM workspace_members ORDER BY workspace_id,user_id',
    )
    const before = memberships.all()
    db.exec(migrations[index]!.sql)
    const after = memberships.all()
    expect(
      after
        .filter((row) => row.role === 'owner' && row.status === 'active')
        .map((row) => row.user_id),
    ).toEqual(['first-admin', 'writer', 'owner', 'a', 'replacement'])
    expect(after.find((row) => row.user_id === 'a')).toMatchObject({
      created_at: '2020',
      updated_at: '2020',
    })
    for (const row of before) {
      const repaired = after.find((member) => member.user_id === row.user_id)
      if (row.user_id === 'former')
        expect(repaired).toEqual({ ...row, role: 'member' })
      else if (repaired?.role === 'owner' && row.role !== 'owner')
        expect(repaired).toEqual({
          ...row,
          role: 'owner',
        })
      else expect(repaired).toEqual(row)
    }
    db.exec(migrations[index]!.sql)
    expect(memberships.all()).toEqual(after)
  } finally {
    db.close()
  }
})
