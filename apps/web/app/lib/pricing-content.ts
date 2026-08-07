import {
  BILLING_PRICES,
  formatPrice,
  PLAN_DISPLAY,
  STORAGE_OVERAGE_PRICES,
  type BillingCurrency,
  type PriceInterval,
  type BillingPlan,
} from './billing-prices'

type PlanCopy = {
  description: string
  priceNote: string
  yearlyTaxNote?: string
  features: readonly string[]
  note: string
}
export type ComparisonValues =
  | readonly string[]
  | Record<BillingCurrency, readonly string[]>
export type ComparisonRow = { label: string; values: ComparisonValues }
type Faq = { question: string; answer: string }
export const EXTERNAL_POSTING_FEATURE = {
  en: 'Uploads from external members',
  ja: '社外メンバーからの投稿',
} as const
const LINK_SHARING_FEATURE = {
  en: 'Link sharing with expiration settings',
  ja: '認証なしのリンク共有（期限設定付き）',
} as const
const TEAM_LINK_SHARING_FEATURE = {
  en: 'Link sharing with expiration settings and workspace controls',
  ja: '認証なしのリンク共有（期限設定・組織管理付き）',
} as const
export type PricingCopy = {
  title: string
  description: string
  eyebrow: string
  hero: string
  body: string
  billingInterval: string
  monthly: string
  yearly: string
  save: string
  currency: string
  compare: string
  faq: string
  billedMonthly: string
  billedYearly: string
  period: Record<PriceInterval, string>
  homeLabel: string
  howTo: string
  signIn: string
  comparisonFeature: string
  choose: Record<BillingPlan, string>
  recommended: string
  plans: Record<BillingPlan, PlanCopy>
  comparison: readonly ComparisonRow[]
  faqs: readonly Faq[]
}

const commonFeatures = {
  en: {
    free: [
      `${PLAN_DISPLAY.free.storage} storage`,
      `Up to ${PLAN_DISPLAY.free.projects} projects`,
      'No additional fees based on the number of publishers, viewers, or commenters',
      'Post directly from AI tools via CLI or MCP server',
      'Share HTML, Markdown, and static sites',
      'Comments and version updates',
    ],
    plus: [
      `${PLAN_DISPLAY.plus.storage} storage`,
      `Up to ${PLAN_DISPLAY.plus.projects} projects`,
      'No additional fees based on the number of publishers, viewers, or commenters',
      LINK_SHARING_FEATURE.en,
      EXTERNAL_POSTING_FEATURE.en,
      `Continue beyond ${PLAN_DISPLAY.plus.storage}`,
      'Post directly from AI tools via CLI or MCP server',
      'Share HTML, Markdown, and static sites',
      'Comments and version updates',
    ],
    team: [
      `${PLAN_DISPLAY.team.storage} storage`,
      `${PLAN_DISPLAY.team.projects} projects`,
      'No additional fees based on the number of publishers, viewers, or commenters',
      TEAM_LINK_SHARING_FEATURE.en,
      EXTERNAL_POSTING_FEATURE.en,
      'Contributor and storage management',
      `Continue beyond ${PLAN_DISPLAY.team.storage}`,
      'Post directly from AI tools via CLI or MCP server',
      'Share HTML, Markdown, and static sites',
      'Comments and version updates',
    ],
  },
  ja: {
    free: [
      `保存容量 ${PLAN_DISPLAY.free.storage}`,
      `プロジェクト ${PLAN_DISPLAY.free.projects}件`,
      '投稿者・閲覧者・コメント参加者の人数による追加料金なし',
      'CLI・MCPサーバーからAIで直接投稿',
      'HTML、Markdown、静的サイトの共有',
      'コメントと版更新',
    ],
    plus: [
      `保存容量 ${PLAN_DISPLAY.plus.storage}`,
      `プロジェクト ${PLAN_DISPLAY.plus.projects}件`,
      '投稿者・閲覧者・コメント参加者の人数による追加料金なし',
      LINK_SHARING_FEATURE.ja,
      EXTERNAL_POSTING_FEATURE.ja,
      `${PLAN_DISPLAY.plus.storage}を超えても継続利用可能`,
      'CLI・MCPサーバーからAIで直接投稿',
      'HTML、Markdown、静的サイトの共有',
      'コメントと版更新',
    ],
    team: [
      `保存容量 ${PLAN_DISPLAY.team.storage}`,
      'プロジェクト数無制限',
      '投稿者・閲覧者・コメント参加者の人数による追加料金なし',
      TEAM_LINK_SHARING_FEATURE.ja,
      EXTERNAL_POSTING_FEATURE.ja,
      '投稿者と保存容量の運用管理',
      `${PLAN_DISPLAY.team.storage}を超えても継続利用可能`,
      'CLI・MCPサーバーからAIで直接投稿',
      'HTML、Markdown、静的サイトの共有',
      'コメントと版更新',
    ],
  },
} as const

