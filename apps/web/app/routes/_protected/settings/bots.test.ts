import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  loadSettingsShell: vi.fn(),
  listWorkspaceBots: vi.fn(),
  isBotMembersEnabled: vi.fn(),
}))

const db = vi.hoisted(() => ({
  selectFrom: vi.fn(() => ({
    select: vi.fn(() => ({
      where: vi.fn(() => ({
        where: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ execute: vi.fn(() => []) })),
          })),
        })),
      })),
    })),
  })),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => db }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'user-1', workspaceId: 'workspace-1' }),
}))
vi.mock('~/services/team-management.server', () => ({
  loadSettingsShell: services.loadSettingsShell,
}))
vi.mock('~/lib/bot-members-flag.server', () => ({
  isBotMembersEnabled: services.isBotMembersEnabled,
}))
vi.mock('~/services/bot-members.server', () => ({
  listWorkspaceBots: services.listWorkspaceBots,
  cancelWorkspaceBot: vi.fn(),
  createWorkspaceBot: vi.fn(),
  reissueWorkspaceBotCredential: vi.fn(),
  stopWorkspaceBot: vi.fn(),
}))

import { loader } from './bots'

describe('/settings/bots loader', () => {
  beforeEach(() => vi.clearAllMocks())

  test('does not expose bot inventory to a non-admin direct request', async () => {
    services.loadSettingsShell.mockResolvedValue({ currentUserIsAdmin: false })

    await expect(loader({ context: new Map() } as never)).rejects.toMatchObject(
      { status: 403 },
    )
    expect(services.listWorkspaceBots).not.toHaveBeenCalled()
  })

  test('loads bot inventory for an admin', async () => {
    services.loadSettingsShell.mockResolvedValue({ currentUserIsAdmin: true })
    services.listWorkspaceBots.mockResolvedValue([{ id: 'bot-1' }])
    services.isBotMembersEnabled.mockResolvedValue(true)

    await expect(
      loader({ context: new Map() } as never),
    ).resolves.toMatchObject({
      bots: [{ id: 'bot-1' }],
      botCreationEnabled: true,
    })
  })
})
