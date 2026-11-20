import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
} from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'

const services = vi.hoisted(() => ({
  previewWorkspaceExternalAccessPolicy: vi.fn(),
  updateWorkspaceExternalAccessPolicy: vi.fn(),
  loadWorkspaceLinkPolicy: vi.fn(),
}))
vi.mock('~/services/link-sharing.server', () => services)
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', workspaceId: 'workspace' }),
}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
import ExternalAccessPage, { action } from './external-access'

beforeEach(() => {
  vi.clearAllMocks()
  services.previewWorkspaceExternalAccessPolicy.mockResolvedValue({
    kind: 'preview',
    previousMaximumDays: 30,
    maximumDays: 30,
    shortenedLinkCount: 0,
  })
})

test('preview parses the complete draft and resume without invoking a mutation', async () => {
  services.previewWorkspaceExternalAccessPolicy.mockResolvedValue({
    kind: 'preview',
    maximumDays: 30,
    shortenedLinkCount: 2,
  })
  const form = new URLSearchParams({
    intent: 'preview-external-access',
    defaultDays: '7',
    maxDays: '30',
    linkSharingEnabled: 'false',
    externalPostingEnabled: 'false',
    resume: 'linkSharing',
  })
  const result = await action({
    request: new Request('https://example.test/settings/external-access', {
      method: 'POST',
      body: form,
    }),
    context: new RouterContextProvider(),
    params: {},
    url: new URL('https://example.test/settings/external-access'),
    pattern: '/settings/external-access',
  })
  expect(result).toEqual({
    kind: 'preview',
    maximumDays: 30,
    shortenedLinkCount: 2,
    draft: {
      defaultDays: '7',
      maxDays: '30',
      defaultUnlimited: false,
      maxUnlimited: false,
      linkSharingEnabled: false,
      externalPostingEnabled: false,
    },
    resume: 'linkSharing',
  })
  expect(services.previewWorkspaceExternalAccessPolicy).toHaveBeenCalledWith(
    {},
    { id: 'owner', workspaceId: 'workspace' },
    {
      linkExpiryDefaultDays: 7,
      linkExpiryMaxDays: 30,
      linkSharingEnabled: true,
      externalPostingEnabled: false,
    },
  )
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
})

test.each(['forbidden', 'plan-required', 'invalid-policy'])(
  'failed save %s is inline so the draft survives',
  async (kind) => {
    services.updateWorkspaceExternalAccessPolicy.mockResolvedValue({ kind })
    const result = await action({
      request: new Request('https://example.test/settings/external-access', {
        method: 'POST',
        body: new URLSearchParams({
          intent: 'update-external-access',
          defaultDays: '7',
          maxDays: '30',
        }),
      }),
      context: new RouterContextProvider(),
      params: {},
      url: new URL('https://example.test/settings/external-access'),
      pattern: '/settings/external-access',
    })
    expect(result).toMatchObject({
      kind,
      draft: { defaultDays: '7', maxDays: '30' },
    })
  },
)