const makeCopy = (locale: 'en' | 'ja'): PricingCopy => {
  const ja = locale === 'ja'
  const overage = {
    jpy: formatStorageOveragePrice('jpy'),
    usd: formatStorageOveragePrice('usd'),
  }
  const teamYearlyBeforeTax = formatPrice('jpy', BILLING_PRICES.team.jpy.year)
  const teamYearlyWithTax = formatPrice(
    'jpy',
    Math.round(BILLING_PRICES.team.jpy.year * 1.1),
  )
  return ja
    ? {
        title: '料金プラン | Artifact Share',
        description:
          'Artifact ShareのFree、Plus、Teamを比較できます。月払い・年払い、JPY・USD、保存容量、容量超過料金を確認して、ワークスペースに合うプランを選べます。',
        eyebrow: '料金プラン',
        hero: 'AIが作った成果物を、チームの仕事に。',
        body: 'HTML、Markdown、静的サイトを共有し、コメントと版更新をひとつの場所で続けられます。人数による追加料金はありません。',
        billingInterval: '支払い周期',
        monthly: '月払い',
        yearly: '年払い',
        save: '2か月分お得',
        currency: '通貨',
        compare: 'プランの違い',
        faq: 'よくある質問',
        billedMonthly: '毎月請求・税抜',
        billedYearly: '1年分をまとめて請求・税抜',
        period: { month: '月', year: '年' },
        homeLabel: 'Artifact Share ホーム',
        howTo: '使い方',
        signIn: 'ログイン',
        comparisonFeature: '機能',
        choose: {
          free: '無料で始める',
          plus: 'Plusを選ぶ',
          team: 'Teamを選ぶ',
        },
        recommended: '社内利用におすすめ',
        plans: {
          free: {
            description: '小さな社内試用や単発の共有から始める',
            priceNote: 'クレジットカード不要',
            features: commonFeatures.ja.free,
            note: `保存容量が${PLAN_DISPLAY.free.storage}に達すると、新しいアップロードは停止します。リンク共有と社外メンバーからの投稿はPlusプランとTeamプランで利用できます。`,
          },
          plus: {
            description: 'ひとりから少人数で、案件やプロジェクトに継続して使う',
            priceNote: '',
            features: commonFeatures.ja.plus,
            note: `${PLAN_DISPLAY.plus.storage}を超えた保存容量には、JPYで${overage.jpy} / GB・月、USDで${overage.usd} / GB・月の容量超過料金がかかります。契約中は上限なくアップロードを続けられます。`,
          },
          team: {
            description: '部署や会社で、投稿者と保存容量を管理しながら運用する',
            priceNote: '',
            yearlyTaxNote: `消費税込み${teamYearlyWithTax}`,
            features: commonFeatures.ja.team,
            note: `ワークスペース単位の定額です。${PLAN_DISPLAY.team.storage}を超えた保存容量には、JPYで${overage.jpy} / GB・月、USDで${overage.usd} / GB・月の容量超過料金がかかります。契約中は上限なくアップロードを続けられます。`,
          },
        },
        comparison: [
          {
            label: '保存容量',
            values: Object.values(PLAN_DISPLAY).map((plan) => plan.storage),
          },
          {
            label: 'プロジェクト',
            values: [
              `${PLAN_DISPLAY.free.projects}件`,
              `${PLAN_DISPLAY.plus.projects}件`,
              '無制限',
            ],
          },
          {
            label: '投稿・閲覧・コメントの人数に応じた追加料金',
            values: ['なし', 'なし', 'なし'],
          },
          {
            label: 'CLI・MCPサーバーからの投稿',
            values: ['あり', 'あり', 'あり'],
          },
          {
            label: '認証なしのリンク共有',
            values: ['—', '期限設定付き', '期限設定・組織管理付き'],
          },
          { label: '社外メンバーからの投稿', values: ['—', 'あり', 'あり'] },
          { label: '投稿者と保存容量の運用管理', values: ['—', '—', 'あり'] },
          {
            label: '含有容量を超えた継続利用',
            values: ['—', '上限なし', '上限なし'],
          },
          {
            label: '容量超過料金',
            values: {
              jpy: ['—', `${overage.jpy} / GB・月`, `${overage.jpy} / GB・月`],
              usd: ['—', `${overage.usd} / GB・月`, `${overage.usd} / GB・月`],
            },
          },
        ],
        faqs: [
          {
            question: '表示価格に税は含まれていますか？',
            answer: `有料プランの表示価格は税抜です。国内でJPYを選ぶと、申込時に消費税が加算されます。Teamの年払いは税抜${teamYearlyBeforeTax}、消費税込み${teamYearlyWithTax}です。適用される税額と最終的な請求額はCheckoutで確認できます。`,
          },
          {
            question: '年払いはどのように請求されますか？',
            answer:
              '申込時に1年分をまとめて請求します。PlusもTeamも月払いを12か月続ける場合と比べて2か月分お得です。年払いを選ぶと、年額と月あたりの換算額をあわせて表示します。',
          },
          {
            question: '保存容量を超えるとどうなりますか？',
            answer: `Freeでは、保存容量が${PLAN_DISPLAY.free.storage}に達すると、新しいファイルをアップロードできなくなります。Plus（${PLAN_DISPLAY.plus.storage}）とTeam（${PLAN_DISPLAY.team.storage}）では上限なくアップロードを続けられ、超過分には同じ容量超過料金がかかります。`,
          },
          {
            question: 'PlusからTeamへ変更する目安はありますか？',
            answer: `無制限のプロジェクトや、投稿者と保存容量を管理するための運用機能が必要な場合は、Teamが適しています。保存容量が${PLAN_DISPLAY.plus.storage}を超えても、契約中のPlusをそのまま利用できます。`,
          },
          {
            question: '利用人数が増えると料金も上がりますか？',
            answer:
              'いいえ。投稿、閲覧、コメントに参加する人が増えても、人数による追加料金はかかりません。Teamもワークスペース単位の定額です。',
          },
          {
            question: '支払い通貨は選べますか？',
            answer:
              'はい。お申し込み前に料金ページで日本円（JPY）または米ドル（USD）を選べます。選択した通貨の固定価格が適用されます。',
          },
          {
            question: 'プランの変更や解約はできますか？',
            answer:
              'ワークスペースのオーナーが請求設定またはカスタマーポータルから手続きできます。',
          },
        ],
      }
    : {
        title: 'Pricing | Artifact Share',
        description:
          'Compare Artifact Share Free, Plus, and Team plans, with monthly and yearly prices in JPY and USD, included storage, project limits, and storage overage rates.',
        eyebrow: 'Pricing',
        hero: 'Turn AI-generated work into team work.',
        body: 'Share HTML, Markdown, and static sites in one place, then keep them current with comments and version updates. No per-person fees.',
        billingInterval: 'Billing interval',
        monthly: 'Monthly',
        yearly: 'Yearly',
        save: 'Save 2 months',
        currency: 'Currency',
        compare: 'Compare plans',
        faq: 'Frequently asked questions',
        billedMonthly: 'Billed monthly, excluding tax',
        billedYearly: 'Billed once per year, excluding tax',
        period: { month: 'month', year: 'year' },
        homeLabel: 'Artifact Share home',
        howTo: 'How it works',
        signIn: 'Sign in',
        comparisonFeature: 'Feature',
        choose: {
          free: 'Start for free',
          plus: 'Choose Plus',
          team: 'Choose Team',
        },
        recommended: 'Recommended for companies',
        plans: {
          free: {
            description: 'For small internal trials and one-off sharing',
            priceNote: 'No credit card required',
            features: commonFeatures.en.free,
            note: `New uploads stop when storage reaches ${PLAN_DISPLAY.free.storage}. Link sharing and uploads from external members are available on Plus and Team.`,
          },
          plus: {
            description:
              'For individuals and small teams running ongoing client or project work',
            priceNote: '',
            features: commonFeatures.en.plus,
            note: `Storage beyond ${PLAN_DISPLAY.plus.storage} is charged at ${overage.jpy} per GB-month in JPY or ${overage.usd} per GB-month in USD. Active Plus subscriptions can continue without a hard cap.`,
          },
          team: {
            description:
              'For departments and companies that need to manage contributors and storage',
            priceNote: '',
            yearlyTaxNote: `${teamYearlyWithTax} including Japanese consumption tax`,
            features: commonFeatures.en.team,
            note: `Team has a flat workspace price. Storage beyond ${PLAN_DISPLAY.team.storage} is charged at ${overage.jpy} per GB-month in JPY or ${overage.usd} per GB-month in USD. Active Team subscriptions can continue without a hard cap.`,
          },
        },
        comparison: [
          {
            label: 'Storage',
            values: Object.values(PLAN_DISPLAY).map((plan) => plan.storage),
          },
          {
            label: 'Projects',
            values: Object.values(PLAN_DISPLAY).map((plan) => plan.projects),
          },
          {
            label: 'Per-person fees for publishing, viewing, or commenting',
            values: ['None', 'None', 'None'],
          },
          {
            label: 'Publishing from the CLI or an MCP server',
            values: ['Included', 'Included', 'Included'],
          },
          {
            label: 'Links that open without sign-in',
            values: [
              '—',
              'With expiration settings',
              'With expiration settings and workspace controls',
            ],
          },
          {
            label: 'Uploads from external members',
            values: ['—', 'Included', 'Included'],
          },
          {
            label: 'Contributor and storage management',
            values: ['—', '—', 'Included'],
          },
          {
            label: 'Continue beyond included storage',
            values: ['—', 'No hard cap', 'No hard cap'],
          },
          {
            label: 'Storage overage rate',
            values: {
              jpy: [
                '—',
                `${overage.jpy} / GB-month`,
                `${overage.jpy} / GB-month`,
              ],
              usd: [
                '—',
                `${overage.usd} / GB-month`,
                `${overage.usd} / GB-month`,
              ],
            },
          },
        ],
        faqs: [
          {
            question: 'Do displayed prices include tax?',
            answer: `Paid-plan prices are shown before tax. Japanese consumption tax is added when you check out in JPY. Team yearly is ${teamYearlyBeforeTax} before tax and ${teamYearlyWithTax} including Japanese consumption tax. Review the final total in Checkout before paying.`,
          },
          {
            question: 'How does yearly billing work?',
            answer:
              'You pay for one year when you subscribe. Plus and Team yearly plans each cost two months less than 12 monthly payments. When yearly billing is selected, the page shows the full yearly price and its monthly equivalent.',
          },
          {
            question: 'What happens when I exceed the included storage?',
            answer: `On Free, new uploads stop when you reach ${PLAN_DISPLAY.free.storage}. On Plus (${PLAN_DISPLAY.plus.storage}) and Team (${PLAN_DISPLAY.team.storage}), you can keep uploading without a limit, and the same storage overage rate applies beyond the included capacity.`,
          },
          {
            question: 'When is Team a good fit?',
            answer: `Team is a good fit when you need unlimited projects or operational controls for contributors and storage. An active Plus subscription can continue beyond ${PLAN_DISPLAY.plus.storage}, so reaching ${PLAN_DISPLAY.plus.storage} does not require a move to Team.`,
          },
          {
            question: 'Does the price increase when more people contribute?',
            answer:
              'No. There are no additional fees when more people publish, view, or comment. Team is also a flat rate per workspace.',
          },
          {
            question: 'Can I choose my payment currency?',
            answer:
              'Yes. Before signing up, you can choose Japanese yen (JPY) or U.S. dollars (USD) on the pricing page. You’ll pay the fixed price shown in your selected currency.',
          },
          {
            question: 'Can I change or cancel my plan?',
            answer:
              'The workspace owner can manage the subscription from billing settings or the customer portal.',
          },
        ],
      }
}

