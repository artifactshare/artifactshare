import { RouterContextProvider } from 'react-router'
import { test, expect, vi } from 'vitest'
import { settingsAdminGate } from '../+lib/settings-admin.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  isFlagOn: vi.fn(),
  updateWorkspaceBotDestinations: vi.fn(),
}))

const db = vi.hoisted(() => ({}))

vi.mock('~/services/db.server', () => ({ createDb: () => db }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'user-1', workspaceId: 'workspace-1' }),
}))
vi.mock('~/lib/feature-flags.server', () => ({
  isFlagOn: services.isFlagOn,
}))
vi.mock('~/services/bot-members.server', () => ({
  listWorkspaceBots: vi.fn(),
  cancelWorkspaceBot: vi.fn(),
  createWorkspaceBot: vi.fn(),
  reissueWorkspaceBotCredential: vi.fn(),
  stopWorkspaceBot: vi.fn(),
}))

vi.mock('~/services/bot-destinations.server', () => ({
  updateWorkspaceBotDestinations: services.updateWorkspaceBotDestinations,
}))

import { action } from './bots'

// Who may reach the bots page is the admin gate's decision, covered with the
// real route topology in settings-admin-gate.test.ts; these requests passed it.
function admittedContext() {
  const context = new RouterContextProvider()
  context.set(settingsAdminGate, 'allowed')
  return context
}

test.each(['ok', 'forbidden', 'bot-conflict', 'bot-stopped'] as const)(
  'destination action is available with creation off and preserves %s result',
  async (kind) => {
    services.isFlagOn.mockResolvedValue(false)
    services.updateWorkspaceBotDestinations.mockResolvedValue({ kind })
    const input = {
      intent: 'destinations',
      botUserId: 'bot',
      projectId: 'b',
      projectIds: ['a', 'b'],
      revision: 'latest',
    }
    const url = new URL('https://example.com/settings/bots')
    const response = await action({
      request: new Request(url, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      context: admittedContext(),
      params: {},
      url,
      pattern: '/settings/bots',
    })
    expect(response.data).toEqual({
      ok: kind === 'ok',
      code: kind,
      intent: 'destinations',
    })
    expect(response.init?.status).toBe(
      kind === 'ok' ? 200 : kind === 'forbidden' ? 403 : 409,
    )
    expect(services.updateWorkspaceBotDestinations).toHaveBeenLastCalledWith(
      db,
      { id: 'user-1', workspaceId: 'workspace-1' },
      {
        botUserId: 'bot',
        projectId: 'b',
        projectIds: ['a', 'b'],
        revision: 'latest',
      },
    )
  },
)
