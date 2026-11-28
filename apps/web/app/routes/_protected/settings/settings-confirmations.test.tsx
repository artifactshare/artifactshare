// @vitest-environment happy-dom
import { settingsSingleFetch } from '~/test/settings-single-fetch'
import { sessionMiddleware } from '~/middleware/auth'
// Exercise the router's actual Single Fetch encoder, client decoder and
// fetcher lifecycle. Only the service implementations and network are local.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  data,
  Outlet,
  redirect,
  RouterProvider,
  useRouteError,
  type ActionFunction,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import * as dom from '~/test/dom-actions'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import * as members from './_content/index'
import * as bots from './_content/bots'
import * as tokens from './_content/tokens'
import * as billing from './_content/billing'
import * as integrations from './_content/integrations'
import * as external from './_content/external-access'
import { ErrorBoundary } from './_content/_layout'
import { SettingsOutlet } from './+components/settings-outlet'
import { settingsAdminGate } from './+lib/settings-admin.server'
import type { SettingsLoaderData } from './_layout'

const { mutate, requireUser, getSessionUser } = vi.hoisted(() => ({
  getSessionUser: vi.fn(() => null),
  mutate: vi.fn(),
  requireUser: vi.fn(() => ({ id: 'owner', workspaceId: 'workspace' })),
}))
vi.mock('~/services/auth.server', () => ({
  getSessionUser,
  readBearerSessionToken: () => null,
}))
vi.mock('~/middleware/context', async (original) => ({
  ...(await original<typeof import('~/middleware/context')>()),
  requireUser,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirstOrThrow: () => ({}) }),
      }),
    }),
  }),
}))
vi.mock('~/services/team-management.server', () => ({
  transferWorkspaceOwner: mutate,
  grantWorkspaceAdmin: mutate,
  revokeWorkspaceAdmin: mutate,
  revokeWorkspaceMemberCliSessions: mutate,
  removeWorkspaceMember: mutate,
  restoreWorkspaceMember: mutate,
  transferRemovedMemberAssets: mutate,
  requireWorkspaceOwner: () => ({ kind: 'ok' }),
}))
vi.mock('~/services/bot-members.server', () => ({
  cancelWorkspaceBot: mutate,
  stopWorkspaceBot: mutate,
  reissueWorkspaceBotCredential: mutate,
}))
vi.mock('~/services/bot-destinations.server', () => ({}))
vi.mock('~/lib/feature-flags.server', () => ({}))
vi.mock('~/services/api-tokens.server', () => ({ revokeApiToken: mutate }))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  revokeAllCliRefreshCredentialFamilies: mutate,
  revokeCliRefreshCredentialFamily: mutate,
}))
vi.mock('~/services/billing.server', () => ({
  isBillingConfigured: () => true,
  createStripeClient: () => ({}),
  changePlan: mutate,
}))
vi.mock('cloudflare:workers', () => ({
  env: { STRIPE_SECRET_KEY: 'local-test-only' },
}))
vi.mock('~/services/billing-usage.server', () => ({}))
vi.mock('~/services/slack.server', () => ({
  deleteWorkspaceSlackConnection: mutate,
}))
vi.mock('~/services/link-sharing.server', () => ({
  updateWorkspaceExternalAccessPolicy: mutate,
  previewWorkspaceExternalAccessPolicy: () => ({
    kind: 'preview',
    previousMaximumDays: 90,
    maximumDays: 30,
    shortenedLinkCount: 1,
  }),
}))

