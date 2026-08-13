import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  canEditProjectContainer,
  createProjectContainer,
  editProjectContainerSettings,
  findWorkspaceProject,
  getProjectContainerWorkspaceId,
  lookupProjectShareDefaultUsers,
  resolveUploadContainer,
  saveProjectShareDefaults,
  unarchiveProjectContainer,
  updateProjectContainer,
  normalizeProjectDescription,
  normalizeProjectName,
  parseProjectBaseVisibility,
} from './projects.server'

describe('project input normalization', () => {
  test.each([
    ['trims names', '  Launch  ', 'Launch'],
    ['rejects non-string names', 42, null],
    ['rejects empty names', '', null],
    ['rejects whitespace-only names', '  \t', null],
    ['truncates names at 120 characters', 'x'.repeat(121), 'x'.repeat(120)],
    ['keeps names within the limit', 'Launch', 'Launch'],
  ])('%s', (_, input, expected) =>
    expect(normalizeProjectName(input)).toBe(expected),
  )

  test.each([
    ['trims descriptions', '  Details  ', 'Details'],
    ['rejects non-string descriptions', {}, null],
    ['rejects empty descriptions', '', null],
    ['rejects whitespace-only descriptions', '  \n', null],
    [
      'truncates descriptions at 500 characters',
      'x'.repeat(501),
      'x'.repeat(500),
    ],
    ['keeps descriptions within the limit', 'Details', 'Details'],
  ])('%s', (_, input, expected) =>
    expect(normalizeProjectDescription(input)).toBe(expected),
  )

  test.each([
    ['accepts private', 'private', 'private'],
    ['defaults unknown values to workspace', 'public', 'workspace'],
    ['defaults non-string values to workspace', null, 'workspace'],
  ])('%s', (_, input, expected) =>
    expect(parseProjectBaseVisibility(input)).toBe(expected),
  )
})

