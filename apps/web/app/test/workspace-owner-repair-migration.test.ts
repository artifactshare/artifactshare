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
      'dated',
      'undated',
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
      ['dated', 'unknown', '2020', 'admin', '2020', '2020'],
      ['dated', 'earlier', '2024', 'admin', '2022', '2025'],
      ['dated', 'former-admin', '2017', 'admin', '2017', '2017'],
      ['dated', '0-equal-start', '2018', 'admin', null, '2018'],
      ['dated', 'later', '2022', 'admin', null, '2022'],
      ['dated', 'revoked', '2019', 'admin', '2019', '2019'],
      ['undated', 'second', '2020', 'admin', '2021', '2020'],
      ['undated', 'first', '2021', 'admin', '2020', '2024'],
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
        created,
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
        ('1','dated',NULL,'user','later','admin.grant','2018'),
        ('2','dated',NULL,'user','later','owner.transfer','2019'),
        ('3','dated','earlier','user','later','owner.transfer','2021'),
        ('4','dated',NULL,'user','later','admin.grant','2023'),
        ('5','dated',NULL,'user','revoked','admin.grant','2017'),
        ('6','dated',NULL,'user','revoked','admin.revoke','2019'),
        ('7','dated',NULL,'user','former-admin','admin.grant','2016'),
        ('8','dated',NULL,'user','former-admin','owner.transfer','2018'),
        ('9','dated',NULL,'user','0-equal-start','admin.grant','2021');
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
    ).toEqual(['writer', 'earlier', 'owner', 'a', 'replacement', 'first'])
    expect(after.find((row) => row.user_id === 'a')?.created_at).toBe('2020')
    for (const row of before) {
      const repaired = after.find((member) => member.user_id === row.user_id)
      if (row.user_id === 'former')
        expect(repaired).toEqual({ ...row, role: 'member' })
      else if (repaired?.role === 'owner' && row.role !== 'owner')
        expect(repaired).toEqual({
          ...row,
          role: 'owner',
          updated_at: expect.any(String),
        })
      else expect(repaired).toEqual(row)
    }
    db.exec(migrations[index]!.sql)
    expect(memberships.all()).toEqual(after)
  } finally {
    db.close()
  }
})
