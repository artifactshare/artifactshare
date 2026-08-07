import type { Locale } from '~/i18n/messages'
import { CONNECT_AI_AGENTS_ANCHOR } from './connect-link'
import {
  claudeCustomConnectorUrl,
  cursorMcpInstallUrl,
  MCP_CONNECTOR_URL,
} from './mcp-metadata'

// Install links are built from the MCP server URL so they can never drift from
// MCP_CONNECTOR_URL.
export const CLAUDE_INSTALL_URL = claudeCustomConnectorUrl(
  'Artifact Share',
  MCP_CONNECTOR_URL,
)
export const CURSOR_INSTALL_URL = cursorMcpInstallUrl(
  'Artifact Share',
  MCP_CONNECTOR_URL,
)

const cursorMcpJson = `{
  "mcpServers": {
    "Artifact Share": { "url": "${MCP_CONNECTOR_URL}" }
  }
}`

const aiAgentSnippetCommands = {
  init: 'npx --yes @artifactshare/cli init',
  ci: 'ARTIFACTSHARE_TOKEN=your_token npx --yes @artifactshare/cli share ./report.html',
}

// Step numbers match the AI agents section's step order.
const enAiAgentSnippets = [
  { step: 1, code: aiAgentSnippetCommands.init, name: 'Prompt' },
]

const jaAiAgentSnippets = [
  { step: 1, code: aiAgentSnippetCommands.init, name: 'プロンプト' },
]

interface Note {
  label: string
  body: string
  code?: string
  codeName?: string
}

interface Choice {
  label: string
  badge: string
  body: string
  href: string
  linkLabel: string
}

interface CopyLabels {
  copy: string
  copied: string
  failed: string
}

export type ConnectStep =
  | string
  | {
      text: string
      link?: { href: string; label: string }
      after?: string
      substeps?: string[]
    }

interface Host {
  id: string
  heading: string
  /** Optional install-link block shown before the manual steps. */
  oneClick?: {
    lead: string
    label: string
    href: string
    dialog: string
    fallbackLead: string
  }
  /** Eligibility paragraph shown before the steps. */
  lead?: string
  /** Additional caution shown before the steps. */
  note?: string
  steps: ConnectStep[]
  /** Cursor only: the `mcp.json` form. */
  codeBlock?: string
  /** Filename label shown on the code block's tab. */
  codeBlockName?: string
  /** 1-based step number to place the code block under. */
  codeBlockStep?: number
  /** 1-based step number to place the MCP server URL under. */
  urlStep?: number
  /** Shell command snippets attached to specific steps (1-based). */
  snippets?: { step: number; code: string; name: string }[]
}

/** Open Graph copy for the /connect page: the meta tags and the social card. */
interface OgContent {
  title: string
  description: string
  cardHeadline: string
  cardSubhead: string
}

interface GuideFreshnessContent {
  targetUi: string
  note: string
}

export interface ConnectContent {
  title: string
  intro: string
  /** One line on what the connector can do, beyond publishing. */
  capabilities: string
  guideFreshness: GuideFreshnessContent
  choiceHeading: string
  choices: Choice[]
  guideLead: string
  guideLinkLabel: string
  copyLabels: CopyLabels
  codeCopyLabels: CopyLabels
  commandCopyLabels: CopyLabels
  notesHeading: string
  notes: Note[]
  hosts: Host[]
  og: OgContent
}