describe('project share defaults', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
    await seedProject(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  async function listEmails(): Promise<string[]> {
    const rows = await db
      .selectFrom('project_share_defaults')
      .select('email')
      .where('project_container_id', '=', 'project-a')
      .orderBy('email', 'asc')
      .execute()
    return rows.map((row) => row.email)
  }

  async function getDefaultRow(email: string) {
    return db
      .selectFrom('project_share_defaults')
      .select(['email', 'role', 'created_at', 'updated_at'])
      .where('project_container_id', '=', 'project-a')
      .where('email', '=', email)
      .executeTakeFirst()
  }

  test('adds entries with the specified role', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [{ email: 'c@example.com', role: 'contributor' }],
      }),
    ).resolves.toBe('ok')

    const row = await getDefaultRow('c@example.com')
    expect(row?.role).toBe('contributor')
  })

  test('drops malformed emails from addEntries (matches addEmails validation)', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [
          { email: 'not an email', role: 'viewer' },
          { email: 'ok@example.com', role: 'contributor' },
        ],
      }),
    ).resolves.toBe('ok')

    expect(await listEmails()).toEqual(['ok@example.com'])
  })

  test('addEmails still defaults new entries to viewer', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['v@example.com'],
      }),
    ).resolves.toBe('ok')

    const row = await getDefaultRow('v@example.com')
    expect(row?.role).toBe('viewer')
  })

  test('roleChanges update the role without resetting created_at', async () => {
    await saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
      addEmails: ['role@example.com'],
    })
    const before = await getDefaultRow('role@example.com')
    expect(before?.role).toBe('viewer')

    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        roleChanges: [{ email: 'role@example.com', role: 'manager' }],
      }),
    ).resolves.toBe('ok')

    const after = await getDefaultRow('role@example.com')
    expect(after?.role).toBe('manager')
    expect(after?.created_at).toBe(before?.created_at)
  })

  test('rejects addEntries beyond the individual share limit', async () => {
    await db
      .insertInto('project_share_defaults')
      .values(
        Array.from({ length: MAX_GRANT_EMAILS }, (_, index) => ({
          id: `default-${index}`,
          project_container_id: 'project-a',
          email: `person-${index}@example.com`,
          role: 'viewer',
          display_name: null,
          created_by_id: 'u1',
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })),
      )
      .execute()

    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [{ email: 'next@example.com', role: 'contributor' }],
      }),
    ).resolves.toBe('too-many')

    const count = await db
      .selectFrom('project_share_defaults')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('project_container_id', '=', 'project-a')
      .executeTakeFirstOrThrow()
    expect(Number(count.total)).toBe(MAX_GRANT_EMAILS)
  })

  test('does not change role when re-adding an existing email via addEntries', async () => {
    await saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
      addEmails: ['existing@example.com'],
    })
    expect((await getDefaultRow('existing@example.com'))?.role).toBe('viewer')

    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [{ email: 'existing@example.com', role: 'manager' }],
      }),
    ).resolves.toBe('ok')

    expect((await getDefaultRow('existing@example.com'))?.role).toBe('viewer')
  })

  test('stores added emails lowercased and ignores re-adds', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: [' Team@Example.com '],
      }),
    ).resolves.toBe('ok')
    expect(await listEmails()).toEqual(['team@example.com'])

    // 大文字で再追加しても、小文字化により既存とみなして増えない。
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['TEAM@example.com'],
      }),
    ).resolves.toBe('ok')
    expect(await listEmails()).toEqual(['team@example.com'])
  })

  test('treats a mixed-case stored email as existing on re-add (no duplicate row)', async () => {
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'psd-mixed',
        project_container_id: 'project-a',
        email: 'Viewer@Example.com',
        role: 'viewer',
        display_name: null,
        created_by_id: 'u1',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['viewer@example.com'],
      }),
    ).resolves.toBe('ok')

    // 既存行を素の row.email でなく lower で照合するので、重複行は増えない。
    expect(await listEmails()).toEqual(['Viewer@Example.com'])
  })

  test('applies removes and adds in a single save', async () => {
    await saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
      addEmails: ['a@example.com', 'b@example.com'],
    })
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['c@example.com'],
        removeEmails: ['a@example.com'],
      }),
    ).resolves.toBe('ok')
    expect(await listEmails()).toEqual(['b@example.com', 'c@example.com'])
  })

  test('rejects additions beyond the individual share limit', async () => {
    await db
      .insertInto('project_share_defaults')
      .values(
        Array.from({ length: MAX_GRANT_EMAILS }, (_, index) => ({
          id: `default-${index}`,
          project_container_id: 'project-a',
          email: `person-${index}@example.com`,
          role: 'viewer',
          display_name: null,
          created_by_id: 'u1',
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })),
      )
      .execute()

    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['next@example.com'],
      }),
    ).resolves.toBe('too-many')

    const count = await db
      .selectFrom('project_share_defaults')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('project_container_id', '=', 'project-a')
      .executeTakeFirstOrThrow()
    expect(Number(count.total)).toBe(MAX_GRANT_EMAILS)
  })

  test('keeps removals intact when the save exceeds the limit', async () => {
    await db
      .insertInto('project_share_defaults')
      .values(
        Array.from({ length: MAX_GRANT_EMAILS }, (_, index) => ({
          id: `default-${index}`,
          project_container_id: 'project-a',
          email: `person-${index}@example.com`,
          role: 'viewer',
          display_name: null,
          created_by_id: 'u1',
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })),
      )
      .execute()

    // 1 件外して 2 件足すと上限を 1 超えるので too-many。削除は適用しない。
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        removeEmails: ['person-0@example.com'],
        addEmails: ['x@example.com', 'y@example.com'],
      }),
    ).resolves.toBe('too-many')

    expect(await listEmails()).toContain('person-0@example.com')
    const count = await db
      .selectFrom('project_share_defaults')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('project_container_id', '=', 'project-a')
      .executeTakeFirstOrThrow()
    expect(Number(count.total)).toBe(MAX_GRANT_EMAILS)
  })

  test('excludes the owner email from additions', async () => {
    await expect(
      saveProjectShareDefaults(
        db,
        'ws-a',
        'project-a',
        'u1',
        { addEmails: ['Owner@example.com', 'teammate@example.com'] },
        'owner@example.com',
      ),
    ).resolves.toBe('ok')
    expect(await listEmails()).toEqual(['teammate@example.com'])
  })

  test('returns not-found for a project outside the workspace', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-other', 'project-a', 'u1', {
        addEmails: ['x@example.com'],
      }),
    ).resolves.toBe('not-found')
  })

  test('lookupProjectShareDefaultUsers resolves known users for editors', async () => {
    const result = await lookupProjectShareDefaultUsers(
      db,
      'ws-a',
      'project-a',
      { id: 'u1', email: 'owner@example.com', emailVerified: true },
      ['owner@example.com', 'stranger@example.com'],
    )
    expect(result).toEqual({
      kind: 'ok',
      entries: [
        {
          email: 'owner@example.com',
          user: { id: 'u1', name: 'Owner', image: null, kind: 'human' },
        },
        { email: 'stranger@example.com', user: null },
      ],
    })
  })

  test('lookupProjectShareDefaultUsers denies non-editors', async () => {
    await expect(
      lookupProjectShareDefaultUsers(
        db,
        'ws-a',
        'project-a',
        { id: 'u2', email: 'stranger@example.com', emailVerified: true },
        ['owner@example.com'],
      ),
    ).resolves.toEqual({ kind: 'not-found' })
  })

  test('lookupProjectShareDefaultUsers allows managers when managerRoleEnabled is true', async () => {
    await seedShareDefault(db, {
      email: 'manager@example.com',
      role: 'manager',
    })
    await seedUser(db, {
      id: 'u-manager',
      email: 'manager@example.com',
    })

    const result = await lookupProjectShareDefaultUsers(
      db,
      'ws-a',
      'project-a',
      { id: 'u-manager', email: 'manager@example.com', emailVerified: true },
      ['owner@example.com'],
      { managerRoleEnabled: true },
    )
    expect(result.kind).toBe('ok')
  })

  test('lookupProjectShareDefaultUsers denies managers when managerRoleEnabled is false or omitted', async () => {
    await seedShareDefault(db, {
      email: 'manager@example.com',
      role: 'manager',
    })
    await seedUser(db, {
      id: 'u-manager',
      email: 'manager@example.com',
    })
    const user = {
      id: 'u-manager',
      email: 'manager@example.com',
      emailVerified: true,
    }

    await expect(
      lookupProjectShareDefaultUsers(db, 'ws-a', 'project-a', user, [
        'owner@example.com',
      ]),
    ).resolves.toEqual({ kind: 'not-found' })
    await expect(
      lookupProjectShareDefaultUsers(
        db,
        'ws-a',
        'project-a',
        user,
        ['owner@example.com'],
        { managerRoleEnabled: false },
      ),
    ).resolves.toEqual({ kind: 'not-found' })
  })

  test('saveProjectShareDefaults rejects non-viewer addEntries when allowNonViewerRoles is false', async () => {
    await expect(
      saveProjectShareDefaults(
        db,
        'ws-a',
        'project-a',
        'u1',
        { addEntries: [{ email: 'c@example.com', role: 'contributor' }] },
        undefined,
        { allowNonViewerRoles: false },
      ),
    ).resolves.toBe('role-not-allowed')
    expect(await listEmails()).toEqual([])
  })

  test('saveProjectShareDefaults rejects non-viewer roleChanges when allowNonViewerRoles is false', async () => {
    await saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
      addEmails: ['v@example.com'],
    })
    await expect(
      saveProjectShareDefaults(
        db,
        'ws-a',
        'project-a',
        'u1',
        { roleChanges: [{ email: 'v@example.com', role: 'manager' }] },
        undefined,
        { allowNonViewerRoles: false },
      ),
    ).resolves.toBe('role-not-allowed')
    expect((await getDefaultRow('v@example.com'))?.role).toBe('viewer')
  })

  test('saveProjectShareDefaults allows viewer addEmails when allowNonViewerRoles is false', async () => {
    await expect(
      saveProjectShareDefaults(
        db,
        'ws-a',
        'project-a',
        'u1',
        { addEmails: ['v@example.com'] },
        undefined,
        { allowNonViewerRoles: false },
      ),
    ).resolves.toBe('ok')
    expect(await listEmails()).toEqual(['v@example.com'])
  })

  test('saveProjectShareDefaults allows non-viewer addEntries when allowNonViewerRoles is true', async () => {
    await expect(
      saveProjectShareDefaults(
        db,
        'ws-a',
        'project-a',
        'u1',
        { addEntries: [{ email: 'c@example.com', role: 'contributor' }] },
        undefined,
        { allowNonViewerRoles: true },
      ),
    ).resolves.toBe('ok')
    expect((await getDefaultRow('c@example.com'))?.role).toBe('contributor')
  })

  test('createProjectContainer stores the chosen base visibility', async () => {
    const result = await createProjectContainer(db, 'ws-a', 'u1', {
      name: 'Client',
      description: null,
      baseVisibility: 'private',
    })
    expect(result).toEqual({ kind: 'ok', id: expect.any(String) })
    if (result.kind !== 'ok') return

    const project = await findWorkspaceProject(db, 'ws-a', result.id)
    expect(project?.baseVisibility).toBe('private')
  })

  test('createProjectContainer auto-joins the creator', async () => {
    const result = await createProjectContainer(db, 'ws-a', 'u1', {
      name: 'Auto join',
      description: null,
      baseVisibility: 'workspace',
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const rows = await db
      .selectFrom('project_members')
      .selectAll()
      .where('container_id', '=', result.id)
      .execute()
    expect(rows.map((r) => r.user_id)).toEqual(['u1'])
  })

  test('updateProjectContainer changes the base visibility', async () => {
    const updated = await updateProjectContainer(db, 'ws-a', 'project-a', {
      name: 'Project A',
      description: null,
      baseVisibility: 'private',
    })
    expect(updated?.baseVisibility).toBe('private')
  })

  test('editProjectContainerSettings returns the edited project and audience', async () => {
    await saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
      addEmails: ['old@example.com'],
    })

    const result = await editProjectContainerSettings(
      db,
      'ws-a',
      'project-a',
      { id: 'u1', email: 'owner@example.com', emailVerified: true },
      {
        name: ' Renamed project ',
        description: '',
        baseVisibility: 'private',
        addEmails: ['new@example.com'],
        removeEmails: ['old@example.com'],
        archived: true,
      },
    )

    expect(result).toMatchObject({
      kind: 'ok',
      project: {
        id: 'project-a',
        name: 'Renamed project',
        description: null,
        baseVisibility: 'private',
      },
      audience: ['new@example.com'],
    })
    expect(
      result.kind === 'ok' ? result.project.archivedAt : null,
    ).not.toBeNull()
  })

  test('editProjectContainerSettings refuses metadata edits on archived projects', async () => {
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-06-01T00:00:00.000Z' })
      .where('id', '=', 'project-a')
      .execute()

    await expect(
      editProjectContainerSettings(
        db,
        'ws-a',
        'project-a',
        { id: 'u1', email: 'owner@example.com', emailVerified: true },
        { name: 'Nope' },
      ),
    ).resolves.toEqual({ kind: 'project-archived' })
  })
})

