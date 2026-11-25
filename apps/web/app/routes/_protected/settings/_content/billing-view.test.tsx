import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('ja') }
})

import BillingPage, { CheckoutActions, DowngradeImpact } from './billing'
import { BILLING_PRICES, formatPrice, PLAN_DISPLAY } from '~/lib/billing-prices'
import { formatBytes } from '~/lib/format'
import { t, type TKey } from '~/lib/i18n'
import { MESSAGES } from '~/i18n/messages'
import { EXTERNAL_POSTING_FEATURE, PRICING_COPY } from '~/lib/pricing-content'
import type { SubscriptionContract } from '~/services/billing.server'

function renderCheckout(
  initialPlan: 'plus' | 'team',
  isPending = false,
  externalPostingEnabled = true,
) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <CheckoutActions
            isPending={isPending}
            defaultCurrency="jpy"
            initialPlan={initialPlan}
            initialInterval="yearly"
            locale="ja"
            externalPostingEnabled={externalPostingEnabled}
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

const teamMonthlyContract: SubscriptionContract = {
  plan: 'team',
  interval: 'monthly',
  currency: 'jpy',
  amount: 4500,
  renewsAt: '2026-08-15T00:00:00.000Z',
  cancelAtPeriodEnd: false,
}

const teamMonthlyAmount = t('ja', 'billing.contract.amountValue', {
  price: formatPrice('jpy', 4500),
  interval: t('ja', 'billing.interval.monthly'),
})

const nearLimitDetails = t('ja', 'team.usage.nearLimitDetails', {
  limit: formatBytes(100),
  used: formatBytes(95),
  remaining: formatBytes(5),
})

/** The copy that follows the last placeholder, to match a warning without
 * pinning the numbers it interpolates. */
function copyTail(key: TKey) {
  return MESSAGES.ja[key]
    .split(/\{\w+\}/)
    .filter(Boolean)
    .at(-1)!
}

