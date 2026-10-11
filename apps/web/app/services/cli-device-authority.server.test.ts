import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const authHandlerMock = vi.hoisted(() => vi.fn())
const sessionUserMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/auth.server', () => ({
  authHandlerWithHangDetection: authHandlerMock,
  getSessionUser: sessionUserMock,
}))

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const {
  attachAgentBootstrapAuthority,
  attachPublisherBootstrapAuthority,
  loadPublisherApprovalContext,
  selectPublisherApprovalClient,
  loadAgentApprovalContext,
  loadDeviceAuthorizationIntent,
  readDeviceAuthorizationIntent,
  selectAgentApprovalProject,
  storeDeviceAuthorizationIntent,
} = await import('./cli-device-authority.server')

const { action } = await import('../routes/api.auth.$')

describe('CLI device authorization intent', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    authHandlerMock.mockReset()
    sessionUserMock.mockReset()
    sessionUserMock.mockResolvedValue({
      id: 'u1',
      workspaceId: 'ws1',
      email: 'u1@example.com',
    })
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, created_at, updated_at
        ) VALUES ('project-1', 'ws1', 'project', 'u1', 'u1', 'Agent output',
          'workspace',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO deviceCode (
          id, deviceCode, userCode, userId, expiresAt, status, clientId
        ) VALUES ('dc1', 'device-1', 'ABCD1234', 'u1',
          '2099-01-01T00:00:00.000Z', 'pending', 'artifactshare-cli')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  function deviceRequest(
    endpoint: string,
    payload: Record<string, unknown>,
    encoding = 'application/json',
  ) {
    return new Request(`https://example.test/api/auth/device/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': `${encoding}; charset=UTF-8` },
      body:
        encoding === 'application/x-www-form-urlencoded'
          ? new URLSearchParams(
              Object.entries(payload).map(([key, value]) => [
                key,
                String(value),
              ]),
            )
          : JSON.stringify(payload),
    })
  }

  function runAction(request: Request) {
    return action({ request } as Parameters<typeof action>[0])
  }

  async function exchangeDeviceToken(
    preset: string | null,
    encoding = 'application/json',
  ) {
    sqlite.exec('PRAGMA ignore_check_constraints = ON')
    try {
      sqlite
        .prepare(
          "UPDATE deviceCode SET preset = ?, selectedProjectId = CASE WHEN ? = 'publisher' THEN NULL ELSE 'project-1' END WHERE id = 'dc1'",
        )
        .run(preset, preset)
    } finally {
      sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    }
    authHandlerMock.mockImplementation(async () => {
      sqlite
        .prepare(
          `INSERT INTO sessions (
            id, user_id, token, expires_at, user_agent, created_at, updated_at
          ) VALUES ('s1', 'u1', 'session-1', '2099-01-01T00:00:00.000Z',
            'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z')`,
        )
        .run()
      return Response.json({ access_token: 'session-1' })
    })
    return runAction(
      deviceRequest('token', { device_code: 'device-1' }, encoding),
    )
  }

  describe.each(['application/json', 'application/x-www-form-urlencoded'])(
    'device endpoint body validation (%s)',
    (encoding) => {
      test.each(['publisher', 'agent', 'unrestricted'])(
        'stores the requested %s intent before returning a device code',
        async (preset) => {
          authHandlerMock.mockResolvedValue(
            Response.json({ device_code: 'device-1' }),
          )
          const response = await runAction(
            deviceRequest(
              'code',
              { preset, device_name: 'Dashboard' },
              encoding,
            ),
          )
          expect(response.status).toBe(200)
          expect(authHandlerMock).toHaveBeenCalledOnce()
          expect(await loadDeviceAuthorizationIntent('device-1')).toMatchObject(
            {
              preset,
              deviceName: 'Dashboard',
            },
          )
          // Inspection must leave the original body available to the handler.
          const delegated = authHandlerMock.mock.calls[0][0] as Request
          expect(await delegated.text()).toContain('Dashboard')
        },
      )

      test.each([
        { preset: 'publisher' },
        { preset: 'publisher', device_name: '<script>' },
        {
          preset: 'publisher',
          device_name: 'Dashboard',
          project_selector: 'project-1',
        },
        { preset: 'unknown' },
      ])(
        'rejects invalid code intent %j without delegation',
        async (payload) => {
          const before = sqlite.prepare('SELECT * FROM deviceCode').all()
          authHandlerMock.mockResolvedValue(
            Response.json({ device_code: 'device-1' }),
          )
          const response = await runAction(
            deviceRequest('code', payload, encoding),
          )
          expect(response.status).toBe(400)
          expect(authHandlerMock).not.toHaveBeenCalled()
          expect(sqlite.prepare('SELECT * FROM deviceCode').all()).toEqual(
            before,
          )
        },
      )

      test('rejects publisher approval without an explicit client choice', async () => {
        await storeDeviceAuthorizationIntent('device-1', {
          preset: 'publisher',
          deviceName: 'Dashboard',
          projectSelector: null,
        })
        const before = sqlite.prepare('SELECT * FROM deviceCode').all()
        authHandlerMock.mockResolvedValue(Response.json({ success: true }))
        const response = await runAction(
          deviceRequest('approve', { userCode: 'ABCD1234' }, encoding),
        )
        expect(response.status).toBe(400)
        expect(authHandlerMock).not.toHaveBeenCalled()
        expect(sqlite.prepare('SELECT * FROM deviceCode').all()).toEqual(before)
        expect(sqlite.prepare('SELECT * FROM publisher_clients').all()).toEqual(
          [],
        )
      })

      test('binds an agent project before delegating approval', async () => {
        await storeDeviceAuthorizationIntent('device-1', {
          preset: 'agent',
          deviceName: 'Codex',
          projectSelector: null,
        })
        authHandlerMock.mockResolvedValue(Response.json({ success: true }))
        const response = await runAction(
          deviceRequest(
            'approve',
            { userCode: 'ABCD1234', project_id: 'project-1' },
            encoding,
          ),
        )
        expect(response.status).toBe(200)
        expect(authHandlerMock).toHaveBeenCalledOnce()
        expect(await loadDeviceAuthorizationIntent('device-1')).toMatchObject({
          selectedProjectId: 'project-1',
        })
      })

      test.each(['agent', 'unrestricted'])(
        'preserves %s token exchange',
        async (preset) => {
          const response = await exchangeDeviceToken(preset, encoding)
          expect(response.status).toBe(200)
          expect(sqlite.prepare('SELECT token FROM sessions').get()).toEqual({
            token: 'session-1',
          })
          expect(
            sqlite.prepare('SELECT preset FROM cli_session_authorities').get(),
          ).toEqual(preset === 'agent' ? { preset: 'agent' } : undefined)
        },
      )

      test.each([true, false])(
        'publisher token exchange enforces bootstrap attachment (approved: %s)',
        async (approved) => {
          await storeDeviceAuthorizationIntent('device-1', {
            preset: 'publisher',
            deviceName: 'Dashboard',
            projectSelector: null,
          })
          if (approved) {
            expect(
              await selectPublisherApprovalClient({
                userCode: 'ABCD1234',
                userId: 'u1',
                workspaceId: 'ws1',
                choice: { mode: 'create-new' },
              }),
            ).toBe(true)
          }
          const intent = await loadDeviceAuthorizationIntent('device-1')
          const response = await exchangeDeviceToken('publisher', encoding)
          expect(response.status).toBe(approved ? 200 : 400)
          expect(authHandlerMock).toHaveBeenCalledOnce()
          expect(sqlite.prepare('SELECT token FROM sessions').all()).toEqual(
            approved ? [{ token: 'session-1' }] : [],
          )
          expect(
            sqlite
              .prepare(
                'SELECT preset, publisher_client_id FROM cli_session_authorities',
              )
              .all(),
          ).toEqual(
            approved
              ? [
                  {
                    preset: 'publisher',
                    publisher_client_id: intent!.selectedPublisherClientId,
                  },
                ]
              : [],
          )
        },
      )
    },
  )

  test('uses the last repeated form field for authorization, like the auth handler', async () => {
    authHandlerMock.mockResolvedValue(
      Response.json({ device_code: 'device-1' }),
    )
    const response = await runAction(
      new Request('https://example.test/api/auth/device/code', {
        method: 'POST',
        body: new URLSearchParams([
          ['preset', 'unrestricted'],
          ['preset', 'publisher'],
          ['device_name', 'Dashboard'],
        ]),
      }),
    )
    expect(response.status).toBe(200)
    expect(await loadDeviceAuthorizationIntent('device-1')).toMatchObject({
      preset: 'publisher',
      deviceName: 'Dashboard',
    })
  })

  test('validates a publisher choice as an object, without coercing form strings', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'publisher',
      deviceName: 'Dashboard',
      projectSelector: null,
    })
    authHandlerMock.mockResolvedValue(Response.json({ success: true }))
    const response = await runAction(
      deviceRequest(
        'approve',
        {
          userCode: 'ABCD1234',
          publisher: JSON.stringify({ mode: 'create-new' }),
        },
        'application/x-www-form-urlencoded',
      ),
    )
    expect(response.status).toBe(400)
    expect(authHandlerMock).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT * FROM publisher_clients').all()).toEqual([])

    const approved = await runAction(
      deviceRequest('approve', {
        userCode: 'ABCD1234',
        publisher: { mode: 'create-new' },
      }),
    )
    expect(approved.status).toBe(200)
    expect(authHandlerMock).toHaveBeenCalledOnce()
    const client = sqlite
      .prepare('SELECT id, name FROM publisher_clients')
      .get()
    expect(client).toEqual({ id: expect.any(String), name: 'Dashboard' })
    expect(await loadDeviceAuthorizationIntent('device-1')).toMatchObject({
      selectedPublisherClientId: client!.id,
    })
  })

  test.each(['code', 'approve', 'token'])(
    'rejects unsupported and malformed bodies at /device/%s before delegation',
    async (endpoint) => {
      await storeDeviceAuthorizationIntent('device-1', {
        preset: 'publisher',
        deviceName: 'Dashboard',
        projectSelector: null,
      })
      const before = sqlite.prepare('SELECT * FROM deviceCode').all()
      authHandlerMock.mockResolvedValue(Response.json({ success: true }))
      const payload = JSON.stringify({
        preset: 'publisher',
        device_name: 'Dashboard',
        userCode: 'ABCD1234',
        device_code: 'device-1',
      })
      for (const contentType of [
        null,
        'text/plain',
        'multipart/form-data',
        'application/octet-stream',
      ]) {
        const response = await runAction(
          new Request(`https://example.test/api/auth/device/${endpoint}`, {
            method: 'POST',
            headers: contentType ? { 'Content-Type': contentType } : {},
            body: new TextEncoder().encode(payload),
          }),
        )
        expect(response.status).toBe(415)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
      }
      for (const body of ['{', 'null', '[]', '"text"']) {
        const response = await runAction(
          new Request(`https://example.test/api/auth/device/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }),
        )
        expect(response.status).toBe(400)
      }
      expect(authHandlerMock).not.toHaveBeenCalled()
      expect(sqlite.prepare('SELECT * FROM deviceCode').all()).toEqual(before)
      expect(sqlite.prepare('SELECT * FROM publisher_clients').all()).toEqual(
        [],
      )
      expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual([])
    },
  )

  test('publisher approval creates a stable owned identity and only explicit continuation reuses it', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'publisher',
      deviceName: 'Dashboard',
      projectSelector: null,
    })
    expect(await loadPublisherApprovalContext('ABCD1234', 'u1', 'ws1')).toEqual(
      { preset: 'publisher', requestedName: 'Dashboard', clients: [] },
    )
    expect(
      await selectPublisherApprovalClient({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        choice: { mode: 'create-new' },
      }),
    ).toBe(true)
    const intent = await loadDeviceAuthorizationIntent('device-1')
    expect(intent?.selectedPublisherClientId).toBeTruthy()
    const clientId = intent!.selectedPublisherClientId!
    // A second approval cannot replace the already selected identity.
    expect(
      await selectPublisherApprovalClient({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        choice: { mode: 'create-new' },
      }),
    ).toBe(false)
    sqlite.exec(`UPDATE deviceCode SET selectedPublisherClientId = NULL`)
    expect(
      await selectPublisherApprovalClient({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        choice: { mode: 'create-new' },
      }),
    ).toBe(false)
    expect(
      await selectPublisherApprovalClient({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        choice: { mode: 'continue-existing', client_id: clientId },
      }),
    ).toBe(true)
    expect(
      (await loadDeviceAuthorizationIntent('device-1'))
        ?.selectedPublisherClientId,
    ).toBe(clientId)
    sqlite.exec(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('publisher-session', 'u1', 'publisher-token', '2099-01-01', '2026-01-01', '2026-01-01')`,
    )
    expect(
      await attachPublisherBootstrapAuthority(
        'publisher-token',
        (await loadDeviceAuthorizationIntent('device-1'))!,
      ),
    ).toBe(true)
    expect(
      sqlite
        .prepare(
          'SELECT preset, publisher_client_id, bearer_only FROM cli_session_authorities',
        )
        .get(),
    ).toEqual({
      preset: 'publisher',
      publisher_client_id: clientId,
      bearer_only: 1,
    })
  })
  test.each(['foreign-user', 'foreign-workspace', 'expired', 'forged-mode'])(
    'rejects publisher selection for %s without binding a client',
    async (mode) => {
      await storeDeviceAuthorizationIntent('device-1', {
        preset: 'publisher',
        deviceName: 'Dashboard',
        projectSelector: null,
      })
      seedUser(sqlite, 'u2')
      sqlite.exec(
        `INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('foreign-client', 'u2', 'ws1', 'Dashboard', '2026-01-01')`,
      )
      if (mode === 'expired')
        sqlite.exec(`UPDATE deviceCode SET expiresAt = '2000-01-01'`)
      expect(
        await selectPublisherApprovalClient({
          userCode: 'ABCD1234',
          userId: 'u1',
          workspaceId: mode === 'foreign-workspace' ? 'ws2' : 'ws1',
          choice: {
            mode: mode === 'forged-mode' ? 'anything' : 'continue-existing',
            client_id: 'foreign-client',
          },
        }),
      ).toBe(false)
      expect(
        (await loadDeviceAuthorizationIntent('device-1'))
          ?.selectedPublisherClientId,
      ).toBeNull()
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM publisher_clients').get(),
      ).toEqual({ count: 1 })
    },
  )

  test.each(['unknown', ''])(
    'revokes the issued session for an unknown stored device preset %j',
    async (preset) => {
      const response = await exchangeDeviceToken(preset)

      expect(authHandlerMock).toHaveBeenCalledOnce()
      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Agent authorization is incomplete',
      })
      for (const table of [
        'sessions',
        'cli_session_authorities',
        'agent_profiles',
      ]) {
        expect(
          sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({
          count: 0,
        })
      }
    },
  )

  test.each([null, 'unrestricted', 'agent'])(
    'preserves device token exchange for preset %j',
    async (preset) => {
      const response = await exchangeDeviceToken(preset)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ access_token: 'session-1' })
      expect(sqlite.prepare('SELECT token FROM sessions').get()).toEqual({
        token: 'session-1',
      })
      const authority = sqlite
        .prepare('SELECT kind, preset FROM cli_session_authorities')
        .get()
      expect(authority).toEqual(
        preset === 'agent' ? { kind: 'bootstrap', preset: 'agent' } : undefined,
      )
    },
  )

  test('validates and stores an agent intent', async () => {
    const intent = readDeviceAuthorizationIntent({
      preset: 'agent',
      device_name: ' Codex ',
    })
    expect(intent).toEqual({
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await storeDeviceAuthorizationIntent('device-1', intent!)
    await expect(loadDeviceAuthorizationIntent('device-1')).resolves.toEqual({
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
      selectedProjectId: null,
    })
  })

  test('validates a bounded agent project selector and rejects unrestricted pairing', () => {
    const selector = '界'.repeat(120)
    expect(
      readDeviceAuthorizationIntent({
        preset: 'agent',
        project_selector: `  ${selector}  `,
      }),
    ).toMatchObject({ projectSelector: selector })
    expect(
      readDeviceAuthorizationIntent({
        preset: 'agent',
        project_selector: '界'.repeat(121),
      }),
    ).toBeNull()
    expect(
      readDeviceAuthorizationIntent({
        preset: 'unrestricted',
        project_selector: 'Agent output',
      }),
    ).toBeNull()
  })

  test('resolves a fixed project by name and treats an existing invalid id as terminal', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: 'agent OUTPUT',
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({
      fixedProjectError: false,
      fixedProject: { id: 'project-1', name: 'Agent output' },
    })
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, created_at, updated_at
        ) VALUES ('project-2', 'ws1', 'project', 'u1', 'u1', 'Other',
          'workspace', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        email: 'u1@example.com',
        projectId: 'project-2',
      }),
    ).resolves.toBe(false)

    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, archived_at, created_at, updated_at
        ) VALUES ('Agent output', 'ws1', 'project', 'u1', 'u1', 'Archived',
          'workspace', '2026-01-02T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      .run()
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: 'Agent output',
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({
      fixedProject: null,
      fixedProjectError: true,
    })
  })

  test('binds the selected project and creates a short-lived bootstrap', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        email: 'user@example.com',
        projectId: 'project-1',
      }),
    ).resolves.toBe(true)
    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) VALUES ('s1', 'u1', 'session-1', '2099-01-01T00:00:00.000Z',
          'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const intent = await loadDeviceAuthorizationIntent('device-1')
    await expect(
      attachAgentBootstrapAuthority('session-1', intent!),
    ).resolves.toBe(true)
    const authority = sqlite
      .prepare(
        `SELECT preset, project_id, agent_profile_id, kind
           FROM cli_session_authorities WHERE session_id = 's1'`,
      )
      .get()
    expect(authority).toMatchObject({
      preset: 'agent',
      project_id: 'project-1',
      kind: 'bootstrap',
    })
    expect(authority?.agent_profile_id).toEqual(expect.any(String))

    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) VALUES ('s2', 'u1', 'session-2', '2099-01-01T00:00:00.000Z',
          'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await expect(
      attachAgentBootstrapAuthority('session-2', intent!),
    ).resolves.toBe(true)
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count,
                  COUNT(DISTINCT agent_profile_id) AS profile_count
             FROM cli_session_authorities`,
        )
        .get(),
    ).toEqual({ count: 2, profile_count: 1 })
  })

  test('shows only publishable projects and binds only for the claiming user', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({})
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'other-user',
        workspaceId: 'ws1',
        email: 'u1@example.com',
        projectId: 'project-1',
      }),
    ).resolves.toBe(false)
    sqlite
      .prepare(
        "UPDATE artifact_containers SET base_visibility = 'private' WHERE id = 'project-1'",
      )
      .run()
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({ preset: 'agent' })
  })
})