describe('getProjectContainerWorkspaceId', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
    await seedProject(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns the workspace id for an active project', async () => {
    await expect(getProjectContainerWorkspaceId(db, 'project-a')).resolves.toBe(
      'ws-a',
    )
  })

  test('returns null for a missing project id', async () => {
    await expect(
      getProjectContainerWorkspaceId(db, 'missing-project'),
    ).resolves.toBeNull()
  })

  test('returns null for an archived project', async () => {
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-05-23T00:00:00.000Z' })
      .where('id', '=', 'project-a')
      .execute()

    await expect(
      getProjectContainerWorkspaceId(db, 'project-a'),
    ).resolves.toBeNull()
  })
})

describe('canEditProjectContainer', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
    await seedProject(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('allows the project creator regardless of managerRoleEnabled', async () => {
    const user = { id: 'u1', email: 'owner@example.com', emailVerified: true }
    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', user),
    ).resolves.toBe(true)
    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', user, {
        managerRoleEnabled: false,
      }),
    ).resolves.toBe(true)
    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', user, {
        managerRoleEnabled: true,
      }),
    ).resolves.toBe(true)
  })

  test('allows a workspace admin on a team workspace', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    await seedUser(db, {
      id: 'u-admin',
      email: 'admin@example.com',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'u-admin',
        role: 'admin',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', {
        id: 'u-admin',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    ).resolves.toBe(true)
  })

  test('allows a manager when managerRoleEnabled is true', async () => {
    await seedShareDefault(db, {
      email: 'manager@example.com',
      role: 'manager',
    })
    await seedUser(db, {
      id: 'u-manager',
      email: 'Manager@Example.com',
    })

    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        { id: 'u-manager', email: 'Manager@Example.com', emailVerified: true },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(true)
  })

  test('allows a manager whose stored email is mixed-case', async () => {
    await seedShareDefault(db, {
      email: 'Manager@Example.com',
      role: 'manager',
    })

    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        { id: 'u-manager', email: 'manager@example.com', emailVerified: true },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(true)
  })

  // 述語は user の所属に依存せず email 一致で manager 行を引く。プロジェクトの
  // ワークスペースに属さない (= 別ワークスペースの社外) manager も、その
  // workspaceId で呼べば通る。cross-workspace の到達 (SharedProjectDetail の
  // 管理入口・プロジェクトワークスペース解決) の配線は後続 PR。
  test('allows a manager who is not a member of the project workspace', async () => {
    await seedShareDefault(db, {
      email: 'external.manager@partner.com',
      role: 'manager',
    })

    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        {
          id: 'u-outside-ws-a',
          email: 'External.Manager@partner.com',
          emailVerified: true,
        },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(true)
  })

  test('denies a manager when managerRoleEnabled is false or omitted', async () => {
    await seedShareDefault(db, {
      email: 'manager@example.com',
      role: 'manager',
    })
    await seedUser(db, {
      id: 'u-manager',
      email: 'manager@example.com',
    })
    const user = {
      id: 'u-manager',
      email: 'manager@example.com',
      emailVerified: true,
    }

    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', user),
    ).resolves.toBe(false)
    await expect(
      canEditProjectContainer(db, 'ws-a', 'project-a', user, {
        managerRoleEnabled: false,
      }),
    ).resolves.toBe(false)
  })

  test('denies contributor and viewer share defaults even when managerRoleEnabled is true', async () => {
    await seedShareDefault(db, {
      email: 'contributor@example.com',
      role: 'contributor',
    })
    await seedShareDefault(db, {
      email: 'viewer@example.com',
      role: 'viewer',
    })

    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        {
          id: 'u-contrib',
          email: 'contributor@example.com',
          emailVerified: true,
        },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(false)
    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        { id: 'u-viewer', email: 'viewer@example.com', emailVerified: true },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(false)
  })

  test('denies users who are not creator, admin, or manager', async () => {
    await seedUser(db, {
      id: 'u2',
      email: 'stranger@example.com',
    })

    await expect(
      canEditProjectContainer(
        db,
        'ws-a',
        'project-a',
        { id: 'u2', email: 'stranger@example.com', emailVerified: true },
        { managerRoleEnabled: true },
      ),
    ).resolves.toBe(false)
  })
})