export const PRICING_COPY: Record<'en' | 'ja', PricingCopy> = {
  en: makeCopy('en'),
  ja: makeCopy('ja'),
}

export function pricingCopyForBilling(
  locale: 'en' | 'ja',
  externalPostingEnabled: boolean,
): PricingCopy {
  const copy = PRICING_COPY[locale]
  if (externalPostingEnabled) return copy

  const externalPostingFeature = EXTERNAL_POSTING_FEATURE[locale]
  return {
    ...copy,
    plans: {
      ...copy.plans,
      plus: {
        ...copy.plans.plus,
        features: copy.plans.plus.features.filter(
          (feature) => feature !== externalPostingFeature,
        ),
      },
      team: {
        ...copy.plans.team,
        features: copy.plans.team.features.filter(
          (feature) => feature !== externalPostingFeature,
        ),
      },
    },
  }
}

export function comparisonValuesForCurrency(
  values: ComparisonValues,
  currency: BillingCurrency,
): readonly string[] {
  if (isComparisonValuesArray(values)) return values
  return values[currency]
}

function isComparisonValuesArray(
  values: ComparisonValues,
): values is readonly string[] {
  return Array.isArray(values)
}

export function formatStorageOveragePrice(currency: BillingCurrency): string {
  const amount = STORAGE_OVERAGE_PRICES[currency]
  return currency === 'jpy' ? `¥${amount}` : `$${amount.toFixed(2)}`
}
export function yearlyEquivalent(
  currency: BillingCurrency,
  plan: BillingPlan,
): string {
  const amount = BILLING_PRICES[plan][currency].year / 12
  return currency === 'jpy'
    ? `¥${Math.round(amount).toLocaleString('ja-JP')}`
    : `$${amount.toFixed(2)}`
}
export function pricingMarkdown(): string {
  const p = (
    plan: BillingPlan,
    currency: BillingCurrency,
    interval: PriceInterval,
  ) => formatPrice(currency, BILLING_PRICES[plan][currency][interval])
  return `# Artifact Share pricing\n\nFree, Plus, and Team plans do not charge by contributor count.\n\n| Plan | JPY monthly | JPY yearly | USD monthly | USD yearly |\n|---|---:|---:|---:|---:|\n| Free | ${p('free', 'jpy', 'month')} | ${p('free', 'jpy', 'year')} | ${p('free', 'usd', 'month')} | ${p('free', 'usd', 'year')} |\n| Plus | ${p('plus', 'jpy', 'month')} | ${p('plus', 'jpy', 'year')} | ${p('plus', 'usd', 'month')} | ${p('plus', 'usd', 'year')} |\n| Team | ${p('team', 'jpy', 'month')} | ${p('team', 'jpy', 'year')} | ${p('team', 'usd', 'month')} | ${p('team', 'usd', 'year')} |\n\n- Free: ${PLAN_DISPLAY.free.storage} storage, ${PLAN_DISPLAY.free.projects} projects. New uploads stop at the storage limit. Link sharing and uploads from external members are unavailable.\n- Plus: ${PLAN_DISPLAY.plus.storage} storage, ${PLAN_DISPLAY.plus.projects} projects. Per-artifact link sharing with expiration settings and uploads from external members are included.\n- Team: ${PLAN_DISPLAY.team.storage} storage, unlimited projects. Link sharing and uploads from external members include workspace-wide controls.\n- Active Plus and Team subscriptions can continue beyond included storage for ${formatStorageOveragePrice('jpy')} per GB-month or ${formatStorageOveragePrice('usd')} per GB-month.\n- Paid-plan prices exclude tax. Yearly plans are billed once per year.\n\nSee [pricing](https://artifactshare.com/pricing).\n`
}
