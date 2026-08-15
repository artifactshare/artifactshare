import screenScenarioIds from './screen-scenarios.json' with { type: 'json' }

export const screenScenarioAllowlist = new Set(screenScenarioIds)

const defaultState = (description) => ({
  id: 'default',
  description,
  setup: {},
})

export const screens = [
  {
    id: 'landing',
    route: { en: '/', ja: '/ja' },
    auth: 'anonymous',
    loop: 'support',
    metric: '製品理解を高め、利用開始につなげる',
    role: 'サービスの価値と入口を伝える',
    primaryAction: 'サービスを始める',
    states: [defaultState('通常のランディング')],
  },
  {
    id: 'about',
    route: { en: '/about', ja: '/ja/about' },
    auth: 'anonymous',
    loop: 'support',
    metric: '製品理解から利用開始への転換を高める',
    role: '製品の考え方と使いどころを伝える',
    primaryAction: 'サービスを始める',
    states: [defaultState('通常の About')],
  },
  {
    id: 'connect',
    route: { en: '/connect', ja: '/ja/connect' },
    auth: 'anonymous',
    loop: 'share',
    metric: '外部連携による共有利用を増やす',
    role: '外部サービスとの接続価値を伝える',
    primaryAction: '接続方法を見る',
    states: [defaultState('通常の Connect')],
  },
  {
    id: 'pricing',
    route: { en: '/pricing', ja: '/ja/pricing' },
    auth: 'anonymous',
    loop: 'support',
    metric: '適切なプラン選択を増やす',
    role: '料金とプランの違いを比較できる',
    primaryAction: 'プランを選ぶ',
    states: [defaultState('通常の Pricing')],
  },
  {
    id: 'privacy',
    route: { en: '/privacy', ja: '/ja/privacy' },
    auth: 'anonymous',
    loop: 'support',
    metric: '安心して共有を始められる理解を増やす',
    role: 'プライバシー方針を示す',
    primaryAction: '内容を確認する',
    states: [defaultState('通常の Privacy')],
  },
  {
    id: 'terms',
    route: { en: '/terms', ja: '/ja/terms' },
    auth: 'anonymous',
    loop: 'support',
    metric: '利用条件の理解を支える',
    role: '利用規約を示す',
    primaryAction: '内容を確認する',
    states: [defaultState('通常の Terms')],
  },
  {
    id: 'tokushoho',
    route: { en: '/tokushoho', ja: '/ja/tokushoho' },
    auth: 'anonymous',
    loop: 'support',
    metric: '購入前の不安を減らす',
    role: '特定商取引法に基づく表示を示す',
    primaryAction: '内容を確認する',
    states: [defaultState('通常の Tokushoho')],
  },
  {
    id: 'share-with-ai',
    route: { en: '/share-with-ai', ja: '/ja/share-with-ai' },
    auth: 'anonymous',
    loop: 'share',
    metric: 'AIを介した共有利用を増やす',
    role: 'AIとの共有方法を伝える',
    primaryAction: '共有方法を見る',
    states: [defaultState('通常の Share with AI')],
  },
  {
    id: 'start',
    route: { en: '/start', ja: '/ja/start' },
    auth: 'anonymous',
    loop: 'create',
    metric: '初回作成への到達率を高める',
    role: '利用開始の手順を案内する',
    primaryAction: 'アカウントを作る',
    states: [defaultState('通常の Start')],
  },
  {
    id: 'updates',
    route: { en: '/updates', ja: '/ja/updates' },
    auth: 'anonymous',
    loop: 'support',
    metric: '継続的な関心と再訪を増やす',
    role: '製品更新を一覧で知らせる',
    primaryAction: '更新を読む',
    states: [defaultState('更新一覧')],
  },
  {
    id: 'updates-detail',
    route: { en: '/updates/{seed:update}', ja: '/ja/updates/{seed:update}' },
    auth: 'anonymous',
    loop: 'support',
    metric: '更新内容の理解を深める',
    role: '製品更新の詳細を伝える',
    primaryAction: '次の更新を見る',
    states: [defaultState('更新詳細')],
  },
  {
    id: 'guides-cli',
    route: { en: '/guides/cli', ja: '/ja/guides/cli' },
    auth: 'anonymous',
    loop: 'create',
    metric: 'CLI利用による作成を増やす',
    role: 'CLIの使い方を案内する',
    primaryAction: 'ガイドを読む',
    states: [defaultState('CLIガイド')],
  },
  {
    id: 'guides-link-sharing',
    route: { en: '/guides/link-sharing', ja: '/ja/guides/link-sharing' },
    auth: 'anonymous',
    loop: 'share',
    metric: 'リンク共有の利用を増やす',
    role: 'リンク共有の手順を案内する',
    primaryAction: 'ガイドを読む',
    states: [defaultState('リンク共有ガイド')],
  },
  {
    id: 'guides-private-mobile-design-handoff',
    route: {
      en: '/guides/private-mobile-design-handoff',
      ja: '/ja/guides/private-mobile-design-handoff',
    },
    auth: 'anonymous',
    loop: 'share',
    metric: '安全なデザイン引き継ぎを増やす',
    role: 'モバイルでの非公開共有を案内する',
    primaryAction: 'ガイドを読む',
    states: [defaultState('モバイル引き継ぎガイド')],
  },
  {
    id: 'guides-workspace-admin',
    route: { en: '/guides/workspace-admin', ja: '/ja/guides/workspace-admin' },
    auth: 'anonymous',
    loop: 'support',
    metric: 'ワークスペース運用の定着を支える',
    role: '管理者向けの運用方法を案内する',
    primaryAction: 'ガイドを読む',
    states: [defaultState('管理者ガイド')],
  },
  {
    id: 'guides-workspace-owner',
    route: { en: '/guides/workspace-owner', ja: '/ja/guides/workspace-owner' },
    auth: 'anonymous',
    loop: 'support',
    metric: 'ワークスペース導入を支える',
    role: 'オーナー向けの運用方法を案内する',
    primaryAction: 'ガイドを読む',
    states: [defaultState('オーナーガイド')],
  },
  {
    id: 'sign-in',
    route: { en: '/sign-in' },
    auth: 'anonymous',
    loop: 'create',
    metric: '再訪ユーザーの利用再開率を高める',
    role: 'メール認証で利用を再開する',
    primaryAction: 'サインインする',
    states: [
      defaultState('通常のサインイン'),
      {
        id: 'with-purpose',
        description: 'アップロード目的を引き継いだサインイン',
        setup: { query: '?intent=upload' },
      },
      {
        id: 'account-not-linked',
        description: '既存アカウントに紐づかないメールの再訪',
        setup: { query: '?error=account_not_linked' },
      },
    ],
  },
  {
    id: 'consent',
    route: { en: '/consent' },
    auth: 'anonymous',
    loop: 'support',
    metric: '認証後の接続完了率を高める',
    role: '外部接続の同意を確認する',
    primaryAction: '接続を許可する',
    states: [defaultState('通常の同意確認')],
  },
  {
    id: 'device',
    route: { en: '/device' },
    auth: 'anonymous',
    loop: 'create',
    metric: 'CLIとブラウザの接続完了率を高める',
    role: 'デバイス認証を完了する',
    primaryAction: '認証を完了する',
    states: [
      defaultState('通常のデバイス認証'),
      {
        id: 'with-code',
        description: '照合対象のデバイスコードが表示された状態',
        setup: { query: '?user_code=ABCD1234' },
      },
    ],
  },
  {
    id: 'viewer',
    route: { en: '/a/{seed:artifact}' },
    auth: 'team-owner',
    loop: 'view',
    metric: '共有成果物の閲覧と反応を増やす',
    role: '共有された成果物を閲覧する',
    primaryAction: '成果物を確認する',
    states: [
      defaultState('通常閲覧'),
      {
        id: 'intro-open',
        description: '製品紹介のHover Cardを開いた状態',
        setup: {
          interactions: [
            {
              action: 'hover',
              selector: '[aria-label="About Artifact Share"]',
            },
          ],
        },
      },
      {
        id: 'panel-collapsed',
        description: '閲覧パネルを折りたたんだ状態',
        setup: {
          interactions: [
            {
              action: 'click',
              selector: '[aria-label="Collapse Artifact Share"]',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'home',
    route: { en: '/' },
    auth: 'free-owner',
    loop: 'react',
    metric: '動きへの再訪を高める',
    role: '反応とワークスペースの動きを確認する',
    primaryAction: '動きを確認する',
    states: [
      {
        id: 'default',
        description: '新ホーム (ファイルあり)',
        setup: { scenario: 'home/content-rich' },
      },
      {
        id: 'empty',
        description: 'ファイルが空の状態',
        setup: { scenario: 'home/empty' },
      },
      {
        id: 'first-file',
        description: '最初の成果物だけがある状態',
        setup: { scenario: 'home/first-file' },
      },
      {
        id: 'updates-menu-open',
        description: '新着の更新情報をアバターメニューで確認した状態',
        setup: {
          interactions: [
            {
              action: 'click',
              selector: '[aria-label$="New updates are available"]',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'recent',
    route: { en: '/recent' },
    auth: 'free-owner',
    loop: 'view',
    metric: '再訪時の成果物発見を速める',
    role: '最近使った成果物を一覧する',
    primaryAction: '成果物を開く',
    states: [
      defaultState('最近の成果物一覧'),
      {
        id: 'content-rich',
        description: '最近使った成果物が複数ページにわたる状態',
        setup: { scenario: 'recent/content-rich', query: '?page=2' },
      },
      {
        id: 'unread-comments',
        description: '新着コメントの短文・長文・複数件を表示した状態',
        setup: { scenario: 'recent/content-rich' },
      },
    ],
  },
  {
    id: 'files',
    route: { en: '/files' },
    auth: 'free-owner',
    loop: 'view',
    metric: '自分のファイルを探しやすくする',
    role: '自分のファイルを一覧する',
    primaryAction: '成果物を開く',
    states: [
      defaultState('自分のファイル一覧'),
      {
        id: 'content-rich',
        description: '自分のファイルが複数ページにわたる状態',
        setup: { scenario: 'recent/content-rich', query: '?page=2' },
      },
    ],
  },
  {
    id: 'projects',
    route: { en: '/projects' },
    auth: 'free-owner',
    loop: 'create',
    metric: '成果物の整理と作成を増やす',
    role: 'プロジェクトを一覧する',
    primaryAction: 'プロジェクトを開く',
    states: [
      defaultState('プロジェクト一覧'),
      {
        id: 'with-membership',
        description: '参加中と参加できるプロジェクトがある状態',
        setup: { scenario: 'projects/with-membership' },
      },
      {
        id: 'empty',
        description: 'プロジェクトがない状態',
        setup: { scenario: 'projects/empty' },
      },
      {
        id: 'stress-states',
        description: 'プロジェクト一覧の各種行状態と大量行を確認する状態',
        setup: { scenario: 'projects/stress-states' },
      },
    ],
  },
  {
    id: 'project-detail',
    route: { en: '/projects/{seed:project}' },
    auth: 'free-owner',
    loop: 'create',
    metric: 'プロジェクト内の作成を増やす',
    role: 'プロジェクトの成果物を管理する',
    primaryAction: '成果物を追加する',
    states: [
      defaultState('プロジェクト詳細'),
      {
        id: 'with-files',
        description: '複数のファイルがあるプロジェクト',
        setup: { scenario: 'project-detail/with-files' },
      },
      {
        id: 'with-pins',
        description: 'ピン留めされたファイルがあるプロジェクト',
        setup: { scenario: 'project-detail/with-pins' },
      },
      {
        id: 'empty',
        description: 'ファイルがないプロジェクト',
        setup: { scenario: 'project-detail/empty' },
      },
    ],
  },
  {
    id: 'project-files',
    route: { en: '/projects/{seed:project}/files' },
    auth: 'free-owner',
    loop: 'support',
    metric: 'プロジェクト内の成果物を確認する',
    role: 'ファイルを全件確認する',
    primaryAction: 'ファイルを開く',
    states: [
      defaultState('プロジェクトのファイル全件'),
      {
        id: 'with-files',
        description: '複数の日付のファイルがある状態',
        setup: { scenario: 'project-detail/with-files' },
      },
    ],
  },
  {
    id: 'project-activity',
    route: { en: '/projects/{seed:project}/activity' },
    auth: 'free-owner',
    loop: 'support',
    metric: 'プロジェクトの動きを追う',
    role: '動きの履歴を確認する',
    primaryAction: '動きを確認する',
    states: [
      defaultState('プロジェクトの動きの履歴'),
      {
        id: 'content-rich',
        description: '代表的な動きがあるプロジェクト',
        setup: { scenario: 'project-detail/with-files' },
      },
    ],
  },
  {
    id: 'projects-archived',
    route: { en: '/projects/archived' },
    auth: 'free-owner',
    loop: 'support',
    metric: '整理後の成果物再利用を支える',
    role: 'アーカイブ済みプロジェクトを管理する',
    primaryAction: 'プロジェクトを復元する',
    states: [
      defaultState('アーカイブ一覧'),
      {
        id: 'with-archived-project',
        description: 'アーカイブ済みプロジェクトがある状態',
        setup: { scenario: 'projects-archived/with-archived-project' },
      },
    ],
  },
  {
    id: 'settings',
    route: { en: '/settings' },
    auth: 'team-owner',
    loop: 'support',
    metric: 'チーム運用の継続率を高める',
    role: 'メンバーと権限を管理する',
    primaryAction: 'メンバーを管理する',
    states: [defaultState('メンバー管理')],
  },
  {
    id: 'settings-bots',
    route: { en: '/settings/bots' },
    auth: 'team-owner',
    loop: 'support',
    metric: 'Bot運用の安全性を高める',
    role: 'Botを棚卸し認証情報を管理する',
    primaryAction: 'Botを管理する',
    states: [
      defaultState('Bot管理'),
      {
        id: 'with-bots',
        description:
          '有効・認証期限切れ・利用済み停止・未使用停止のBotメンバーがある状態',
        setup: { scenario: 'settings/with-bots' },
      },
      {
        id: 'create-bot-dialog',
        description: 'Bot作成ダイアログを開いた状態',
        setup: {
          scenario: 'settings/with-bots',
          interactions: [
            { action: 'click', selector: 'button:has-text("Add bot")' },
          ],
        },
      },
      {
        id: 'cancel-bot-dialog',
        description: '未使用Botの作成取消確認を開いた状態',
        setup: {
          scenario: 'settings/with-bots',
          interactions: [
            {
              action: 'click',
              selector: 'button:has-text("Cancel creation")',
            },
          ],
        },
      },
      {
        id: 'stop-bot-dialog',
        description: '利用済みBotの停止確認を開いた状態',
        setup: {
          scenario: 'settings/with-bots',
          interactions: [
            { action: 'click', selector: 'button:text-is("Stop")' },
          ],
        },
      },
    ],
  },
  {
    id: 'settings-general',
    route: { en: '/settings/general' },
    auth: 'team-owner',
    loop: 'support',
    metric: 'ワークスペース設定の完了率を高める',
    role: '基本設定を管理する',
    primaryAction: '設定を更新する',
    states: [defaultState('一般設定')],
  },
  {
    id: 'settings-activity',
    route: { en: '/settings/activity' },
    auth: 'team-owner',
    loop: 'support',
    metric: 'チーム活動の把握を支える',
    role: '活動履歴を確認する',
    primaryAction: '活動を確認する',
    states: [
      defaultState('活動履歴'),
      {
        id: 'with-activity',
        description: '複数の活動履歴がある状態',
        setup: { scenario: 'settings-activity/with-activity' },
      },
    ],
  },
  {
    id: 'settings-billing',
    route: { en: '/settings/billing' },
    auth: 'team-owner',
    loop: 'support',
    metric: '適切なプラン継続を支える',
    role: '契約と請求を管理する',
    primaryAction: 'プランを管理する',
    states: [
      defaultState('請求設定'),
      {
        id: 'subscribed',
        description: '有効な Team 契約がある状態',
        setup: { scenario: 'settings-billing/subscribed' },
      },
    ],
  },
  {
    id: 'settings-external-access',
    route: { en: '/settings/external-access' },
    auth: 'team-owner',
    loop: 'share',
    metric: '安全な外部共有を支える',
    role: '外部アクセスを管理する',
    primaryAction: 'アクセスを設定する',
    states: [defaultState('外部アクセス')],
  },
  {
    id: 'settings-integrations',
    route: { en: '/settings/integrations' },
    auth: 'team-owner',
    loop: 'share',
    metric: '連携による共有利用を増やす',
    role: '連携サービスを管理する',
    primaryAction: '連携を設定する',
    states: [
      defaultState('連携設定'),
      {
        id: 'slack-connected',
        description: 'Slack が接続済みの状態',
        setup: { scenario: 'settings-integrations/slack-connected' },
      },
    ],
  },
  {
    id: 'settings-inventory-projects',
    route: { en: '/settings/inventory/projects' },
    auth: 'team-owner',
    loop: 'support',
    metric: '運営対象の棚卸しを支える',
    role: 'プロジェクトを棚卸しする',
    primaryAction: 'プロジェクトを確認する',
    states: [defaultState('プロジェクト棚卸し')],
  },
  {
    id: 'settings-inventory-artifacts',
    route: { en: '/settings/inventory/artifacts' },
    auth: 'team-owner',
    loop: 'support',
    metric: '成果物の棚卸しを支える',
    role: '成果物を棚卸しする',
    primaryAction: '成果物を確認する',
    states: [defaultState('成果物棚卸し')],
  },
  {
    id: 'settings-tokens',
    route: { en: '/settings/tokens' },
    auth: 'team-owner',
    loop: 'create',
    metric: 'CLI利用の継続を支える',
    role: 'アクセストークンを管理する',
    primaryAction: 'トークンを作成する',
    states: [
      defaultState('トークン設定'),
      {
        id: 'created-secret',
        description: '作成直後のシークレットを表示する状態',
        setup: { scenario: 'settings-tokens/created-secret' },
      },
    ],
  },
  {
    id: 'settings-cli-sessions',
    route: { en: '/settings/cli-sessions' },
    auth: 'team-owner',
    loop: 'support',
    metric: 'CLI利用の安全性を高める',
    role: 'CLIセッションを棚卸し失効する',
    primaryAction: 'CLIセッションを管理する',
    states: [
      defaultState('CLIセッション管理'),
      {
        id: 'active-cli',
        description: '有効なCLIセッションを表示する状態',
        setup: { scenario: 'settings-tokens/active-cli' },
      },
    ],
  },
  {
    id: 'settings-usage',
    route: { en: '/settings/usage' },
    auth: 'team-owner',
    loop: 'support',
    metric: '利用状況にもとづく継続を支える',
    role: '利用状況を確認する',
    primaryAction: '利用状況を見る',
    states: [
      defaultState('利用状況'),
      {
        id: 'near-limit',
        description: '保存容量が上限に近い状態',
        setup: { scenario: 'settings-usage/near-limit' },
      },
    ],
  },
]

const values = {
  auth: new Set([
    'anonymous',
    'free-owner',
    'plus-owner',
    'team-owner',
    'team-member',
  ]),
  loop: new Set([
    'create',
    'post',
    'share',
    'view',
    'react',
    'repost',
    'support',
  ]),
}

// UI leaf route ではない、または dev persona から到達できない route の明示除外。
// 機械的な除外 (api./dev./og-image 等) は scripts/check-screen-ledger.mjs が持つ。
export const excludedRoutes = [
  {
    file: '_home/_protected/activity.tsx',
    reason: '廃止したグローバル activity URL からホームへの無条件 redirect',
  },
  {
    file: '_protected/connect.slack.tsx',
    reason: 'loader が常に text Response を返すデータ専用 route',
  },
  {
    file: '_protected/projects.$id.slack.tsx',
    reason: 'Slack 通知ダイアログが利用する loader/action 専用 route',
  },
  {
    file: '_protected/integrations.slack.install.tsx',
    reason: 'Slack OAuth への無条件 redirect',
  },
  {
    file: '_protected/projects.$id.slack.install.tsx',
    reason: 'プロジェクトの Slack 通知認可への無条件 redirect',
  },
  {
    file: '_protected/settings/billing-preview.tsx',
    reason: 'data のみを返す loader で UI を描画しない',
  },
  {
    file: '_protected/settings/recipients.tsx',
    reason: 'RecipientPicker が利用する JSON 専用 route で UI を描画しない',
  },
  {
    file: '_protected/settings/inventory/index.tsx',
    reason: 'inventory/projects への無条件 redirect',
  },
  {
    file: 'notice-updates.tsx',
    reason: '更新通知を既読化する POST data route で UI を描画しない',
  },
]

export function validateLedger(
  ledgerScreens = screens,
  scenarioAllowlist = screenScenarioAllowlist,
) {
  const ids = new Set()
  for (const screen of ledgerScreens) {
    if (ids.has(screen.id)) throw new Error(`duplicate screen id: ${screen.id}`)
    ids.add(screen.id)
    if (!values.auth.has(screen.auth))
      throw new Error(`invalid auth for ${screen.id}`)
    if (!values.loop.has(screen.loop))
      throw new Error(`invalid loop for ${screen.id}`)
    if (!Array.isArray(screen.states) || screen.states.length === 0)
      throw new Error(`states required for ${screen.id}`)
    const stateIds = new Set()
    for (const state of screen.states) {
      if (stateIds.has(state.id))
        throw new Error(`duplicate state id: ${screen.id}/${state.id}`)
      stateIds.add(state.id)
      if (state.setup?.scenario && !scenarioAllowlist.has(state.setup.scenario))
        throw new Error(`unknown scenario: ${state.setup.scenario}`)
    }
  }
  return true
}