describe('resolveUploadContainer cross-workspace', () => {
  let db: Kysely<DB>
  const now = '2026-05-22T00:00:00.000Z'
  const poster = {
    id: 'u1',
    email: 'owner@example.com',
    emailVerified: true,
    workspaceId: 'ws-a',
  }

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
    await seedProject(db)
    await seedWorkspaceB(db)
    await seedProjectB(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('resolves own-workspace project', async () => {
    const result = await resolveUploadContainer(db, poster, 'project-a', now)
    expect(result).toEqual({
      kind: 'ok',
      containerId: 'project-a',
      containerKind: 'project',
      workspaceId: 'ws-a',
      isExternalPosting: false,
    })
  })

  test('resolves inbox when containerId is null', async () => {
    const result = await resolveUploadContainer(db, poster, null, now)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.containerKind).toBe('inbox')
    expect(result.workspaceId).toBe('ws-a')
    expect(result.isExternalPosting).toBe(false)
  })

  test('resolves cross-workspace project for contributor when policy allows it', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', external_posting_enabled: 1 })
      .where('id', '=', 'ws-b')
      .execute()
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'contributor',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
  })

  test('resolves cross-workspace project for manager when policy allows it', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', external_posting_enabled: 1 })
      .where('id', '=', 'ws-b')
      .execute()
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'manager',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
  })

  test('rejects cross-workspace project when workspace policy disables it', async () => {
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'contributor',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('rejects cross-workspace project for viewer', async () => {
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'viewer',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('rejects cross-workspace project when poster is not a share default', async () => {
    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('rejects cross-workspace project when destination plan is free', async () => {
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'contributor',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('resolves cross-workspace project when destination plan is plus', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', external_posting_enabled: 1 })
      .where('id', '=', 'ws-b')
      .execute()
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'contributor',
    })

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
  })

  test('rejects unknown containerId', async () => {
    const result = await resolveUploadContainer(
      db,
      poster,
      'missing-project',
      now,
    )
    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('rejects archived cross-workspace project even for contributor', async () => {
    await seedShareDefaultForProject(db, {
      projectContainerId: 'project-b',
      email: 'owner@example.com',
      role: 'contributor',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-05-23T00:00:00.000Z' })
      .where('id', '=', 'project-b')
      .execute()

    const result = await resolveUploadContainer(db, poster, 'project-b', now)
    expect(result).toEqual({ kind: 'invalid-container' })
  })
})

describe('createProjectContainer plan limits', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  async function seedProjects(count: number) {
    for (let index = 0; index < count; index += 1) {
      await db
        .insertInto('artifact_containers')
        .values({
          id: `project-${index}`,
          workspace_id: 'ws-a',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u1',
          name: `Project ${index}`,
          description: null,
          archived_at: null,
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })
        .execute()
    }
  }

  test('allows the fifth free project and rejects the sixth', async () => {
    await seedProjects(4)
    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Fifth',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'ok', id: expect.any(String) })

    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Sixth',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'project-limit-reached', limit: 5 })
  })

  test('allows the twentieth plus project and rejects the twenty-first', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus' })
      .where('id', '=', 'ws-a')
      .execute()
    await seedProjects(19)
    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Twentieth',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'ok', id: expect.any(String) })

    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Twenty-first',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'project-limit-reached', limit: 20 })
  })

  test('does not limit team workspaces', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    await seedProjects(25)
    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Twenty-sixth',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'ok', id: expect.any(String) })
  })

  test('does not count archived projects toward the limit', async () => {
    await seedProjects(5)
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-05-23T00:00:00.000Z' })
      .where('id', '=', 'project-0')
      .execute()

    await expect(
      createProjectContainer(db, 'ws-a', 'u1', {
        name: 'Replacement',
        description: null,
        baseVisibility: 'workspace',
      }),
    ).resolves.toEqual({ kind: 'ok', id: expect.any(String) })
  })
})

describe('unarchiveProjectContainer plan limits', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  async function seedProjects(count: number, archivedIndex?: number) {
    for (let index = 0; index < count; index += 1) {
      await db
        .insertInto('artifact_containers')
        .values({
          id: `project-${index}`,
          workspace_id: 'ws-a',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u1',
          name: `Project ${index}`,
          description: null,
          archived_at:
            archivedIndex === index ? '2026-05-23T00:00:00.000Z' : null,
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })
        .execute()
    }
  }

  test('rejects unarchive when the active project limit is reached', async () => {
    await seedProjects(6, 0)
    await expect(
      unarchiveProjectContainer(db, 'ws-a', 'project-0', 'u1'),
    ).resolves.toEqual({ kind: 'project-limit-reached', limit: 5 })
    expect(
      await db
        .selectFrom('artifact_containers')
        .select('archived_at')
        .where('id', '=', 'project-0')
        .executeTakeFirst(),
    ).toMatchObject({ archived_at: '2026-05-23T00:00:00.000Z' })
  })

  test('unarchives when below the active project limit', async () => {
    await seedProjects(5, 0)
    await expect(
      unarchiveProjectContainer(db, 'ws-a', 'project-0', 'u1'),
    ).resolves.toBe('ok')
    expect(
      await db
        .selectFrom('artifact_containers')
        .select('archived_at')
        .where('id', '=', 'project-0')
        .executeTakeFirst(),
    ).toMatchObject({ archived_at: null })
  })

  test('does not limit team workspaces', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    for (let index = 0; index < 25; index += 1) {
      await db
        .insertInto('artifact_containers')
        .values({
          id: `project-${index}`,
          workspace_id: 'ws-a',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u1',
          name: `Project ${index}`,
          description: null,
          archived_at: index === 0 ? '2026-05-23T00:00:00.000Z' : null,
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
        })
        .execute()
    }

    await expect(
      unarchiveProjectContainer(db, 'ws-a', 'project-0', 'u1'),
    ).resolves.toBe('ok')
  })
})

describe('bot grant guard', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedWorkspace(db)
    await seedProject(db)
    await db
      .insertInto('users')
      .values({
        id: 'bot1',
        email: 'bot-abc@bots.artifactshare.invalid',
        email_verified: 1,
        name: 'Bot',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        kind: 'bot',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'bot1',
        role: 'member',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('grants viewer and contributor to an active bot', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [
          { email: 'bot-abc@bots.artifactshare.invalid', role: 'contributor' },
        ],
      }),
    ).resolves.toBe('ok')
  })

  test('rejects manager role for a bot', async () => {
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEntries: [
          { email: 'bot-abc@bots.artifactshare.invalid', role: 'manager' },
        ],
      }),
    ).resolves.toBe('bot-grant-role-invalid')
  })

  test('rejects grants to a stopped bot even by directly typed email', async () => {
    await db
      .updateTable('users')
      .set({ bot_stopped_at: '2026-06-01T00:00:00.000Z' })
      .where('id', '=', 'bot1')
      .execute()
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['bot-abc@bots.artifactshare.invalid'],
      }),
    ).resolves.toBe('bot-stopped-grant-rejected')
    const rows = await db
      .selectFrom('project_share_defaults')
      .select('email')
      .execute()
    expect(rows).toHaveLength(0)
  })

  test('rejects grants to a bot from another workspace', async () => {
    // Move the bot's host workspace: grant into ws-a must be rejected.
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-b',
        hd: null,
        name: 'Other',
        created_at: '2026-05-22T00:00:00.000Z',
        plan: 'team',
        storage_quota_bytes: 1,
      })
      .execute()
    await db
      .deleteFrom('workspace_members')
      .where('user_id', '=', 'bot1')
      .execute()
    // users.kind is immutable but workspace_id is not.
    await db
      .updateTable('users')
      .set({ workspace_id: 'ws-b' })
      .where('id', '=', 'bot1')
      .execute()
    await expect(
      saveProjectShareDefaults(db, 'ws-a', 'project-a', 'u1', {
        addEmails: ['bot-abc@bots.artifactshare.invalid'],
      }),
    ).resolves.toBe('bot-grant-workspace-invalid')
  })
})