const EN: ConnectContent = {
  title: 'Connect Artifact Share to your AI',
  intro:
    'Artifact Share turns HTML made by AI into browser links. It also supports Markdown, folders, and static sites, with content replacement without changing the URL, history, comments, and project organization.',
  capabilities:
    'Use the CLI with Codex, Claude Code, and Cursor Agent. Connect Claude, ChatGPT, Cursor chat, and Claude Cowork through remote MCP.',
  guideFreshness: {
    targetUi: 'ChatGPT Web',
    note: 'ChatGPT MCP apps work only on ChatGPT Web and are not supported on mobile.',
  },
  choiceHeading: 'Choose your entry point',
  choices: [
    {
      label: 'AI agents',
      badge: 'CLI',
      body: 'Use the CLI with Codex, Claude Code, or Cursor Agent to share local files, folders, and multi-file sites.',
      href: `#${CONNECT_AI_AGENTS_ANCHOR}`,
      linkLabel: 'Start with the CLI',
    },
    {
      label: 'AI chat',
      badge: 'MCP',
      body: 'Connect the Artifact Share MCP server in Claude, ChatGPT, or Cursor chat. Handy when you want to quickly share something you made in the conversation.',
      href: '#claude',
      linkLabel: 'Start with MCP',
    },
  ],
  guideLead: 'Wondering what you can do once connected?',
  guideLinkLabel: 'See what you can do',
  copyLabels: {
    copy: 'Copy URL',
    copied: 'Copied',
    failed: 'Copy failed',
  },
  codeCopyLabels: {
    copy: 'Copy JSON',
    copied: 'Copied',
    failed: 'Copy failed',
  },
  commandCopyLabels: {
    copy: 'Copy command',
    copied: 'Copied',
    failed: 'Copy failed',
  },
  notesHeading: 'Notes',
  notes: [
    {
      label: 'Using more than one Google account',
      body: 'If you regularly switch between workspaces or Google accounts, the CLI is usually the clearer route because you can keep the account for each job separate. MCP connections are tied to one Google account at a time; when you connect, pick the account you want from Google’s account chooser. To switch, connect again and choose a different account.',
    },
    {
      label: 'CI and non-interactive environments',
      body: 'Use an API token instead of browser sign-in. Issue a token from Settings, then pass it with ARTIFACTSHARE_TOKEN.',
      code: aiAgentSnippetCommands.ci,
      codeName: 'Terminal',
    },
  ],
  hosts: [
    {
      id: CONNECT_AI_AGENTS_ANCHOR,
      heading: 'Set up the CLI for Codex, Claude Code, or Cursor Agent',
      lead: 'Paste this prompt into Codex, Claude Code, or Cursor Agent from your project.',
      steps: [
        'Paste this prompt into your agent from the project.',
        'When the browser opens, confirm the code, sign in with Google, and approve the CLI.',
        {
          text: 'Done. Next, see ',
          link: {
            href: '/share-with-ai',
            label: 'using Artifact Share from AI',
          },
          after: '.',
        },
      ],
      snippets: enAiAgentSnippets,
    },
    {
      id: 'claude',
      heading: 'Claude',
      oneClick: {
        lead: 'The quickest way is the prefilled connector link:',
        label: 'Add Artifact Share to Claude',
        href: CLAUDE_INSTALL_URL,
        dialog:
          'Claude opens the add-custom-connector dialog with the name and URL filled in; review them and choose "Add".',
        fallbackLead: 'If the link doesn’t open the dialog, add it by hand:',
      },
      steps: [
        'Open "Customize" in the Claude sidebar, then select "Connectors".',
        'Choose "+", then "Add custom connector".',
        'Use "Artifact Share" as the name, paste this MCP server URL, then select "Add".',
        'Select "Connect" on the connector, then sign in with Google when prompted.',
        'In a chat, open "+", then "Connectors", and turn Artifact Share on.',
      ],
      urlStep: 3,
    },
    {
      id: 'chatgpt',
      heading: 'ChatGPT',
      lead: 'Set up Artifact Share in ChatGPT Web. The entry point depends on your plan and permissions. Pro may show Plugins and Security and login, while Business, Enterprise, and Edu use Apps.',
      note: 'ChatGPT features, UI labels, and permissions may change. If your UI looks different, look for Developer mode under Plugins or Apps in Settings, or check Settings > Security and login.',
      steps: [
        'Open ChatGPT on the web.',
        {
          text: 'Follow the path for your plan and role:',
          substeps: [
            'Pro: Open Settings > Plugins. If needed, enable Developer mode under Settings > Security and login. Then return to Plugins or Apps and look for Create.',
            'Business: Workspace admins and owners open Workspace settings > Apps > Create.',
            'Enterprise / Edu: Authorized users enable Developer mode under Settings > Apps > Advanced settings, then open Apps > Create.',
          ],
        },
        'Enter Artifact Share as the name and use this MCP server URL as the MCP server endpoint.',
        'Set authentication to OAuth.',
        'Select Scan Tools and review the detected tools.',
        'Select Create.',
        'Sign in with Google when prompted.',
      ],
      urlStep: 3,
    },
    {
      id: 'cursor',
      heading: 'Cursor',
      oneClick: {
        lead: 'The quickest way is the one-click install link:',
        label: 'Add Artifact Share to Cursor',
        href: CURSOR_INSTALL_URL,
        dialog:
          'Cursor opens an "Install MCP Server" dialog with the name and URL filled in; choose "Install". Sign in with Google if prompted.',
        fallbackLead: 'If the link doesn’t open Cursor, add it by hand:',
      },
      steps: [
        'Open Cursor settings and go to "Tools & MCP".',
        'Choose "New MCP Server", or edit ~/.cursor/mcp.json directly.',
        'Register this MCP server URL as a remote server named "Artifact Share".',
        'Save. Cursor connects and shows a green indicator when it succeeds. Sign in with Google if prompted.',
      ],
      urlStep: 3,
      codeBlock: cursorMcpJson,
      codeBlockName: 'mcp.json',
      codeBlockStep: 2,
    },
  ],
  og: {
    title: 'Connect Artifact Share to your AI',
    description:
      'Bring Artifact Share into Claude, ChatGPT, or Cursor with MCP, or use the CLI from AI agents — open, share, update, comment on, and organize your work.',
    cardHeadline: 'Connect Artifact Share to your AI',
    cardSubhead:
      'MCP in Claude, ChatGPT, and Cursor — or the CLI from AI agents.',
  },
}

