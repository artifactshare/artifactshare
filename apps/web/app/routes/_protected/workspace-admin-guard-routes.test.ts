import { RouterContextProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { userContext } from '~/middleware/context'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { seedWorkspace, seedUser } from '~/test/db-seed-fixture'
import { loader as recipients } from './settings/recipients'
import { loader as members } from './settings/_content/index'
import { loader as activity } from './settings/_content/activity'
import { settingsAdminMiddleware } from './settings/+lib/settings-admin.server'
import { loadSettingsShell } from './settings/+lib/settings-request.server'
import {
  action as rename,
  loader as general,
} from './settings/_content/general'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: () => fixture.db }))
const fixture = createMigratedInMemoryDb()

test('ownerless settings read persisted roles and require an active admin to search, rename or open admin pages', async () => {
  const { db, sqlite } = fixture
  try {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'actor')
    seedUser(sqlite, 'recipient')
    sqlite.exec(`INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at)
      SELECT workspace_id,id,'member','active',created_at,updated_at FROM users`)
    const context = new RouterContextProvider()
    context.set(userContext, {
      id: 'actor',
      email: 'actor@example.com',
      emailVerified: true,
      workspaceId: 'ws1',
      kind: 'human',
      name: null,
      image: null,
      locale: null,
      hd: null,
      msTenantId: null,
    })
    for (const role of ['member', 'admin'] as const) {
      await db
        .updateTable('workspace_members')
        .set({ role })
        .where('user_id', '=', 'actor')
        .execute()
      const rows = db
        .selectFrom('workspace_members')
        .selectAll()
        .orderBy('user_id')
      const before = await rows.execute()
      const url = new URL('https://example.test/settings')
      // Each request gets its own context, as the server provides.
      const request = new RouterContextProvider()
      request.set(userContext, context.get(userContext))
      const args = {
        request: new Request(url),
        context: request,
        url,
        params: {},
        pattern: '/settings' as const,
      }
      expect(await general({ ...args, pattern: '/settings/general' })).toEqual({
        owner: null,
      })
      expect(await members(args)).toMatchObject({
        membersPage: { total: 2 },
      })
      expect(await loadSettingsShell(request)).toMatchObject({
        currentUserRole: role,
      })
      const result = await recipients({
        ...args,
        pattern: '/settings/recipients',
      })
      expect(result.recipients.map((person) => person.id)).toEqual(
        role === 'admin' ? ['recipient'] : [],
      )
      const adminPage = { ...args, pattern: '/settings/activity' }
      await settingsAdminMiddleware(adminPage, async () => new Response())
      const opened = Promise.resolve().then(() => activity(adminPage))
      if (role === 'admin')
        await expect(opened).resolves.toMatchObject({ page: 1 })
      else await expect(opened).rejects.toMatchObject({ init: { status: 403 } })
      const response = await rename({
        ...args,
        pattern: '/settings/general',
        request: new Request(url, {
          method: 'POST',
          body: new URLSearchParams({
            intent: 'update-workspace-name',
            workspaceName: 'Renamed',
          }),
        }),
      })
      expect(response.init?.status).toBe(role === 'admin' ? 200 : 403)
      expect(
        await db.selectFrom('workspaces').select('name').executeTakeFirst(),
      ).toEqual({ name: role === 'admin' ? 'Renamed' : 'Example' })
      expect(await rows.execute()).toEqual(before)
    }
  } finally {
    await db.destroy()
  }
})