async function seedWorkspace(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Example',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
}

async function seedProject(db: Kysely<DB>) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'project-a',
      workspace_id: 'ws-a',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Project A',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedUser(db: Kysely<DB>, input: { id: string; email: string }) {
  await db
    .insertInto('users')
    .values({
      id: input.id,
      email: input.email,
      email_verified: 1,
      name: input.id,
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
}

async function seedShareDefault(
  db: Kysely<DB>,
  input: { email: string; role: 'viewer' | 'contributor' | 'manager' },
) {
  await seedShareDefaultForProject(db, {
    projectContainerId: 'project-a',
    email: input.email,
    role: input.role,
  })
}

async function seedWorkspaceB(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-b',
      hd: 'other.example.com',
      name: 'Other Org',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedProjectB(db: Kysely<DB>) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'project-b',
      workspace_id: 'ws-b',
      kind: 'project',
      owner_user_id: null,
      created_by_id: null,
      name: 'Project B',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedShareDefaultForProject(
  db: Kysely<DB>,
  input: {
    projectContainerId: string
    email: string
    role: 'viewer' | 'contributor' | 'manager'
  },
) {
  await db
    .insertInto('project_share_defaults')
    .values({
      id: `default-${input.projectContainerId}-${input.email}`,
      project_container_id: input.projectContainerId,
      email: input.email,
      role: input.role,
      display_name: null,
      created_by_id: 'u1',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}
