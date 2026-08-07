import type { Locale } from '~/i18n/messages'

const GETTING_STARTED_COPY = {
  en: {
    eyebrow: 'Get started',
    heading: 'Share a file and get a share link',
    lead: 'Share with Web, CLI, or MCP. The Free plan requires no credit card.',
    web: {
      title: 'Upload from your browser',
      body: 'Choose HTML, Markdown, or a folder in your browser. If you’re signed out, sign in and you’ll continue to the upload dialog.',
      cta: 'Open upload',
    },
    cli: {
      title: 'Share with the CLI',
      body: 'Use the CLI with Codex, Claude Code, or Cursor Agent to share local files, folders, and multi-file sites.',
      cta: 'Set up the CLI',
    },
    mcp: {
      title: 'Share from chat',
      body: 'Share a single HTML or Markdown file from a chat in Claude, ChatGPT, or Cursor.',
      cta: 'Connect MCP',
    },
    note: 'You don’t need a project to share your first file. You can use one later to organize your files.',
  },
  ja: {
    eyebrow: 'Artifact Share を始める',
    heading: 'ファイルを共有して、共有リンクを受け取る',
    lead: 'Web、CLI、MCP のいずれかから投稿できます。無料プランはカード登録なしで始められます。',
    web: {
      title: 'ブラウザからアップロード',
      body: 'ブラウザで HTML、Markdown、フォルダを選んでアップロードします。ログインしていない場合は、ログイン後にそのままアップロード画面へ進みます。',
      cta: 'アップロードを開く',
    },
    cli: {
      title: 'CLI で投稿',
      body: 'Codex、Claude Code、Cursor Agent では、CLI からローカルのファイル、フォルダ、複数ファイルのサイトを共有できます。',
      cta: 'CLI をセットアップ',
    },
    mcp: {
      title: 'チャットから投稿',
      body: 'Claude、ChatGPT、Cursor のチャットから、単一の HTML または Markdown を投稿します。',
      cta: 'MCP を接続',
    },
    note: '最初のファイルを共有するときに、プロジェクトは必要ありません。あとからファイルを整理するときに使えます。',
  },
} as const satisfies Record<
  Locale,
  {
    eyebrow: string
    heading: string
    lead: string
    web: { title: string; body: string; cta: string }
    cli: { title: string; body: string; cta: string }
    mcp: { title: string; body: string; cta: string }
    note: string
  }
>

export type GettingStartedCopy = (typeof GETTING_STARTED_COPY)[Locale]

export function gettingStartedCopy(locale: Locale): GettingStartedCopy {
  return GETTING_STARTED_COPY[locale]
}