function renderBillingPage(
  projectLimit: number | null,
  contract = projectLimit === null ? teamMonthlyContract : null,
  overrides: Partial<
    Parameters<typeof BillingPage>[0]['loaderData'] & {
      plan: string
      storageUsedBytes: number
      storageQuotaBytes: number
    }
  > = {},
  currentUserIsAdmin = true,
) {
  // Plan and storage are shell data the page reads from the Settings outlet.
  const {
    plan = projectLimit === null ? 'team' : 'free',
    storageUsedBytes = 0,
    storageQuotaBytes = 100 * 1024 * 1024,
    ...billingOverrides
  } = overrides
  const loaderData: Parameters<typeof BillingPage>[0]['loaderData'] = {
    showOverageProjection: false,
    includedBytes: 100 * 1024 ** 3,
    overageProjection: null,
    contributorCount: null,
    contract,
    canManage: true,
    stripeSubscriptionStatus: projectLimit === null ? 'active' : '',
    hasSubscription: projectLimit === null,
    billingConfigured: true,
    defaultCurrency: 'jpy',
    initialPlan: 'team',
    initialInterval: 'monthly',
    activeProjectCount: 4,
    projectLimit,
    entryContext: 'default',
    externalPostingEnabled: true,
    monthlyEstimate: null,
    ...billingOverrides,
  }
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <Outlet
            context={{
              currentUserIsAdmin,
              workspace: { plan, storageUsedBytes, storageQuotaBytes },
            }}
          />
        ),
        children: [
          { index: true, element: <BillingPage loaderData={loaderData} /> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  )
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('billing plan comparison', () => {
  test('renders storage usage instead of project usage', () => {
    const html = renderBillingPage(null, teamMonthlyContract, {
      storageUsedBytes: 3 * 1024 * 1024,
    })

    expect(html).toContain(t('ja', 'billing.usage.storageTitle'))
    expect(html).toContain(`>${t('ja', 'team.usage.storageUsed')}<`)
    expect(html).toContain(formatBytes(3 * 1024 * 1024))
    expect(html).not.toContain('href="/settings/usage"')
  })

  test('renders both checkout forms with the selected billing values', () => {
    const html = renderCheckout('team')

    expect(html).toContain('data-plan="plus"')
    expect(html).toContain('data-plan="team"')
    expect(html.match(/name="intent" value="checkout"/g)).toHaveLength(2)
    expect(html).toContain('name="plan" value="plus"')
    expect(html).toContain('name="plan" value="team"')
    expect(html.match(/name="interval" value="yearly"/g)).toHaveLength(2)
    expect(html.match(/name="currency" value="jpy"/g)).toHaveLength(2)
  })

  test('makes Team primary by default and Plus primary when explicitly selected', () => {
    const teamHtml = renderCheckout('team')
    const plusHtml = renderCheckout('plus')

    expect(teamHtml).toMatch(/data-plan="plus"[\s\S]*?data-primary="false"/)
    expect(teamHtml).toMatch(/data-plan="team"[\s\S]*?data-primary="true"/)
    expect(plusHtml).toMatch(/data-plan="plus"[\s\S]*?data-primary="true"/)
    expect(plusHtml).toMatch(/data-plan="team"[\s\S]*?data-primary="false"/)
  })

  test('disables both checkout actions while navigation is pending', () => {
    expect(renderCheckout('team', true).match(/disabled=""/g)).toHaveLength(2)
  })

  test('renders the shared interval and currency toggles from the pricing page', () => {
    const html = renderCheckout('team')

    expect(html.match(/<legend/g)).toHaveLength(2)
    expect(html).toContain(PRICING_COPY.ja.billingInterval)
    expect(html).toContain(PRICING_COPY.ja.save)
    expect(html).toContain(PRICING_COPY.ja.currency)
    expect(html).toContain('href="/ja/pricing"')
  })

  test('shows external posting according to the workspace policy', () => {
    expect(renderCheckout('team')).toContain(EXTERNAL_POSTING_FEATURE.ja)
    expect(renderCheckout('team', false, false)).not.toContain(
      EXTERNAL_POSTING_FEATURE.ja,
    )
  })
})

describe('subscribed contract management', () => {
  test('renders the current plan card and only the two valid change options', () => {
    const html = renderBillingPage(null)

    expect(html).toContain(t('ja', 'billing.currentPlan'))
    expect(html).toContain(teamMonthlyAmount)
    expect(html).toContain('2026-08-15')
    expect(html).toContain(t('ja', 'billing.change.plan.downgrade'))
    expect(html).toContain(t('ja', 'billing.change.interval.toYearly'))
    expect(html).not.toContain(t('ja', 'billing.change.plan.upgrade'))
    expect(html).not.toContain(t('ja', 'billing.change.interval.toMonthly'))
    expect(html.split(t('ja', 'billing.portal')).length - 1).toBe(1)
    expect(html).not.toContain('value="checkout"')
    expect(html).not.toContain(`${PRICING_COPY.ja.billingInterval}</span>`)
  })

  test.each([true, false])(
    'contract controls and the unavailable notice reflect billing configuration %s',
    (billingConfigured) => {
      const html = renderBillingPage(null, teamMonthlyContract, {
        billingConfigured,
      })
      expect(html).toContain(teamMonthlyAmount)
      expect(html).toContain(t('ja', 'billing.portal'))
      expect(html.includes(t('ja', 'billing.unavailable'))).toBe(
        !billingConfigured,
      )
    },
  )

  test('omits the price when the contract amount is null', () => {
    const html = renderBillingPage(null, {
      ...teamMonthlyContract,
      amount: null,
    })

    expect(html).not.toContain('¥0')
    expect(html).toContain('2026-08-15')
  })

  test('omits the renewal date when renewsAt is null', () => {
    const html = renderBillingPage(null, {
      ...teamMonthlyContract,
      renewsAt: null,
    })

    expect(html).not.toContain(t('ja', 'billing.contract.renewsAt'))
    expect(html).toContain(teamMonthlyAmount)
  })

  test('renders the renewal date when the contract currency is null', () => {
    const html = renderBillingPage(null, {
      ...teamMonthlyContract,
      currency: null,
    })

    expect(html).toContain(t('ja', 'billing.contract.renewsAt'))
    expect(html).toContain('2026-08-15')
    expect(html).toContain(t('ja', 'billing.contract.taxNote'))
    expect(html).not.toContain(teamMonthlyAmount)
  })

  test('downgrade impact lists the lowered limits and flags exceeded usage', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <DowngradeImpact
              storageUsedBytes={11 * 1024 * 1024 * 1024}
              activeProjectCount={25}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)

    expect(html).toContain(
      t('ja', 'billing.downgrade.storage', {
        team: PLAN_DISPLAY.team.storage,
        plus: PLAN_DISPLAY.plus.storage,
      }),
    )
    expect(html).toContain(
      t('ja', 'billing.downgrade.projects', {
        limit: PLAN_DISPLAY.plus.projects,
      }),
    )
    expect(html).toContain(t('ja', 'billing.downgrade.admin'))
    expect(html).toContain(
      t('ja', 'billing.downgrade.overStorage', {
        used: formatBytes(11 * 1024 * 1024 * 1024),
        limit: PLAN_DISPLAY.plus.storage,
      }),
    )
    expect(html).toContain(
      t('ja', 'billing.downgrade.overProjects', {
        count: 25,
        limit: PLAN_DISPLAY.plus.projects,
      }),
    )
  })

  test('downgrade impact omits warnings when usage is within Plus limits', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <DowngradeImpact storageUsedBytes={1024} activeProjectCount={3} />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)

    expect(html).not.toContain(copyTail('billing.downgrade.overStorage'))
    expect(html).not.toContain(copyTail('billing.downgrade.overProjects'))
  })
})