const user = {
  id: 'owner',
  email: 'owner@example.test',
  name: 'Owner',
  image: null,
}
const shell: SettingsLoaderData = {
  kind: 'team',
  user: { ...user, initial: 'O' },
  currentUserIsAdmin: true,
  currentUserRole: 'owner',
  workspace: {
    id: 'workspace',
    name: 'Example workspace',
    hd: null,
    plan: 'team',
    storageUsedBytes: 0,
    storageQuotaBytes: 100000,
  },
}
const target = {
  ...user,
  id: 'target',
  name: 'Casey',
  email: 'casey@example.test',
}
const policy = {
  plan: 'team' as const,
  linkSharingEnabled: true,
  externalPostingEnabled: true,
  linkExpiryMaxDays: 90,
  linkExpiryDefaultDays: 7,
}
const operations = [
  ['transfer-owner', 'members', 'Transfer ownership', { userId: 'target' }],
  ['grant-admin', 'members', 'Make admin', { userId: 'target' }],
  ['revoke-admin', 'members', 'Remove admin', { userId: 'target' }],
  [
    'revoke-cli-sessions',
    'members',
    'Revoke CLI sessions',
    { userId: 'target' },
  ],
  [
    'remove-member',
    'members',
    'Remove',
    { userId: 'target', recipientUserId: 'owner' },
  ],
  [
    'transfer-removed-assets',
    'members',
    '',
    { userId: 'removed', recipientUserId: 'owner' },
  ],
  ['restore-member', 'members', '', { userId: 'removed' }],
  ['change-plan', 'billing', '', { plan: 'plus', interval: 'monthly' }],
  ['revoke', 'tokens', '', { tokenId: 'target' }],
  ['revoke-cli-family', 'tokens', '', { familyId: 'target' }],
  ['revoke-all-cli-families', 'tokens', '', {}],
  ['disconnect-slack', 'integrations', '', { connectionId: 'target' }],
  [
    'update-external-access',
    'external',
    '',
    {
      confirmedMaximum: '30',
      confirmedPreviousMaximum: '90',
      maxDays: '30',
      defaultDays: '7',
      linkSharingEnabled: 'true',
      externalPostingEnabled: 'true',
    },
  ],
  ['stop', 'bots', '', { botUserId: 'target' }],
  ['cancel', 'bots', '', { botUserId: 'target' }],
  ['reissue', 'bots', '', { botUserId: 'target' }],
] as const

const pages = {
  members,
  tokens,
  billing,
  bots,
  external,
  integrations,
}
const paths = {
  members: '/settings',
  tokens: '/settings/tokens',
  billing: '/settings/billing',
  bots: '/settings/bots',
  external: '/settings/external-access',
  integrations: '/settings/integrations',
} as const

function screenFor(type: keyof typeof pages, intent: string) {
  switch (type) {
    case 'members':
      return (
        <members.default
          loaderData={{
            filters: { query: '', role: 'all', activity: 'all', page: 1 },
            membersPage: {
              page: 1,
              total: 1,
              members: [
                {
                  ...target,
                  role: intent === 'revoke-admin' ? 'admin' : 'member',
                  isAdmin: intent === 'revoke-admin',
                  firstContributedAt: null,
                  lastContributedAt: null,
                  pendingUploads: 0,
                },
              ],
            },
            removedMembers: [
              { ...target, id: 'removed', ownedArtifactCount: 1 },
            ],
          }}
        />
      )
    case 'tokens':
      return (
        <tokens.default
          loaderData={{
            tokens: [
              {
                id: 'target',
                name: 'Reports',
                createdAt: '2026-01-01',
                lastUsedAt: null,
              },
            ],
            cliFamilies: [
              {
                familyId: 'target',
                deviceName: 'Reports',
                publisherClientName: null,
                preset: 'unrestricted',
                createdAt: '2026-01-01',
                lastUsedAt: null,
              },
            ],
            createdToken: null,
          }}
        />
      )
    case 'external':
      return <external.default loaderData={{ policy }} />
    case 'integrations':
      return (
        <integrations.default
          loaderData={{
            connections: [
              {
                id: 'target',
                installedAt: '2026-01-01',
                teamName: 'Reports',
                installedByName: 'Owner',
                needsReauthorization: false,
              },
            ],
          }}
        />
      )
    case 'billing':
      return (
        <billing.default
          loaderData={{
            canManage: true,
            billingConfigured: true,
            hasSubscription: true,
            stripeSubscriptionStatus: 'active',
            defaultCurrency: 'usd',
            initialPlan: 'team',
            initialInterval: 'monthly',
            activeProjectCount: 1,
            projectLimit: null,
            entryContext: 'default',
            externalPostingEnabled: true,
            contract: {
              plan: 'team',
              interval: 'monthly',
              currency: 'usd',
              amount: 20,
              renewsAt: null,
              cancelAtPeriodEnd: false,
            },
            monthlyEstimate: null,
            showOverageProjection: false,
            includedBytes: 100000,
            overageProjection: null,
            contributorCount: 1,
          }}
        />
      )
    case 'bots':
      return (
        <bots.default
          loaderData={{
            botCreationEnabled: false,
            bots: [
              {
                ...target,
                botStoppedAt: null,
                projectId: 'project',
                projectName: 'Reports',
                projectNameSnapshot: 'Reports',
                credentialLive: true,
                lastAuthAt: null,
                cancelable: intent === 'cancel',
              },
            ],
          }}
        />
      )
  }
}

