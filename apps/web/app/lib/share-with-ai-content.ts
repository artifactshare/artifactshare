import type { Locale } from '~/i18n/messages'
import {
  CONNECT_CHATGPT_ANCHOR,
  CONNECT_CLAUDE_ANCHOR,
  CONNECT_CURSOR_ANCHOR,
  CONNECT_AI_AGENTS_ANCHOR,
} from './connect-link'

export type TaskRoute = 'mcp' | 'cli'

export interface ShareTask {
  id: string
  title: string
  routes: TaskRoute[]
  ask: string
  output: string
  detail: string
}

interface ConnectNextLink {
  anchor: string
  label: string
  path?: string
}

interface Note {
  label: string
  body: string
}

export interface ShareWithAiContent {
  title: string
  intro: string
  connectLead: { before: string; link: string; after: string }
  tasksHeading: string
  tasksIntro: string
  detailLabel: string
  askLabel: string
  outputLabel: string
  tasks: ShareTask[]
  routeBadges: Record<TaskRoute, string>
  nextHeading: string
  nextConnectHeading: string
  nextConnectLinks: ConnectNextLink[]
  notesHeading: string
  noteItems: Note[]
  copyLabels: {
    copy: string
    copied: string
    failed: string
  }
  tocTitle: string
  og: {
    title: string
    description: string
  }
}

const EN: ShareWithAiContent = {
  title: 'Use Artifact Share with AI',
  intro:
    'Artifact Share turns HTML made by AI into browser links your team can open. Markdown, folders, and static sites work too. The same link can be updated, commented on, and organized into projects.',
  connectLead: {
    before: 'Set up MCP or the CLI from the ',
    link: 'connect guide',
    after: '.',
  },
  tasksHeading: 'What you can do',
  tasksIntro:
    'Just tell your AI what you want. "as" works in place of "Artifact Share" when the request is about sharing, updating, opening, or reading back a share link.',
  detailLabel: 'Details',
  askLabel: 'Prompt',
  outputLabel: 'Output',
  tasks: [
    {
      id: 'share',
      title: 'Share a file',
      routes: ['mcp', 'cli'],
      ask: 'Share this report on Artifact Share.',
      output:
        '✓ Shared — https://artifactshare.com/a/abc123 (visible to your org)',
      detail:
        'Turns an HTML or Markdown file into a browser link your team can open. MCP handles a single HTML or Markdown file; for folders or image-heavy sites, use the CLI.',
    },
    {
      id: 'update',
      title: 'Replace while keeping the same URL',
      routes: ['mcp', 'cli'],
      ask: 'Update the as link with this new version.',
      output: '✓ Updated to v2. Same URL — https://artifactshare.com/a/abc123',
      detail:
        'Replaces the content behind the same URL. Anyone with the link always sees the latest version.',
    },
    {
      id: 'comment',
      title: 'Check comments and reply',
      routes: ['mcp', 'cli'],
      ask: 'Check comments on my as file and reply.',
      output:
        'Summarized 1 open item "Fix the graph units" and replied to 1 thread.',
      detail:
        'Reads comments left on the shared page, summarizes them, and can post replies.',
    },
    {
      id: 'organize',
      title: 'Organize into projects',
      routes: ['mcp', 'cli'],
      ask: 'Move this to the Q3 Report project on as.',
      output: 'Moved to project "Q3 Report".',
      detail: 'Groups related files into a project so they are easier to find.',
    },
    {
      id: 'visibility',
      title: 'Change who can view',
      routes: ['mcp', 'cli'],
      ask: 'Make this file private. https://artifactshare.com/a/abc123',
      output: '✓ Changed to private (project members only).',
      detail:
        'Switches who can see the page — the whole workspace or project members only.',
    },
    {
      id: 'publish-site',
      title: 'Publish a folder or static site',
      routes: ['cli'],
      ask: 'Share this site folder on as.',
      output: '✓ Shared site — https://artifactshare.com/a/def456',
      detail:
        'Uploads a folder with linked HTML files and images as a browsable site. Good for multi-page reports with relative links between pages. Up to 25 MB.',
    },
    {
      id: 'download',
      title: 'Download a shared file',
      routes: ['cli'],
      ask: 'Download this file. https://artifactshare.com/a/abc123',
      output: '✓ Downloaded to ./report.html',
      detail: 'Saves the shared file to your local machine.',
    },
  ],
  routeBadges: {
    mcp: 'MCP',
    cli: 'CLI',
  },
  nextHeading: 'Next steps',
  nextConnectHeading: 'Connect or set up',
  nextConnectLinks: [
    { path: '/guides/cli', anchor: '', label: 'CLI reference' },
    { path: '/guides/link-sharing', anchor: '', label: 'Link sharing guide' },
    {
      anchor: CONNECT_AI_AGENTS_ANCHOR,
      label: 'Set up the CLI for Codex, Claude Code, or Cursor Agent',
    },
    { anchor: CONNECT_CLAUDE_ANCHOR, label: 'Connect in Claude' },
    { anchor: CONNECT_CHATGPT_ANCHOR, label: 'Connect in ChatGPT' },
    { anchor: CONNECT_CURSOR_ANCHOR, label: 'Connect in Cursor' },
  ],
  notesHeading: 'Good to know',
  noteItems: [
    {
      label: 'CLI for Codex, Claude Code, and Cursor Agent',
      body: 'Use the CLI to share local files, folders, and multi-file sites.',
    },
    {
      label: 'Multiple Google accounts',
      body: 'If you switch between Google accounts often, the CLI is usually easier than chat connectors.',
    },
    {
      label: 'Chat connectors',
      body: 'MCP in chat works best for one small file at a time. For folders or larger sites, use the CLI route.',
    },
  ],
  copyLabels: {
    copy: 'Copy prompt',
    copied: 'Copied',
    failed: 'Copy failed',
  },
  tocTitle: 'On this page',
  og: {
    title: 'Use Artifact Share with AI',
    description:
      'Turn AI-made HTML into browser links. Use the CLI with Codex, Claude Code, or Cursor Agent, or remote MCP with Claude, ChatGPT, Cursor chat, or Claude Cowork.',
  },
}