test('a Team workspace without a subscription has no retired label or support presentation', () => {
  for (const storageUsedBytes of [0, 95]) {
    const html = renderBillingPage(null, null, {
      hasSubscription: false,
      stripeSubscriptionStatus: 'none',
      storageUsedBytes,
      storageQuotaBytes: 100,
    })
    expect(html).not.toContain('mailto:')
  }
})

test('near-limit warning applies to capped plans while continuing subscriptions show overage guidance', () => {
  const capped = renderBillingPage(1, null, {
    storageUsedBytes: 90,
    storageQuotaBytes: 100,
  })
  expect(capped).toContain('role="alert"')
  expect(capped).toContain(`>${t('ja', 'team.usage.storageLimit')}<`)
  expect(capped).not.toContain(`>${t('ja', 'team.usage.includedStorage')}<`)
  expect(capped).toContain('bg-warning"')
  const continuing = renderBillingPage(null, null, {
    storageUsedBytes: 95,
    storageQuotaBytes: 120,
    includedBytes: 100,
    showOverageProjection: true,
    overageProjection: { gb: 3, currency: 'usd', amount: 0.3 },
    contributorCount: 2,
  })
  expect(continuing).not.toContain('role="alert"')
  expect(continuing).toContain('3 GB')
  expect(
    continuing.split(`>${t('ja', 'team.usage.includedStorage')}<`).length - 1,
  ).toBe(1)
  expect(continuing).not.toContain(`>${t('ja', 'team.usage.storageLimit')}<`)
  expect(continuing).toContain('95%')
  expect(continuing).toContain('bg-link"')
  expect(continuing.match(/role="progressbar"/g)).toHaveLength(1)
  expect(
    renderBillingPage(1, null, {
      storageUsedBytes: 89,
      storageQuotaBytes: 100,
    }),
  ).not.toContain('role="alert"')
})

test.each([true, false])(
  'capped near-limit banner retains storage details for admin=%s without billing permission',
  (admin) => {
    const html = renderBillingPage(
      1,
      null,
      {
        storageUsedBytes: 95,
        storageQuotaBytes: 100,
        canManage: false,
      },
      admin,
    )
    const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
    expect(banner).toContain(nearLimitDetails)
    expect(banner).toContain(t('ja', 'team.usage.nearLimitMember'))
    expect(banner).not.toContain(t('ja', 'team.usage.nearLimitAdmin'))
    expect(banner).not.toContain('href=')
  },
)

test('near-limit Free owner keeps billing guidance and checkout without a self-link', () => {
  const html = renderBillingPage(1, null, {
    storageUsedBytes: 95,
    storageQuotaBytes: 100,
  })
  const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
  expect(banner).toContain(t('ja', 'team.usage.nearLimitAdmin'))
  expect(banner).not.toContain('href=')
  expect(html).toContain('value="checkout"')
})

test.each([
  ['team', '>Team'],
  ['plus', '>Plus'],
] as const)(
  'a %s workspace without a subscription shows its plan and usage but no checkout or plan guidance',
  (plan, label) => {
    // Checkout refuses a workspace already on a paid plan.
    const html = renderBillingPage(1, null, {
      plan,
      hasSubscription: false,
      stripeSubscriptionStatus: 'none',
      storageUsedBytes: 95,
      storageQuotaBytes: 100,
    })
    expect(html).toContain(label)
    const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
    expect(banner).toContain(nearLimitDetails)
    expect(banner).not.toContain(t('ja', 'team.usage.nearLimitAdmin'))
    expect(html).not.toContain('value="checkout"')
    expect(html).not.toContain('data-plan="plus"')
  },
)

test('a workspace whose stored plan is not a known paid plan keeps checkout as Free', () => {
  const html = renderBillingPage(1, null, {
    plan: 'legacy',
    hasSubscription: false,
    stripeSubscriptionStatus: 'none',
  })
  expect(html).toContain('value="checkout"')
})

test('near-limit owner gets no billing next step when billing is unavailable', () => {
  const html = renderBillingPage(1, null, {
    storageUsedBytes: 95,
    storageQuotaBytes: 100,
    billingConfigured: false,
  })
  const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
  expect(banner).toContain(nearLimitDetails)
  expect(banner).not.toContain(t('ja', 'team.usage.nearLimitAdmin'))
  expect(banner).not.toContain('href=')
  expect(html).not.toContain('value="checkout"')
})

