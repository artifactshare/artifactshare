import { Window } from 'happy-dom'
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
const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
import ExternalAccessPage, { action } from './external-access'

beforeEach(() => {
  vi.clearAllMocks()
  language.locale = 'en'
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
  expect(result.init?.status).toBe(200)
  expect(result.data).toEqual({
    ok: true,
    intent: 'preview-external-access',
    code: 'preview',
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
    expect(result.init?.status).toBe(kind === 'invalid-policy' ? 400 : 403)
    expect(result.data).toMatchObject({
      ok: false,
      code: kind,
      intent: 'update-external-access',
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
  expect(result.data).toMatchObject({ ok: false, code: 'invalid-policy' })
  expect(services.previewWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
})

test('successful save returns the authoritative shortened count', async () => {
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
  expect(result).toMatchObject({
    data: {
      ok: true,
      code: 'ok',
      intent: 'update-external-access',
      shortenedLinkCount: 3,
    },
    init: { status: 200 },
  })
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
  expect((await submit()).data).toMatchObject({
    code: 'preview',
    previousMaximumDays: 180,
    shortenedLinkCount: 2,
    draft: { defaultDays: '30', maxDays: '120' },
  })
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  form.set('confirmedPreviousMaximum', '90')
  form.set('confirmedMaximum', '120')
  expect((await submit()).data).toMatchObject({ code: 'preview' })
  expect(services.updateWorkspaceExternalAccessPolicy).not.toHaveBeenCalled()
  form.set('confirmedPreviousMaximum', '180')
  expect((await submit()).data).toMatchObject({ ok: true, code: 'ok' })
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
                  code: 'forbidden',
                  ok: false,
                  intent: 'update-external-access',
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

test.each([
  ['en', 0, null],
  [
    'en',
    1,
    '1 existing link was shortened to match the new maximum expiration.',
  ],
  [
    'en',
    2,
    '2 existing links were shortened to match the new maximum expiration.',
  ],
  [
    'ja',
    1,
    '既存リンク 1 件の有効期限を、新しい最長期限に合わせて短縮しました。',
  ],
  [
    'ja',
    2,
    '既存リンク 2 件の有効期限を、新しい最長期限に合わせて短縮しました。',
  ],
] as const)(
  'shortened notice in %s for %s links',
  (locale, count, expected) => {
    language.locale = locale
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <Outlet
              context={{ currentUserRole: 'owner', currentUserIsAdmin: true }}
            />
          ),
          children: [
            {
              id: 'external-access',
              index: true,
              element: (
                <ExternalAccessPage
                  loaderData={{
                    policy: {
                      plan: 'team',
                      linkSharingEnabled: true,
                      externalPostingEnabled: true,
                      linkExpiryDefaultDays: 30,
                      linkExpiryMaxDays: 30,
                    },
                  }}
                />
              ),
            },
          ],
        },
      ],
      {
        initialEntries: ['/'],
        hydrationData: {
          actionData: {
            'external-access': {
              ok: true,
              code: 'ok',
              intent: 'update-external-access',
              shortenedLinkCount: count,
            },
          },
        },
      },
    )
    try {
      const html = renderToStaticMarkup(<RouterProvider router={router} />)
      if (expected === null) {
        expect(html).not.toContain('data-shortened-links')
      } else {
        expect(html).toContain(expected)
      }
    } finally {
      router.dispose()
    }
  },
)

test.each(['en', 'ja'] as const)(
  'expiry and paused sharing explain plan-specific permissions in %s',
  (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    const resumeGuidance =
      locale === 'en'
        ? {
            link: 'Only the workspace owner can resume link sharing.',
            posting: 'Only the workspace owner can resume external posting.',
            both: 'Only the workspace owner can resume link sharing and external posting.',
          }
        : {
            link: 'リンク共有を再開できるのは、ワークスペースのオーナーだけです。',
            posting:
              '外部からの投稿を再開できるのは、ワークスペースのオーナーだけです。',
            both: 'リンク共有と外部からの投稿を再開できるのは、ワークスペースのオーナーだけです。',
          }
    for (const [plan, linkSharingEnabled, linkExpiryMaxDays] of [
      ['free', false, 90],
      ['plus', false, 90],
      ['plus', true, null],
      ['team', false, 90],
    ] as const) {
      for (const role of ['member', 'admin', 'owner'] as const) {
        const restricted =
          plan === 'team' ? role === 'member' : role !== 'owner'
        const router = createMemoryRouter([
          {
            element: (
              <Outlet
                context={{
                  currentUserRole: role,
                  currentUserIsAdmin: role !== 'member',
                }}
              />
            ),
            children: [
              {
                path: '/',
                element: (
                  <ExternalAccessPage
                    loaderData={{
                      policy: {
                        plan,
                        linkSharingEnabled,
                        externalPostingEnabled: false,
                        linkExpiryDefaultDays: 14,
                        linkExpiryMaxDays,
                      },
                    }}
                  />
                ),
              },
            ],
          },
        ])
        const doc = new Window().document
        doc.body.innerHTML = renderToStaticMarkup(
          <RouterProvider router={router} />,
        )
        router.dispose()
        const expiry = doc.querySelector('[name="defaultDays"]')!
        const section = expiry.closest('section:has(h2)')!
        expect(
          section.textContent.includes(
            t(
              plan === 'team'
                ? 'externalAccess.expiry.managerOnly'
                : 'externalAccess.expiry.ownerOnly',
            ),
          ),
        ).toBe(restricted)
        const guidance = section.querySelector('#expiry-guidance')
        for (const name of ['defaultDays', 'maxDays']) {
          const input = section.querySelector(`input[name="${name}"]`)!
          expect(input.hasAttribute('disabled')).toBe(
            restricted || (name === 'maxDays' && linkExpiryMaxDays === null),
          )
          const ids = input.getAttribute('aria-describedby')!.split(' ')
          expect(doc.getElementById(ids[0])?.textContent).toBe(
            t('externalAccess.expiry.days'),
          )
          expect(ids.slice(1)).toEqual(restricted ? [guidance!.id] : [])
        }
        const unlimitedControls =
          linkExpiryMaxDays === null
            ? ['defaultUnlimited', 'maxUnlimited']
            : ['maxUnlimited']
        for (const name of unlimitedControls) {
          const checkbox = section.querySelector(
            `[data-policy-control="${name}"]`,
          )!
          expect(checkbox.hasAttribute('disabled')).toBe(restricted)
          expect(checkbox.getAttribute('aria-describedby')).toBe(
            restricted ? guidance!.id : null,
          )
        }
        expect(doc.querySelector('#save-external-access') !== null).toBe(
          !restricted,
        )
        const policy = doc.querySelector('section')!
        const expectedGuidance =
          plan === 'free'
            ? resumeGuidance.link
            : linkSharingEnabled
              ? resumeGuidance.posting
              : resumeGuidance.both
        const paragraphs = [...policy.querySelectorAll('p')].map(
          (p) => p.textContent,
        )
        expect(
          Object.values(resumeGuidance).filter((note) =>
            paragraphs.includes(note),
          ),
        ).toEqual(plan !== 'team' && restricted ? [expectedGuidance] : [])
        expect(policy.querySelector('#resume-linkSharing') !== null).toBe(
          plan !== 'team' && !restricted && !linkSharingEnabled,
        )
        expect(policy.querySelector('#resume-externalPosting') !== null).toBe(
          plan === 'plus' && !restricted,
        )
        if (plan === 'team')
          expect(
            policy.textContent.includes(t('externalAccess.readOnly')),
          ).toBe(restricted)
        if (plan === 'free')
          expect(policy.textContent).toContain(
            t('externalAccess.externalPosting.comparePlans'),
          )
      }
    }
  },
)