// One status stands for each class the submission has to tell apart: a
// gateway status the request can be retried after, and a platform error page
// in front of the app, which is an unexpected server error. Every status is
// held to its class in lib/settings-confirmation.test.ts.
const faults = [
  'app-data',
  'offline',
  'broken',
  503,
  500,
  'redirect',
  'server-error',
  'server-type-error',
  'middleware-type-error',
  'production-error',
  'route-error',
] as const

const retryable = new Set<Fault>(['app-data', 'offline', 'broken', 503])
// Cross the browser boundary for native dialog locking, retry, handoff and
// routing. Every row uses the same real server and client route functions.
type Operation = (typeof operations)[number]

// Revoking CLI sessions has no expected failure the action returns: the
// services report ok or nothing to revoke. Those rows keep every transport
// and server fault but have no returned-failure case.
const noReturnedFailure = new Set<string>([
  'revoke-cli-family',
  'revoke-all-cli-families',
])

// Every fault above is handled by the confirmation machinery all operations
// share. What belongs to one operation is the body it posts, the failure its
// own action returns, and the notice it leaves behind after a retry, so every
// operation runs those three.
const operationFaults: readonly Fault[] = ['app-data', 'offline', 500]

// One operation per Settings page runs the whole list: each page renders its
// own result, returns focus to its own trigger, and reports its own failures.
const everyFault = new Set<string>([
  'transfer-owner',
  'revoke-all-cli-families',
  'change-plan',
  'cancel',
  'update-external-access',
  'disconnect-slack',
])
const faultsFor = (operation: Operation): Fault[] => {
  const chosen = everyFault.has(operation[0]) ? faults : operationFaults
  return chosen.filter(
    (fault) => fault !== 'app-data' || !noReturnedFailure.has(operation[0]),
  )
}
type Fault = (typeof faults)[number]