const purchaseVariants = (['monthly', 'yearly'] as const).flatMap((interval) =>
  (['jpy', 'usd'] as const).map((currency) => ({
    id: `${interval}-${currency}`,
    interval,
    currency,
  })),
)

test.each(purchaseVariants)(
  'purchase variant $id selects its interval and currency on both cards',
  ({ interval, currency }) => {
    const html = renderBillingPage(1, null, {
      stripeSubscriptionStatus: 'none',
      defaultCurrency: currency,
      initialInterval: interval,
    })
    expect(
      [...html.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map(
        ([, label]) => label.trim(),
      ),
    ).toEqual([PRICING_COPY.ja[interval], currency.toUpperCase()])
    const cards = Object.fromEntries(
      html
        .split('data-plan="')
        .slice(1)
        .map((card) => [card.slice(0, card.indexOf('"')), card]),
    )
    for (const plan of ['plus', 'team'] as const) {
      const price = formatPrice(
        currency,
        BILLING_PRICES[plan][currency][
          interval === 'monthly' ? 'month' : 'year'
        ],
      )
      expect(cards[plan]).toContain(`>${price} <span`)
    }
    // What each card's form actually submits when its button is pressed.
    // happy-dom applies neither a disabled fieldset to its descendants nor
    // to FormData, so every control and each of its ancestors, inside or
    // around the form, must be free of `disabled`.
    const doc = new Window().document
    doc.body.innerHTML = html
    for (const plan of ['plus', 'team'] as const) {
      const form = doc
        .querySelector(`[data-plan="${plan}"]`)!
        .querySelector('form')!
      const submit = form.querySelector('button')!
      expect(submit.type, plan).toBe('submit')
      // happy-dom leaves an empty submitter value out of FormData while a
      // browser sends it, so a named button would go unseen below.
      expect(submit.getAttribute('name'), plan).toBeNull()
      // form.elements also lists controls joined through a form attribute
      // from outside the form, with ancestors the form does not contain.
      for (const control of [submit, ...form.elements])
        expect(
          control.closest('[disabled]'),
          `${plan} ${control.getAttribute('name') ?? 'submit'}`,
        ).toBeNull()
      expect(
        [...new doc.defaultView!.FormData(form, submit).entries()],
        plan,
      ).toEqual([
        ['intent', 'checkout'],
        ['plan', plan],
        ['interval', interval],
        ['currency', currency],
      ])
    }
  },
)

test.each([true, false])(
  'the default Free purchase page offers enabled Plus and Team checkout when configured=%s',
  (billingConfigured) => {
    const html = renderBillingPage(1, null, {
      stripeSubscriptionStatus: 'none',
      billingConfigured,
    })
    expect(html).not.toContain('data-billing-contract-details')
    expect(html).not.toContain(t('ja', 'billing.portal'))
    expect(html.includes('data-billing-unavailable')).toBe(!billingConfigured)
    const checkout = [
      ...html.matchAll(
        /data-plan="(plus|team)"[\s\S]*?<button([^>]*type="submit"[^>]*)>/g,
      ),
    ]
    expect(checkout.map(([, plan]) => plan)).toEqual(
      billingConfigured ? ['plus', 'team'] : [],
    )
    for (const [, , attributes] of checkout)
      expect(attributes).not.toContain(' disabled=""')
    expect(html).not.toMatch(/<fieldset disabled/)
  },
)

test('a continuing subscription near its included storage shows the overage estimate', () => {
  const includedBytes = 100 * 1024 ** 3
  const html = renderBillingPage(
    null,
    { ...teamMonthlyContract, currency: 'usd', amount: 29 },
    {
      storageUsedBytes: includedBytes * 0.95,
      storageQuotaBytes: includedBytes,
      includedBytes,
      showOverageProjection: true,
      overageProjection: { gb: 0, currency: 'usd', amount: 0 },
      monthlyEstimate: {
        currency: 'usd',
        planAmount: 0,
        overageAmount: 0,
        totalAmount: 0,
        planCharge: 'none',
        cancelAtPeriodEnd: false,
        planDate: '2026-08-15T00:00:00.000Z',
        overageGb: 0,
        overageEnabled: true,
      },
    },
  )
  expect(html).toContain('id="billing-estimate-overage"')
  expect(html.match(/>プラン込み容量</g)).toHaveLength(1)
  expect(html).toContain('95%')
  expect(html).not.toContain('role="alert"')
})
