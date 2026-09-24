import ViewerRoute, { ErrorBoundary as ViewerErrorBoundary } from './+viewer'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'viewer',
  route: {
    en: '/a/{seed:artifact}',
  },
  auth: 'team-owner',
  loop: 'view',
  metric: '共有成果物の閲覧と反応を増やす',
  role: '共有された成果物を閲覧する',
  primaryAction: '成果物を確認する',
  captureConcurrency: 1,
  ready: {
    selector: '[data-sandbox-state="ready"]',
    description: 'sandbox frame ready',
    timeoutMs: 30_000,
  },
  states: [
    {
      id: 'default',
      description: '通常閲覧',
      setup: {},
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
    {
      id: 'comments-open',
      description:
        '長い投稿者名、エージェント名、本文を含むコメントパネルを開いた状態',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: 'button[aria-label="Comments"]',
          },
        ],
      },
    },
    {
      id: 'anonymous',
      description: '未認証の共有リンク受け手が Viewer を開いた状態',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'anonymous-origin-info',
      description:
        '未認証のリンク共有 Viewer で作成者横の ⓘ から出所説明と通報導線を開いた状態',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-link-origin-trigger]',
          },
        ],
      },
    },
    {
      id: 'anonymous-report-dialog',
      description:
        '未認証のリンク共有 Viewer で ⓘ から通報ダイアログを開いた状態',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-link-origin-trigger]',
          },
          {
            action: 'click',
            selector: '[data-link-report-trigger]',
          },
        ],
      },
    },
    {
      id: 'link-suspended-owner',
      description:
        '運営がリンク共有を一時停止したファイルを owner が開き、理由と異議フォームのバナーが出ている状態',
      setup: {
        scenario: 'viewer/link-suspended',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'link-suspended-anonymous',
      description:
        '一時停止中のリンク共有を未認証で開いたときの「一時停止中」ページ',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'viewer/link-suspended',
        scenarioArtifactIndex: 1,
        ready: {
          selector: '[data-screen-capture-state="link-suspended"]',
          description: 'paused link page',
        },
      },
    },
    {
      id: 'visibility-dialog',
      description:
        'Team プランのオーナーが共有範囲ダイアログでリンク共有と期限を確認する状態',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-viewer-more-menu-trigger]',
          },
          {
            action: 'click',
            selector: '[role="menuitem"]:has-text("Change who can view")',
          },
        ],
      },
    },
    {
      id: 'free-owner-visibility-dialog',
      description:
        'Free プランのオーナーが共有範囲ダイアログでリンク共有を選べる状態',
      setup: {
        auth: 'free-owner',
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-viewer-more-menu-trigger]',
          },
          {
            action: 'click',
            selector: '[role="menuitem"]:has-text("Change who can view")',
          },
        ],
      },
    },
    {
      id: 'bridge-attribution',
      description: 'bridge 経由の投稿で依頼者と bot の帰属を表示する状態',
      setup: {
        scenario: 'viewer/bridge-attribution',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'bridge-attribution-details',
      description: 'bridge 経由の投稿で依頼者トリガーから共有詳細を開いた状態',
      setup: {
        scenario: 'viewer/bridge-attribution',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-bridge-attribution-trigger]:visible',
          },
        ],
      },
    },
    {
      id: 'bridge-attribution-anonymous',
      description:
        '未認証の共有リンク受け手にも bridge の依頼者名と bot 帰属を表示する状態',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'viewer/bridge-attribution',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'bridge-attribution-email-fallback',
      description:
        '依頼者名がない認証済み Viewer で検証済みメールを帰属表示へ補完する状態',
      setup: {
        scenario: 'viewer/bridge-attribution',
        scenarioArtifactIndex: 1,
        query: '?bridgeRequester=email',
      },
    },
    {
      id: 'bridge-attribution-email-hidden-anonymous',
      description: '依頼者名がない未認証 Viewer で依頼者メールを表示しない状態',
      setup: {
        auth: 'anonymous',
        seedAuth: 'team-owner',
        scenario: 'viewer/bridge-attribution',
        scenarioArtifactIndex: 1,
        query: '?bridgeRequester=email',
      },
    },
    {
      id: 'viewer-list-open',
      description:
        '「…」メニューから閲覧した人パネルを開いた状態 (シード追加により既存 viewer/comments-open の capture も変わる)',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
        interactions: [
          {
            action: 'click',
            selector: '[data-viewer-more-menu-trigger]',
          },
          {
            action: 'click',
            selector: '[data-viewer-list-menu-item]',
          },
          {
            action: 'click',
            selector: '[data-slot="sheet-title"]',
          },
        ],
      },
    },
    {
      id: 'history-open',
      description:
        '「…」メニューからラベル付きとラベルなしの版を履歴パネルで確認する状態',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 21,
        interactions: [
          {
            action: 'click',
            selector: '[data-viewer-more-menu-trigger]',
          },
          {
            action: 'click',
            selector: '[data-viewer-history-menu-item]',
          },
          {
            action: 'click',
            selector: '[data-slot="sheet-title"]',
          },
        ],
      },
    },
    {
      id: 'viewer-list-entry',
      description:
        'メタ行の閲覧した人セグメントが phone の閉状態でも見える状態 (interaction なし。シード追加により既存 viewer/comments-open の capture も変わる)',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'updated-return',
      description: '前回閲覧後に更新された2版の成果物へ戻った状態',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 21,
      },
    },
    {
      id: 'revisit-context',
      description:
        '3スレッドの成果物で、前回閲覧後の版更新と新着コメント2件を案内する状態',
      setup: {
        scenario: 'viewer/revisit-context',
        scenarioArtifactIndex: 1,
      },
    },
    {
      id: 'updated-version-menu',
      description: '前回閲覧後に更新された成果物の版メニューを開いた状態',
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 21,
        interactions: [
          {
            action: 'click',
            selector: 'button[aria-label="Version status: v2"]',
          },
        ],
      },
    },
  ],
} satisfies ScreenSpec

export { loader } from './+loader.server'
export { meta, AgentHelpContent, buildPreauthCliOpenCommand } from './+viewer'

// Direct component exports let React Router inject loader and error props.
export default ViewerRoute
export const ErrorBoundary = ViewerErrorBoundary