async function mount(
  operation: Operation,
  fault: Fault | 'none',
  initialEntries?: string[],
) {
  const [intent, type] = operation
  const path = paths[type]
  const route = pages[type]
  const gates: Array<() => void> = []
  const posts: unknown[] = []
  const submit: ActionFunction = async (args) => {
    const common = { ...args, params: {} }
    switch (type) {
      case 'members':
        return members.action({ ...common, pattern: '/settings' })
      case 'billing':
        return billing.action({ ...common, pattern: '/settings/billing' })
      case 'tokens':
        return tokens.action({ ...common, pattern: '/settings/tokens' })
      case 'bots':
        // The admin gate already let this owner through.
        common.context.set(settingsAdminGate, 'allowed')
        return bots.action({ ...common, pattern: '/settings/bots' })
      case 'external':
        return external.action({
          ...common,
          pattern: '/settings/external-access',
        })
      case 'integrations':
        return integrations.action({
          ...common,
          pattern: '/settings/integrations',
        })
    }
  }
  mutate.mockImplementation(() => {
    if (posts.length === 1) {
      if (fault === 'app-data') {
        if (intent === 'revoke') return false
        if (type === 'tokens') return 'ok'
        return { kind: 'forbidden' }
      }
      if (fault === 'server-type-error') throw new TypeError('service fault')
      if (fault === 'production-error' || fault === 'server-error')
        throw new Error('service fault')
      if (fault === 'route-error')
        throw new Response('missing', { status: 404 })
      if (fault === 'redirect') throw redirect('/done')
    }
    if (intent === 'revoke') return true
    if (type === 'tokens') return 'ok'
    if (type === 'billing') return { kind: 'accepted' }
    if (type === 'external')
      return {
        kind: 'ok',
        policy: { ...policy, linkExpiryMaxDays: 30 },
        shortenedLinkCount: 1,
      }
    return intent === 'reissue'
      ? { kind: 'ok', token: 'as_test_reissued' }
      : { kind: 'ok' }
  })
  let router: ReturnType<typeof createMemoryRouter>
  const { routes, dataStrategy } = settingsSingleFetch({
    path,
    Component: () => screenFor(type, intent),
    Boundary: () => <ErrorBoundary error={useRouteError()} />,
    clientAction: route.clientAction,
    action: submit,
    mode: fault === 'production-error' ? 'production' : 'development',
    middleware:
      fault === 'middleware-type-error' ? [sessionMiddleware] : undefined,
    getRouter: () => router,
    fetchResponse: async (request, handler) => {
      const body = request.headers
        .get('content-type')
        ?.includes('application/json')
        ? await request.clone().json()
        : Object.fromEntries(await request.clone().formData())
      if (
        body &&
        typeof body === 'object' &&
        'intent' in body &&
        body.intent === 'preview-external-access'
      )
        return handler(request)
      posts.push(body)
      await new Promise<void>((resolve) => gates.push(resolve))
      if (posts.length === 1) {
        if (fault === 'offline') throw new TypeError('Failed to fetch')
        if (fault === 'broken') return new Response('incomplete stream')
        if (typeof fault === 'number')
          return new Response('<html>Gateway</html>', {
            status: fault,
            headers: { 'Content-Type': 'text/html' },
          })
      }
      return handler(request)
    },
  })
  const reload = vi.fn(() => null)
  routes[0].loader = reload
  router = createMemoryRouter(
    [
      {
        element: (
          <TooltipProvider>
            <SettingsOutlet shell={shell} />
          </TooltipProvider>
        ),
        children: [
          ...routes,
          {
            path: '/settings/recipients',
            loader: () => ({
              query: '',
              recipients: [
                { id: 'other', name: 'Robin', email: 'robin@example.test' },
              ],
              total: 1,
            }),
          },
          { path: '/settings/billing-preview', loader: () => null },
          { path: '/done', element: <p>Finished</p> },
        ],
      },
    ],
    {
      initialEntries: initialEntries ?? [path],
      initialIndex: (initialEntries?.length ?? 1) - 1,
      dataStrategy,
    },
  )
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => root.render(<RouterProvider router={router} />))
  return { gates, posts, reload, router, container, root }
}

async function openConfirmation(
  [intent, type, label]: Operation,
  container: HTMLElement,
) {
  if (label) {
    await dom.press(
      await dom.find(() =>
        dom.byRole(container, 'button', 'Member actions menu'),
      ),
    )
    await dom.press(
      await dom.find(() => dom.byRole(document.body, 'menuitem', label)),
    )
  } else if (type === 'external') {
    await dom.fill(
      await dom.find(() =>
        dom.byRole(container, 'spinbutton', 'Maximum expiration'),
      ),
      '30',
    )
    await dom.press(
      await dom.find(() => dom.byRole(container, 'button', 'Save changes')),
    )
  } else {
    const triggers: Record<string, string> = {
      'transfer-removed-assets': '#transfer-removed-assets-removed',
      'restore-member': '#restore-member-removed',
      'change-plan': '[data-billing-change="plan"]',
      revoke: '#revoke-target',
      'revoke-cli-family': '#revoke-family-target',
      'revoke-all-cli-families': '[id^="revoke-all-"]',
      'disconnect-slack': '#disconnect-target',
      stop: '#bot-stop-target',
      cancel: '#bot-cancel-target',
      reissue: '#bot-reissue-target',
    }
    const trigger = await vi.waitFor(() => {
      const button = Array.from(
        container.querySelectorAll<HTMLButtonElement>(triggers[intent]),
      ).find((candidate) => dom.shown(candidate))
      if (!button) throw new Error('Missing visible trigger for ' + intent)
      return button
    })
    await dom.press(trigger)
  }
}