const JA: ConnectContent = {
  title: 'AI に Artifact Share を接続する',
  intro:
    'Artifact Share は、AI が作った HTML をブラウザで開けるリンクにするサービスです。Markdown、フォルダ、静的サイトにも対応し、同じ URL のままの差し替え、履歴、コメント、プロジェクト整理を使えます。',
  capabilities:
    'Codex、Claude Code、Cursor Agent では CLI を使います。Claude、ChatGPT、Cursor のチャット、Claude Cowork では remote MCP で接続します。',
  guideFreshness: {
    targetUi: 'ChatGPT Web',
    note: 'ChatGPT の MCP アプリは ChatGPT Web でのみ動作し、モバイルには対応していません。',
  },
  choiceHeading: '入口を選ぶ',
  choices: [
    {
      label: 'AI エージェント',
      badge: 'CLI',
      body: 'Codex、Claude Code、Cursor Agent では、CLI からローカルのファイル、フォルダ、複数ファイルのサイトを共有できます。',
      href: `#${CONNECT_AI_AGENTS_ANCHOR}`,
      linkLabel: 'CLI から始める',
    },
    {
      label: 'チャットの AI',
      badge: 'MCP',
      body: 'Claude、ChatGPT、Cursor のチャットに Artifact Share の MCP サーバを接続します。会話で作ったものを、手軽に共有したいときに便利です。',
      href: '#claude',
      linkLabel: 'MCP から始める',
    },
  ],
  guideLead: '接続して何ができるか知りたいですか？',
  guideLinkLabel: 'できることを見る',
  copyLabels: {
    copy: 'URL をコピー',
    copied: 'コピーしました',
    failed: 'コピーできません',
  },
  codeCopyLabels: {
    copy: 'JSON をコピー',
    copied: 'コピーしました',
    failed: 'コピーできません',
  },
  commandCopyLabels: {
    copy: 'コマンドをコピー',
    copied: 'コピーしました',
    failed: 'コピーできません',
  },
  notesHeading: '補足',
  notes: [
    {
      label: '複数の Google アカウントを使うとき',
      body: '仕事や Google アカウントを切り替えて使うことが多い場合は、CLI がおすすめです。仕事ごとに使うアカウントを分けやすくなります。MCP の接続は 1 つの Google アカウントに紐づくため、接続するときに Google のアカウント選択画面で使いたいアカウントを選んでください。切り替えるときは、もう一度接続して別のアカウントを選びます。',
    },
    {
      label: 'CI・非対話環境で使うとき',
      body: 'ブラウザでログインせず、API トークンを使います。設定画面でトークンを発行し、ARTIFACTSHARE_TOKEN で渡してください。',
      code: aiAgentSnippetCommands.ci,
      codeName: 'ターミナル',
    },
  ],
  hosts: [
    {
      id: CONNECT_AI_AGENTS_ANCHOR,
      heading: 'Codex、Claude Code、Cursor Agent に CLI をセットアップ',
      lead: 'プロジェクトを開いた Codex、Claude Code、Cursor Agent に、このプロンプトを貼り付けます。',
      steps: [
        'プロジェクトを開いた状態で、このプロンプトをエージェントの入力欄に貼り付けます。',
        'ブラウザが開いたら、コードを確認して Google ログインし、CLI を承認します。',
        {
          text: '完了です。次に「',
          link: {
            href: '/ja/share-with-ai',
            label: 'AI から Artifact Share を使う',
          },
          after: '」を見る。',
        },
      ],
      snippets: jaAiAgentSnippets,
    },
    {
      id: 'claude',
      heading: 'Claude',
      oneClick: {
        lead: 'いちばん簡単なのは、名前と URL が入った追加リンクです。',
        label: 'Artifact Share を Claude に追加',
        href: CLAUDE_INSTALL_URL,
        dialog:
          'Claude で「カスタムコネクタを追加」の画面が開くので、名前と URL を確認して「追加」を選びます。',
        fallbackLead: 'リンクで画面が開かない場合は、手動で追加します。',
      },
      steps: [
        'Claude のサイドメニューから「カスタマイズ」を開き、「コネクタ」を選びます。',
        '「＋」から「カスタムコネクタを追加」を選びます。',
        '名前を「Artifact Share」にし、この MCP サーバ URL を貼り付けてから「追加」を選びます。',
        'コネクタの「接続」を選び、求められたら Google ログインします。',
        'チャットでは入力欄の「＋」から「コネクタ」を開き、Artifact Share を有効にします。',
      ],
      urlStep: 3,
    },
    {
      id: 'chatgpt',
      heading: 'ChatGPT',
      lead: 'ChatGPT Web で設定します。入口はプランと権限によって異なります。Pro では「Plugins」と「セキュリティとログイン」が表示される場合があります。Business、Enterprise、Edu では「Apps」を使います。',
      note: 'ChatGPT の機能、画面名、権限は変わることがあります。表示が異なる場合は、「設定」の「Plugins」または「Apps」から「Developer mode」を探すか、「設定」>「セキュリティとログイン」を確認してください。',
      steps: [
        'ChatGPT Web を開きます。',
        {
          text: 'プランと権限に合う入口へ進みます。',
          substeps: [
            'Pro: 「設定」>「Plugins」を開きます。必要なら「設定」>「セキュリティとログイン」で「開発者モード」を有効にし、「Plugins」または「Apps」に戻って「Create」を探します。',
            'Business: 管理者またはオーナーは、「Workspace settings」>「Apps」>「Create」を開きます。',
            'Enterprise / Edu: 利用を許可されたユーザーは、「設定」>「Apps」>「Advanced settings」で「Developer mode」を有効にしてから、「Apps」>「Create」を開きます。',
          ],
        },
        '名前に Artifact Share を入力し、MCP server endpoint にこの MCP サーバ URL を設定します。',
        '認証方式に OAuth を選びます。',
        '「Scan Tools」を選び、検出されたツールを確認します。',
        '「Create」を選びます。',
        '求められたら Google にログインします。',
      ],
      urlStep: 3,
    },
    {
      id: 'cursor',
      heading: 'Cursor',
      oneClick: {
        lead: 'いちばん簡単なのはワンクリックの追加リンクです。',
        label: 'Artifact Share を Cursor に追加',
        href: CURSOR_INSTALL_URL,
        dialog:
          'Cursor で名前と URL が入った「Install MCP Server」のダイアログが開くので、「Install」を選びます。求められたら Google ログインします。',
        fallbackLead: 'リンクで Cursor が開かない場合は、手動で追加します。',
      },
      steps: [
        'Cursor の設定で「Tools & MCP」を開きます。',
        '「New MCP Server」を選ぶか、~/.cursor/mcp.json を直接編集します。',
        'この MCP サーバ URL を「Artifact Share」という名前のリモートサーバとして登録します。',
        '保存すると Cursor が接続を試み、成功すると緑の印が付きます。求められたら Google ログインします。',
      ],
      urlStep: 3,
      codeBlock: cursorMcpJson,
      codeBlockName: 'mcp.json',
      codeBlockStep: 2,
    },
  ],
  og: {
    title: 'AI に Artifact Share を接続する',
    description:
      'Claude・ChatGPT・Cursor に MCP で追加するか、AI エージェントから CLI で使えます。共有・更新・コメント・整理まで、チャットやシェルから離れずにできます。',
    cardHeadline: 'AI に Artifact Share を接続する',
    cardSubhead:
      'MCP は Claude・ChatGPT・Cursor — CLI は AI エージェントから。',
  },
}

const CONNECT: Record<Locale, ConnectContent> = { en: EN, ja: JA }

export function connectContent(locale: Locale): ConnectContent {
  return CONNECT[locale] ?? CONNECT.en
}
