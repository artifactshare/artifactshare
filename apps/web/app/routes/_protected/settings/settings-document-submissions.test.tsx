// A form submitted before the client hydrates is a plain document POST. The
// returned page must show its result where a hydrated submission would.
import type { ComponentProps, ReactElement } from 'react'
import { UNSAFE_withComponentProps, type ActionFunction } from 'react-router'
import { expect, test, vi } from 'vitest'
import { documentPost, documentRequestHandler } from '~/test/document-request'
import * as general from './_content/general'
import * as tokens from './_content/tokens'
import * as billing from './_content/billing'
import * as settingsLayout from './_layout'

const { updateWorkspaceName, createApiToken, stripe } = vi.hoisted(() => ({
  updateWorkspaceName: vi.fn(),
  createApiToken: vi.fn(),
  stripe: { configured: false, createCheckoutSession: vi.fn() },
}))
vi.mock('~/services/billing.server', async (original) => ({
  ...(await original<typeof import('~/services/billing.server')>()),
  isBillingConfigured: () => stripe.configured,
  createStripeClient: () => ({}),
  createCheckoutSession: stripe.createCheckoutSession,
}))
vi.mock('cloudflare:workers', () => ({
  env: {
    BETTER_AUTH_URL: 'https://app.example.test',
    STRIPE_SECRET_KEY: 'local-test-only',
  },
}))
vi.mock('~/middleware/context', async (original) => ({
  ...(await original<typeof import('~/middleware/context')>()),
  requireUser: () => ({
    id: 'owner',
    workspaceId: 'workspace',
    email: 'owner@example.test',
    name: 'Owner',
    image: null,
  }),
}))
// The Settings shell's own reads, counted per returned document.
const shellReads = vi.hoisted(() => ({
  shell: vi.fn(async () => ({
    kind: 'team' as const,
    workspace: {
      id: 'workspace',
      name: 'Freshly read workspace',
      hd: null,
      plan: 'team',
      storageUsedBytes: 0,
      storageQuotaBytes: 100000,
    },
    currentUserIsAdmin: true,
    currentUserRole: 'owner' as const,
  })),
}))
vi.mock('./+lib/settings-request.server', () => ({
  loadSettingsShell: shellReads.shell,
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
vi.mock('~/services/team-management.server', async (original) => ({
  ...(await original<typeof import('~/services/team-management.server')>()),
  updateWorkspaceName,
  requireWorkspaceOwner: () => ({ kind: 'ok' }),
}))
vi.mock('~/services/api-tokens.server', async (original) => ({
  ...(await original<typeof import('~/services/api-tokens.server')>()),
  createApiToken,
}))

const shell = {
  kind: 'team',
  currentUserIsAdmin: true,
  currentUserRole: 'owner',
  workspace: {
    id: 'workspace',
    name: 'Example workspace',
    plan: 'free',
    storageUsedBytes: 0,
    storageQuotaBytes: 100000,
  },
}

async function submit(
  path: string,
  Page: () => ReactElement,
  action: ActionFunction,
  fields: Record<string, string>,
) {
  const handle = documentRequestHandler({
    path,
    Page,
    action,
    outletContext: shell,
  })
  const response = await handle(
    documentPost('https://app.example.test' + path, fields),
  )
  return { status: response.status, html: await response.text() }
}

const GeneralPage = () => <general.default loaderData={{ owner: null }} />
const generalAction: ActionFunction = (args) =>
  general.action({ ...args, params: {}, pattern: '/settings/general' })
const TokensPage = () => (
  <tokens.default
    loaderData={{ tokens: [], createdToken: null, cliFamilies: [] }}
  />
)
const tokensAction: ActionFunction = (args) =>
  tokens.action({ ...args, params: {}, pattern: '/settings/tokens' })
const billingAction: ActionFunction = (args) =>
  billing.action({ ...args, params: {}, pattern: '/settings/billing' })

test('General shows a saved name, an invalid name and an unknown intent in the returned page', async () => {
  updateWorkspaceName.mockResolvedValueOnce({ kind: 'ok' })
  const saved = await submit('/settings/general', GeneralPage, generalAction, {
    intent: 'update-workspace-name',
    workspaceName: 'Renamed',
  })
  expect(saved.status).toBe(200)
  expect(saved.html).toMatch(/role="status"[^>]*data-settings-status="ok"/)

  updateWorkspaceName.mockResolvedValueOnce({ kind: 'invalid' })
  const invalid = await submit(
    '/settings/general',
    GeneralPage,
    generalAction,
    { intent: 'update-workspace-name', workspaceName: ' ' },
  )
  expect(invalid.status).toBe(400)
  expect(invalid.html).toMatch(/data-settings-status="invalid"/)

  const unknown = await submit(
    '/settings/general',
    GeneralPage,
    generalAction,
    { intent: 'delete-workspace', workspaceName: 'Renamed' },
  )
  expect(unknown.status).toBe(400)
  expect(unknown.html).toMatch(/data-settings-status="invalid"/)
})

test('a native token POST renders Settings with one fresh shell and its result', async () => {
  createApiToken.mockResolvedValueOnce({
    token: 'as_document_token',
    name: 'Reports',
  })
  shellReads.shell.mockClear()
  const handle = documentRequestHandler({
    path: '/settings/tokens',
    Page: TokensPage,
    action: tokensAction,
    layout: {
      loader: (args) =>
        settingsLayout.loader({ ...args, params: {}, pattern: '/settings' }),
      Component: UNSAFE_withComponentProps(settingsLayout.default),
    },
  })
  const response = await handle(
    documentPost('https://app.example.test/settings/tokens', {
      intent: 'create',
      name: 'Reports',
    }),
  )
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(html).toContain('as_document_token')
  // The returned document shows the freshly read shell.
  expect(html).toContain('Freshly read workspace')
  expect(shellReads.shell).toHaveBeenCalledTimes(1)
})

test('API token creation shows the new token or the name error in the returned page', async () => {
  createApiToken.mockResolvedValueOnce({
    token: 'as_document_token',
    name: 'Reports',
  })
  const created = await submit('/settings/tokens', TokensPage, tokensAction, {
    intent: 'create',
    name: 'Reports',
  })
  expect(created.status).toBe(200)
  expect(created.html).toContain('as_document_token')
  expect(created.html).toMatch(/data-settings-status="ok"/)

  const missing = await submit('/settings/tokens', TokensPage, tokensAction, {
    intent: 'create',
    name: '',
  })
  expect(missing.status).toBe(400)
  expect(missing.html).toContain('aria-invalid="true"')
})

test('Billing sends a started checkout to Stripe', async () => {
  stripe.configured = true
  stripe.createCheckoutSession.mockResolvedValueOnce({
    kind: 'ok',
    url: 'https://checkout.stripe.test/session',
  })
  try {
    const handle = documentRequestHandler({
      path: '/settings/billing',
      Page: () => <billing.default loaderData={billingLoaderData} />,
      action: billingAction,
      outletContext: shell,
    })
    const response = await handle(
      documentPost('https://app.example.test/settings/billing', {
        intent: 'checkout',
        plan: 'plus',
        interval: 'monthly',
      }),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(
      'https://checkout.stripe.test/session',
    )
  } finally {
    stripe.configured = false
  }
})

test('Billing shows a checkout it could not start in the returned page', async () => {
  // Stripe is not configured here, so the action rejects every checkout.
  const rejected = await submit(
    '/settings/billing',
    () => <billing.default loaderData={billingLoaderData} />,
    billingAction,
    { intent: 'checkout', plan: 'plus', interval: 'monthly' },
  )
  expect(rejected.status).toBe(409)
  expect(rejected.html).toMatch(/data-settings-status="billing-unavailable"/)
})

const billingLoaderData: ComponentProps<typeof billing.default>['loaderData'] =
  {
    canManage: true,
    billingConfigured: true,
    hasSubscription: false,
    stripeSubscriptionStatus: '',
    defaultCurrency: 'usd',
    initialPlan: 'plus',
    initialInterval: 'monthly',
    activeProjectCount: 0,
    projectLimit: null,
    entryContext: 'default',
    externalPostingEnabled: false,
    contract: null,
    monthlyEstimate: null,
    showOverageProjection: false,
    includedBytes: 100000,
    overageProjection: null,
    contributorCount: 1,
  }