async function unmount({
  gates,
  root,
  container,
  router,
}: Awaited<ReturnType<typeof mount>>) {
  for (const gate of gates) gate()
  await act(async () => root.unmount())
  container.remove()
  router.dispose()
}

for (const operation of operations)
  test.each(faultsFor(operation))(
    operation[0] + ' handles %s',
    async (fault) => {
      const [intent, type, label, fields] = operation
      const mounted = await mount(operation, fault)
      const { gates, posts, reload, container } = mounted
      try {
        await openConfirmation(operation, container)
        const expectedBody = { intent, ...fields }
        const dialogEl = () =>
          document.querySelector<HTMLElement>('[role="alertdialog"]')
        const confirm = () => {
          const b = dialogEl()?.querySelectorAll('button')
          return b?.[b.length - 1] ?? null
        }
        const firstButton = () => dialogEl()?.querySelector('button') ?? null
        const alert = () => dialogEl()?.querySelector('[role="alert"]') ?? null
        const returnTrigger = label
          ? container.querySelector('[aria-haspopup="menu"]')
          : type === 'billing'
            ? container.querySelector('[data-billing-change="plan"]')
            : null
        if (intent === 'transfer-owner')
          await vi.waitFor(() =>
            expect(dialogEl()?.textContent).toContain(
              bindI18n('en').t('team.members.transferOwnerConfirm.body'),
            ),
          )
        if (
          fault === 'server-type-error' &&
          (intent === 'cancel' ||
            intent === 'disconnect-slack' ||
            intent === 'revoke-all-cli-families')
        )
          requireUser.mockImplementationOnce(() => {
            throw new TypeError('session lookup failed')
          })
        await vi.waitFor(() => expect(confirm()?.disabled).toBe(false))
        if (fault === 'middleware-type-error')
          getSessionUser.mockImplementationOnce(() => {
            throw new TypeError('session lookup failed')
          })
        await dom.press(confirm()!)
        await vi.waitFor(() => expect(gates).toHaveLength(1))
        expect(posts[0]).toEqual(expectedBody)
        await vi.waitFor(() => expect(confirm()?.disabled).toBe(true))
        await vi.waitFor(() => expect(firstButton()?.disabled).toBe(true))
        await dom.escape()
        expect(dialogEl()).not.toBeNull()
        const loads = reload.mock.calls.length
        await act(async () => gates[0]())
        if (fault === 'redirect') {
          await vi.waitFor(() =>
            expect(container.textContent).toContain('Finished'),
          )
        } else if (retryable.has(fault)) {
          await vi.waitFor(() => expect(alert()).not.toBeNull())
          expect(reload.mock.calls.length).toBe(loads)
          if (fault === 'app-data') {
            const key =
              type === 'bots'
                ? 'team.bots.error.forbidden'
                : type === 'tokens'
                  ? intent === 'revoke'
                    ? 'team.tokens.revoke.unavailable'
                    : 'team.tokens.revoke.failed'
                  : 'team.status.forbidden'
            await vi.waitFor(() =>
              expect(alert()?.textContent).toContain(bindI18n('en').t(key)),
            )
            return
          }
          await vi.waitFor(() =>
            expect(alert()?.textContent).toContain(
              bindI18n('en').t('settings.submissionInterrupted'),
            ),
          )
          await dom.press(confirm()!)
          await vi.waitFor(() => expect(gates).toHaveLength(2))
          expect(posts[1]).toEqual(expectedBody)
          expect(posts[1]).toEqual(posts[0])
          await vi.waitFor(() => expect(confirm()?.disabled).toBe(true))
          await vi.waitFor(() => expect(alert()).toBeNull())
          await act(async () => gates[1]())
          await vi.waitFor(() => expect(dialogEl()).toBeNull())
          if (intent === 'reissue') {
            await vi.waitFor(() =>
              expect(
                document.querySelector('[data-testid="bot-token"]'),
              ).not.toBeNull(),
            )
            expect(container.querySelector('[data-bot-result]')).toBeNull()
            const credential =
              document.querySelector<HTMLElement>('[role="dialog"]')!
            await dom.press(dom.byRole(credential, 'checkbox')!)
            await dom.press(
              await dom.find(() =>
                dom.byRole(
                  credential,
                  'button',
                  bindI18n('en').t('team.bots.token.close'),
                ),
              ),
            )
            await vi.waitFor(() =>
              expect(document.activeElement).toBe(
                container.querySelector('#bot-reissue-target'),
              ),
            )
          }
          if (type === 'bots') {
            await vi.waitFor(() =>
              expect(
                container.querySelector('[data-bot-result]')?.textContent,
              ).toBeTruthy(),
            )
          } else
            await vi.waitFor(() =>
              expect(container.querySelector('[role="status"]')).not.toBeNull(),
            )
          if (type === 'integrations')
            await vi.waitFor(() =>
              expect(document.activeElement).toBe(
                container.querySelector('#slack-heading'),
              ),
            )
          expect(
            container.querySelectorAll(
              type === 'bots' ? '[data-bot-result]' : '[data-settings-status]',
            ),
          ).toHaveLength(1)
          if (returnTrigger)
            await vi.waitFor(() =>
              expect(document.activeElement).toBe(returnTrigger),
            )
          expect(posts).toHaveLength(2)
          expect(reload.mock.calls.length).toBeGreaterThan(loads)
        } else {
          await vi.waitFor(() =>
            expect(
              container.querySelector(
                '[data-screen-capture-error="settings-error-boundary"]',
              ),
            ).not.toBeNull(),
          )
        }
      } finally {
        await unmount(mounted)
      }
    },
  )

