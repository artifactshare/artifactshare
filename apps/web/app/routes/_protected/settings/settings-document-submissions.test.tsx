// A form submitted before the client hydrates is a plain document POST. The
// returned page must show its result where a hydrated submission would.
import type { ComponentProps, ReactElement } from 'react'
import type { ActionFunction } from 'react-router'
import { expect, test, vi } from 'vitest'
import { documentPost, documentRequestHandler } from '~/test/document-request'
import * as general from './_content/general'
import * as tokens from './_content/tokens'
import * as billing from './_content/billing'

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
  requireUser: () => ({ id: 'owner', workspaceId: 'workspace' }),
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
  requireWorkspaceBillingOwner: () => ({ kind: 'ok' }),
}))
vi.mock('~/services/api-tokens.server', async (original) => ({
  ...(await original<typeof import('~/services/api-tokens.server')>()),
  createApiToken,
}))

const shell = {
  kind: 'team',
  currentUserIsAdmin: true,
  currentUserRole: 'owner',
  workspace: { id: 'workspace', name: 'Example workspace' },
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

test('General shows a saved name and an invalid name in the returned page', async () => {
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
    plan: 'free',
    canManage: true,
    billingConfigured: true,
    hasSubscription: false,
    stripeSubscriptionStatus: '',
    defaultCurrency: 'usd',
    initialPlan: 'plus',
    initialInterval: 'monthly',
    storageUsedBytes: 0,
    storageQuotaBytes: 100000,
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
