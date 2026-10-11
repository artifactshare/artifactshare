import { renderToStaticMarkup } from 'react-dom/server'
import { bindI18n } from '~/lib/i18n'
import type { Locale } from '~/i18n/messages'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  revokeAllCliRefreshCredentialFamilies: vi.fn(),
  revokeCliRefreshCredentialFamily: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'current-user' }),
}))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: vi.fn(),
  revokeAllCliRefreshCredentialFamilies:
    services.revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily: services.revokeCliRefreshCredentialFamily,
}))

const language = vi.hoisted(() => ({ locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useActionData: () => null,
  useNavigation: () => ({ state: 'idle' }),
  Form: ({ children }: { children: import('react').ReactNode }) => (
    <form>{children}</form>
  ),
}))
import CliSessionsPage, { action } from './cli-sessions'

test.each([
  [
    'en',
    'Access',
    'Full access',
    'Agent (one project)',
    'Create files and update its own',
  ],
  [
    'ja',
    '権限',
    'すべての操作',
    'エージェント(1つのプロジェクト)',
    'ファイルの作成と、作ったファイルの更新',
  ],
] as const)(
  'shows translated access labels in %s, including legacy families',
  (locale, label, unrestricted, agent, publisher) => {
    language.locale = locale
    const html = renderToStaticMarkup(
      <CliSessionsPage
        {...({
          params: {},
          matches: [] as never,
          loaderData: {
            cliFamilies: (
              [undefined, 'unrestricted', 'agent', 'publisher'] as const
            ).map((preset, index) => ({
              familyId: `family-${index}`,
              preset,
              deviceName: null,
              publisherClientName:
                preset === 'publisher' ? 'Employee dashboard' : null,
              createdAt: '2026-01-01T00:00:00.000Z',
              lastUsedAt: null,
              expiresAt: '2099-01-01T00:00:00.000Z',
            })),
          },
        } as Parameters<typeof CliSessionsPage>[0])}
      />,
    )
    for (const access of [unrestricted, agent, publisher])
      expect(html).toContain(`${label}: ${access}`)
    expect(html).toContain('Employee dashboard')
    expect(html).not.toContain(`${label}: unrestricted`)
  },
)

function request(values: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return new Request('https://example.test/settings/cli-sessions', {
    method: 'POST',
    body: form,
  })
}

describe('/settings/cli-sessions actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('revokes one family for the current user', async () => {
    services.revokeCliRefreshCredentialFamily.mockResolvedValue('ok')
    await action({
      request: request({ intent: 'revoke-cli-family', familyId: 'family-a' }),
      context: new Map(),
    } as never)

    expect(services.revokeCliRefreshCredentialFamily).toHaveBeenCalledWith(
      {},
      'current-user',
      'family-a',
    )
  })

  test('does not dispatch a family revoke without a family id', async () => {
    await action({
      request: request({ intent: 'revoke-cli-family' }),
      context: new Map(),
    } as never)

    expect(services.revokeCliRefreshCredentialFamily).not.toHaveBeenCalled()
  })

  test('revokes all families for the current user', async () => {
    await action({
      request: request({ intent: 'revoke-all-cli-families' }),
      context: new Map(),
    } as never)

    expect(services.revokeAllCliRefreshCredentialFamilies).toHaveBeenCalledWith(
      {},
      'current-user',
    )
  })
})