// A result belongs to the history entry that produced it: moving Back or
// Forward, even while the submission is in flight, never shows it elsewhere.
function shownResults(container: HTMLElement) {
  return {
    dialog: document.querySelector('[role="alertdialog"]'),
    credential: document.querySelector('[data-testid="bot-token"]'),
    alert: container.querySelector('[role="alert"]'),
    notice: container.querySelector(
      '[data-settings-status], [data-bot-result]',
    ),
  }
}
const nothingShown = {
  dialog: null,
  credential: null,
  alert: null,
  notice: null,
}

for (const operation of operations)
  test.each(
    noReturnedFailure.has(operation[0])
      ? (['success', 'in-flight'] as const)
      : (['failure', 'success', 'in-flight'] as const),
  )(
    operation[0] + ' keeps its %s result on its history entry',
    async (moment) => {
      const [, type] = operation
      const mounted = await mount(
        operation,
        moment === 'failure' ? 'app-data' : 'none',
        [paths[type] + '?view=previous', paths[type]],
      )
      const { gates, router, container } = mounted
      try {
        await openConfirmation(operation, container)
        const dialog = () =>
          document.querySelector<HTMLElement>('[role="alertdialog"]')
        const confirm = () => {
          const buttons = dialog()?.querySelectorAll('button')
          return buttons?.[buttons.length - 1] ?? null
        }
        await vi.waitFor(() => expect(confirm()?.disabled).toBe(false))
        await dom.press(confirm()!)
        await vi.waitFor(() => expect(gates).toHaveLength(1))
        if (moment !== 'in-flight') {
          await act(async () => gates[0]())
          if (moment === 'failure')
            await vi.waitFor(() =>
              expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull(),
            )
          else
            await vi.waitFor(() =>
              expect(
                shownResults(container).notice ??
                  shownResults(container).credential,
              ).not.toBeNull(),
            )
        }
        await act(async () => router.navigate(-1))
        await vi.waitFor(() =>
          expect(shownResults(container)).toEqual(nothingShown),
        )
        if (moment === 'in-flight') await act(async () => gates[0]())
        await act(async () => router.navigate(1))
        await vi.waitFor(() =>
          expect(shownResults(container)).toEqual(nothingShown),
        )
      } finally {
        await unmount(mounted)
      }
    },
  )