const JA: ShareWithAiContent = {
  title: 'AI から Artifact Share を使う',
  intro:
    'Artifact Share は、AI が作った HTML をブラウザで開けるリンクにします。Markdown、フォルダ、静的サイトにも対応。同じ URL で次の版へ更新し、コメントやプロジェクト整理も使えます。',
  connectLead: {
    before: 'はじめかたは',
    link: '接続ガイド',
    after: 'をどうぞ。',
  },
  tasksHeading: 'できること',
  tasksIntro:
    'やりたいことを AI に伝えるだけで使えます。「as で共有して」で Artifact Share と通じます。',
  detailLabel: '解説',
  askLabel: 'プロンプト',
  outputLabel: '出力例',
  tasks: [
    {
      id: 'share',
      title: 'ファイルを共有する',
      routes: ['mcp', 'cli'],
      ask: 'このレポートを as で共有して。',
      output:
        '✓ 共有しました — https://artifactshare.com/a/abc123（社内に共有）',
      detail:
        'HTML や Markdown をブラウザで開けるリンクにします。MCP は単一の HTML / Markdown ファイルのみ。フォルダや画像を含むサイトは CLI で共有できます。',
    },
    {
      id: 'update',
      title: '同じ URL で次の版へ更新する',
      routes: ['mcp', 'cli'],
      ask: 'as のリンクをこの新しい版に更新して。',
      output:
        '✓ v2 に更新しました。URL は同じ — https://artifactshare.com/a/abc123',
      detail:
        '同じ URL で次の版へ更新します。リンクを受け取った人は常に最新版を見られます。',
    },
    {
      id: 'comment',
      title: 'コメントを確認して返信する',
      routes: ['mcp', 'cli'],
      ask: 'as のコメントを確認して返信して。',
      output:
        '未解決 1 件「グラフの単位を直して」を要約し、1 件に返信しました。',
      detail: '共有ページに付いたコメントを読んで要約し、返信もできます。',
    },
    {
      id: 'organize',
      title: 'プロジェクトに整理する',
      routes: ['mcp', 'cli'],
      ask: 'これを as の Q3 レポートプロジェクトに入れて。',
      output: 'Q3 レポートプロジェクトに移動しました。',
      detail:
        '関連するファイルをプロジェクト単位でまとめると探しやすくなります。',
    },
    {
      id: 'visibility',
      title: '共有範囲を変える',
      routes: ['mcp', 'cli'],
      ask: 'このファイルを関係者のみにして。 https://artifactshare.com/a/abc123',
      output: '✓ プロジェクトの関係者のみに変更しました。',
      detail: '社内全員かプロジェクトの関係者のみかを切り替えられます。',
    },
    {
      id: 'publish-site',
      title: 'フォルダ・静的サイトを共有する',
      routes: ['cli'],
      ask: 'このサイトフォルダを as で共有して。',
      output: '✓ サイトを共有しました — https://artifactshare.com/a/def456',
      detail:
        '相対リンクでつながった複数の HTML や画像素材をフォルダごとまとめて共有します。ブラウザでそのまま閲覧できます。最大 25 MB。',
    },
    {
      id: 'download',
      title: '共有ファイルをダウンロードする',
      routes: ['cli'],
      ask: 'このファイルをダウンロードして。 https://artifactshare.com/a/abc123',
      output: '✓ ./report.html にダウンロードしました',
      detail: '共有ページのファイルをローカルに保存します。',
    },
  ],
  routeBadges: {
    mcp: 'MCP',
    cli: 'CLI',
  },
  nextHeading: '次の行動',
  nextConnectHeading: '接続・セットアップ',
  nextConnectLinks: [
    { path: '/guides/cli', anchor: '', label: 'CLI リファレンス' },
    {
      path: '/guides/link-sharing',
      anchor: '',
      label: 'リンク共有ガイド',
    },
    {
      anchor: CONNECT_AI_AGENTS_ANCHOR,
      label: 'Codex、Claude Code、Cursor Agent に CLI をセットアップ',
    },
    { anchor: CONNECT_CLAUDE_ANCHOR, label: 'Claude で接続' },
    { anchor: CONNECT_CHATGPT_ANCHOR, label: 'ChatGPT で接続' },
    { anchor: CONNECT_CURSOR_ANCHOR, label: 'Cursor で接続' },
  ],
  notesHeading: '補足',
  noteItems: [
    {
      label: 'Codex、Claude Code、Cursor Agent の CLI',
      body: 'CLI からローカルのファイル、フォルダ、複数ファイルのサイトを共有できます。',
    },
    {
      label: '複数の Google アカウント',
      body: 'Google アカウントを切り替えることが多い場合は、チャット接続より CLI の方が扱いやすいことが多いです。',
    },
    {
      label: 'チャット接続',
      body: 'チャットの MCP は小さな 1 ファイル向きです。フォルダや大きなサイトは CLI ルートを使ってください。',
    },
  ],
  copyLabels: {
    copy: '例文をコピー',
    copied: 'コピーしました',
    failed: 'コピーに失敗しました',
  },
  tocTitle: 'このページの内容',
  og: {
    title: 'AI から Artifact Share を使う',
    description:
      'AI が作った HTML をブラウザで開けるリンクに。Codex、Claude Code、Cursor Agent では CLI、Claude、ChatGPT、Cursor のチャット、Claude Cowork では remote MCP を使えます。',
  },
}

export function shareWithAiContent(locale: Locale): ShareWithAiContent {
  return locale === 'ja' ? JA : EN
}
