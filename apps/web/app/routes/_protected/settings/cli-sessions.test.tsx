import { createMemoryRouter, RouterProvider } from 'react-router'
import { RouterContextProvider } from 'react-router'
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
import { CliSessionsSection } from './+components/cli-sessions-section'
import { action } from './_content/tokens'
test.each([
  [
    'en',
    'Access',
    'Full access',
    'Agent (one project)',
    'Manage and download created or assigned files and sites',
  ],
  [
    'ja',
    '権限',
    'すべての操作',
    'エージェント(1つのプロジェクト)',
    '作成・割り当て済みのファイルとサイトの管理・ダウンロード',
  ],
] as const)(
  'shows translated access labels in %s, including legacy families',
  (locale, label, unrestricted, agent, publisher) => {
    language.locale = locale
    const router = createMemoryRouter([
      {
        path: '/',
        element: (
          <CliSessionsSection
            cliFamilies={(
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
            }))}
          />
        ),
      },
    ])
    const html = renderToStaticMarkup(<RouterProvider router={router} />)
    router.dispose()
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
    const result = await action({
      request: request({ intent: 'revoke-cli-family', familyId: 'family-a' }),
      context: new RouterContextProvider(),
      url: new URL('https://example.test/settings/tokens'),
      params: {},
      pattern: '/settings/tokens',
    })

    expect(result).toEqual({ kind: 'revoked', intent: 'revoke-cli-family' })
    expect(services.revokeCliRefreshCredentialFamily).toHaveBeenCalledWith(
      {},
      'current-user',
      'family-a',
    )
  })

  test('does not dispatch a family revoke without a family id', async () => {
    const result = await action({
      request: request({ intent: 'revoke-cli-family' }),
      context: new RouterContextProvider(),
      url: new URL('https://example.test/settings/tokens'),
      params: {},
      pattern: '/settings/tokens',
    })

    expect(result).toEqual({
      kind: 'revoke-failed',
      intent: 'revoke-cli-family',
    })
    expect(services.revokeCliRefreshCredentialFamily).not.toHaveBeenCalled()
  })

  test('revokes all families for the current user', async () => {
    const result = await action({
      request: request({ intent: 'revoke-all-cli-families' }),
      context: new RouterContextProvider(),
      url: new URL('https://example.test/settings/tokens'),
      params: {},
      pattern: '/settings/tokens',
    })

    expect(result).toEqual({
      kind: 'revoked',
      intent: 'revoke-all-cli-families',
    })
    expect(services.revokeAllCliRefreshCredentialFamilies).toHaveBeenCalledWith(
      {},
      'current-user',
    )
  })
  test.each(['revoke-cli-family', 'revoke-all-cli-families'] as const)(
    'failed %s produces retryable data',
    async (intent) => {
      const service =
        intent === 'revoke-cli-family'
          ? services.revokeCliRefreshCredentialFamily
          : services.revokeAllCliRefreshCredentialFamilies
      service.mockRejectedValueOnce(new Error('unavailable'))
      const req = request({ intent, familyId: 'family-a' })
      expect(
        await action({
          request: req,
          context: new RouterContextProvider(),
          url: new URL(req.url),
          params: {},
          pattern: '/settings/tokens',
        }),
      ).toEqual({ kind: 'revoke-failed', intent })
    },
  )
})

test('old CLI sessions URL redirects after authentication', async () => {
  const { loader } = await import('./cli-sessions')
  const response = loader({
    context: new RouterContextProvider(),
    params: {},
    pattern: '/settings/cli-sessions',
    url: new URL('https://example.test/settings/cli-sessions'),
    request: new Request('https://example.test/settings/cli-sessions'),
  })
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toBe('/settings/tokens')
})