// Dismissing a confirmation that failed ends that attempt: the failure is
// not announced again on the page behind it.
for (const operation of operations.filter(
  ([intent]) => !noReturnedFailure.has(intent),
))
  test(operation[0] + ' does not repeat a dismissed failure', async () => {
    const mounted = await mount(operation, 'app-data')
    const { gates, container } = mounted
    try {
      await openConfirmation(operation, container)
      const dialog = () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]')
      const buttons = () => dialog()?.querySelectorAll('button') ?? []
      await vi.waitFor(() =>
        expect(buttons()[buttons().length - 1]?.disabled).toBe(false),
      )
      await dom.press(buttons()[buttons().length - 1]!)
      await vi.waitFor(() => expect(gates).toHaveLength(1))
      await act(async () => gates[0]())
      await vi.waitFor(() =>
        expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull(),
      )
      await dom.press(
        dialog()!.querySelector<HTMLElement>(
          '[data-slot="alert-dialog-cancel"]',
        )!,
      )
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } finally {
      await unmount(mounted)
    }
  })

// A recipient choice is part of the submission: it is locked while the
// request is in flight and kept, unchanged, for the retry after a failure.
// After a returned failure the choice can be changed again; after an
// interrupted request, which may have reached the server, it stays locked.
for (const operation of operations.filter(
  ([intent]) =>
    intent === 'remove-member' || intent === 'transfer-removed-assets',
))
  test.each(['app-data', 'offline'] as const)(
    operation[0] + ' locks and keeps a chosen recipient after %s',
    async (fault) => {
      const mounted = await mount(operation, fault)
      const { gates, posts, container } = mounted
      try {
        await openConfirmation(operation, container)
        const dialog = () =>
          document.querySelector<HTMLElement>('[role="alertdialog"]')!
        const other = () =>
          dialog().querySelector<HTMLButtonElement>(
            '[role="radio"][value="other"]',
          )
        await dom.press(await dom.find(other))
        await vi.waitFor(() =>
          expect(other()?.getAttribute('aria-checked')).toBe('true'),
        )
        const confirm = () => {
          const buttons = dialog().querySelectorAll('button')
          return buttons[buttons.length - 1]
        }
        await vi.waitFor(() => expect(confirm().disabled).toBe(false))
        await dom.press(confirm())
        await vi.waitFor(() => expect(gates).toHaveLength(1))
        expect(posts[0]).toMatchObject({ recipientUserId: 'other' })
        const controls = () =>
          Array.from(
            dialog().querySelectorAll<HTMLInputElement | HTMLButtonElement>(
              'input:not([type="hidden"]), [role="radio"]',
            ),
          )
        expect(controls().length).toBeGreaterThan(1)
        for (const control of controls()) expect(control.disabled).toBe(true)
        await act(async () => gates[0]())
        await vi.waitFor(() =>
          expect(dialog().querySelector('[role="alert"]')).not.toBeNull(),
        )
        expect(other()?.getAttribute('aria-checked')).toBe('true')
        for (const control of controls())
          expect(control.disabled).toBe(fault === 'offline')
        await dom.press(confirm())
        await vi.waitFor(() => expect(gates).toHaveLength(2))
        expect(posts[1]).toEqual(posts[0])
      } finally {
        await unmount(mounted)
      }
    },
  )