test('invalid preview input never invokes preview or mutation', async () => {
  const result = await action({
    request: new Request('https://example.test/settings/external-access', {
      method: 'POST',
      body: new URLSearchParams({
        intent: 'preview-external-access',
        defaultDays: '7',
        maxDays: 'abc',
      }),
    }),
    context: new RouterContextProvider(),
    params: {},
    url: new URL('https://example.test/settings/external-access'),
    pattern: '/settings/external-access',
  })
  expect(result).toMatchObject({ kind: 'invalid-policy' })
  expect(services.previewWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
})

test('successful save preserves the authoritative shortened count in the redirect', async () => {
  services.updateWorkspaceExternalAccessPolicy.mockResolvedValue({
    kind: 'ok',
    shortenedLinkCount: 3,
  })
  const result = await action({
    request: new Request('https://example.test/settings/external-access', {
      method: 'POST',
      body: new URLSearchParams({
        intent: 'update-external-access',
        defaultDays: '7',
        maxDays: '30',
      }),
    }),
    context: new RouterContextProvider(),
    params: {},
    url: new URL('https://example.test/settings/external-access'),
    pattern: '/settings/external-access',
  })
  expect(result).toBeInstanceOf(Response)
  if (!(result instanceof Response)) throw new Error('Expected redirect')
  expect(result.headers.get('Location')).toBe(
    '/settings/external-access?status=ok&shortened=3',
  )
})

test('Free owners have a billing link and explicit page-wide save instructions', () => {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Outlet
          context={{ currentUserRole: 'owner', currentUserIsAdmin: true }}
        />
      ),
      children: [
        {
          index: true,
          element: (
            <ExternalAccessPage
              loaderData={{
                policy: {
                  plan: 'free',
                  linkSharingEnabled: true,
                  externalPostingEnabled: false,
                  linkExpiryDefaultDays: 30,
                  linkExpiryMaxDays: null,
                },
              }}
            />
          ),
        },
      ],
    },
  ])
  const html = renderToStaticMarkup(<RouterProvider router={router} />)
  expect(html).toContain('href="/settings/billing"')
  expect(html).toContain(
    'External posting is available on Plus and Team. View Plan and billing.',
  )
  expect(html).toContain('All changes on this page require Save changes.')
  expect(html).not.toContain('Unsaved changes')
  router.dispose()
})

test('stale-page extension requires the current reduction preview before any mutation', async () => {
  services.previewWorkspaceExternalAccessPolicy.mockResolvedValue({
    kind: 'preview',
    previousMaximumDays: 180,
    maximumDays: 120,
    shortenedLinkCount: 2,
  })
  services.updateWorkspaceExternalAccessPolicy.mockResolvedValue({
    kind: 'ok',
    shortenedLinkCount: 2,
  })
  const form = new URLSearchParams({
    intent: 'update-external-access',
    defaultDays: '30',
    maxDays: '120',
  })
  const submit = () =>
    action({
      request: new Request('https://example.test/settings/external-access', {
        method: 'POST',
        body: form,
      }),
      context: new RouterContextProvider(),
      params: {},
      url: new URL('https://example.test/settings/external-access'),
      pattern: '/settings/external-access',
    })
  expect(await submit()).toMatchObject({
    kind: 'preview',
    previousMaximumDays: 180,
    shortenedLinkCount: 2,
    draft: { defaultDays: '30', maxDays: '120' },
  })
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  form.set('confirmedPreviousMaximum', '90')
  form.set('confirmedMaximum', '120')
  expect(await submit()).toMatchObject({ kind: 'preview' })
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  form.set('confirmedPreviousMaximum', '180')
  expect(await submit()).toBeInstanceOf(Response)
  expect(services.updateWorkspaceExternalAccessPolicy).toHaveBeenCalledTimes(1)
})

test.each([false, true])(
  'native action failure presentation (%s) retains the submitted draft',
  (failed) => {
    const policy = {
      plan: 'team' as const,
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 90,
    }
    const router = createMemoryRouter(
      [
        {
          element: (
            <Outlet
              context={{ currentUserRole: 'owner', currentUserIsAdmin: true }}
            />
          ),
          children: [
            {
              id: 'settings',
              path: '/',
              element: <ExternalAccessPage loaderData={{ policy }} />,
            },
          ],
        },
      ],
      {
        hydrationData: {
          actionData: failed
            ? {
                settings: {
                  kind: 'forbidden',
                  draft: {
                    defaultDays: '7',
                    maxDays: '90',
                    defaultUnlimited: false,
                    maxUnlimited: false,
                    linkSharingEnabled: false,
                  },
                },
              }
            : null,
        },
      },
    )
    try {
      const html = renderToStaticMarkup(<RouterProvider router={router} />)
      if (failed) {
        expect(html).toContain('role="alert"')
        expect(html).toContain('value="7"')
        expect(html).toContain('Unsaved changes')
      } else {
        expect(html).not.toContain('role="alert"')
        expect(html).not.toContain('Unsaved changes')
      }
    } finally {
      router.dispose()
    }
  },
)
