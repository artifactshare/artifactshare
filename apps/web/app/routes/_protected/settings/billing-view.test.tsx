import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('ja') }
})

import BillingPage, { CheckoutActions, DowngradeImpact } from './billing'
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

function renderBillingPage(
  projectLimit: number | null,
  contract = projectLimit === null ? teamMonthlyContract : null,
  overrides: Partial<Parameters<typeof BillingPage>[0]['loaderData']> = {},
  currentUserIsAdmin = true,
) {
  const loaderData: Parameters<typeof BillingPage>[0]['loaderData'] = {
    showOverageProjection: false,
    includedBytes: 100 * 1024 ** 3,
    overageProjection: null,
    contributorCount: null,
    contract,
    canManage: true,
    plan: projectLimit === null ? 'team' : 'free',
    stripeSubscriptionStatus: projectLimit === null ? 'active' : '',
    hasSubscription: projectLimit === null,
    billingConfigured: true,
    defaultCurrency: 'jpy',
    initialPlan: 'team',
    initialInterval: 'monthly',
    storageUsedBytes: 0,
    storageQuotaBytes: 100 * 1024 * 1024,
    activeProjectCount: 4,
    projectLimit,
    entryContext: 'default',
    externalPostingEnabled: true,
    monthlyEstimate: null,
    ...overrides,
  }
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Outlet context={{ currentUserIsAdmin }} />,
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
    const html = renderBillingPage(null)

    expect(html).toContain('保存容量の使用状況')
    expect(html).not.toContain('href="/settings/usage"')
    expect(html).not.toContain('アクティブなプロジェクト')
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

    expect(html.match(/<fieldset/g)).toHaveLength(2)
    expect(html).toContain('支払い周期')
    expect(html).toContain('2か月分お得')
    expect(html).toContain('通貨')
    expect(html).toContain('href="/ja/pricing"')
  })

  test('shows external posting according to the workspace policy', () => {
    expect(renderCheckout('team')).toContain('社外メンバーからの投稿')
    expect(renderCheckout('team', false, false)).not.toContain(
      '社外メンバーからの投稿',
    )
  })
})

describe('subscribed contract management', () => {
  test('renders the current plan card and only the two valid change options', () => {
    const html = renderBillingPage(null)

    expect(html).toContain('現在のプラン')
    expect(html).toContain('¥4,500 / 月払い')
    expect(html).toContain('2026-08-15')
    expect(html).toContain('Plus へダウングレード')
    expect(html).toContain('年払いに変更')
    expect(html).not.toContain('Team へアップグレード')
    expect(html).not.toContain('月払いに変更')
    expect(html).toContain('カスタマーポータル')
    expect(html.match(/カスタマーポータルを開く/g)).toHaveLength(1)
    expect(html).not.toContain('固定料金')
    expect(html).not.toContain('支払い周期</span>')
  })

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

    expect(html).not.toContain('次回更新日')
    expect(html).toContain('¥4,500 / 月払い')
  })

  test('renders the renewal date when the contract currency is null', () => {
    const html = renderBillingPage(null, {
      ...teamMonthlyContract,
      currency: null,
    })

    expect(html).toContain('次回更新日')
    expect(html).toContain('2026-08-15')
    expect(html).toContain('税別')
    expect(html).not.toContain('¥4,500 / 月払い')
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

    expect(html).toContain('100 GB 込み → 10 GB 込み')
    expect(html).toContain('無制限 → 20 件まで')
    expect(html).toContain('管理機能が使えなくなります')
    expect(html).toContain('10 GB を超えています')
    expect(html).toContain('25 件あり')
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

    expect(html).not.toContain('超えています')
  })
})

test('Team without a subscription has no purchase offer while Free retains checkout', () => {
  const team = renderBillingPage(null, null, {
    hasSubscription: false,
    stripeSubscriptionStatus: 'none',
  })
  expect(team).toContain('Team（サブスクリプションなし）')
  expect(team).not.toContain('value="checkout"')
  expect(renderBillingPage(1)).toContain('value="checkout"')
})
test('near-limit warning applies to capped plans while continuing subscriptions show overage guidance', () => {
  const capped = renderBillingPage(1, null, {
    storageUsedBytes: 90,
    storageQuotaBytes: 100,
  })
  expect(capped).toContain('role="alert"')
  const continuing = renderBillingPage(null, null, {
    storageUsedBytes: 90,
    storageQuotaBytes: 100,
    showOverageProjection: true,
    overageProjection: { gb: 3, currency: 'usd', amount: 0.3 },
    contributorCount: 2,
  })
  expect(continuing).not.toContain('role="alert"')
  expect(continuing).toContain('3 GB')
  expect(continuing).toContain('90%')
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
    expect(banner).toContain('100 B 中 95 B を使用中です。残りは 5 B です。')
    expect(banner).toContain(
      'ワークスペースのオーナーに保存容量の上限を確認してもらってください。',
    )
    expect(banner).not.toContain(
      '上限を増やすには、このページのプランから選んでください。',
    )
    expect(banner).not.toContain('href=')
  },
)

test('near-limit Team owner without a subscription gets support guidance without a billing offer', () => {
  const html = renderBillingPage(null, null, {
    hasSubscription: false,
    stripeSubscriptionStatus: 'none',
    storageUsedBytes: 95,
    storageQuotaBytes: 100,
  })
  const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
  expect(banner).toContain(
    '保存容量の上限についてはサポートにお問い合わせください。',
  )
  expect(banner).not.toContain(
    '上限を増やすには、このページのプランから選んでください。',
  )
  expect(banner).toContain(
    'href="mailto:support@artifactshare.com?subject=Artifact%20Share%20upgrade%20help%3A%20storage"',
  )
  expect(html).not.toContain('value="checkout"')
})

test('near-limit Free owner keeps billing guidance and checkout without a self-link', () => {
  const html = renderBillingPage(1, null, {
    storageUsedBytes: 95,
    storageQuotaBytes: 100,
  })
  const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
  expect(banner).toContain(
    '上限を増やすには、このページのプランから選んでください。',
  )
  expect(banner).not.toContain('href=')
  expect(html).toContain('value="checkout"')
})

test('near-limit owner gets no billing next step when billing is unavailable', () => {
  const html = renderBillingPage(1, null, {
    storageUsedBytes: 95,
    storageQuotaBytes: 100,
    billingConfigured: false,
  })
  const banner = html.match(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/)?.[1]
  expect(banner).toContain('100 B 中 95 B を使用中です。残りは 5 B です。')
  expect(banner).not.toContain('上限を増やすには')
  expect(banner).not.toContain('href=')
  expect(html).not.toContain('value="checkout"')
})
