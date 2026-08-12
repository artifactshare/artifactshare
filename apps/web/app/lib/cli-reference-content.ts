import type { Locale } from '~/i18n/messages'
import surface from './cli-reference-surface.generated.json'

export type CliSectionId =
  | 'introduction'
  | 'basics'
  | 'commands'
  | 'json-exit'
  | 'destinations'
  | 'recovery'
  | 'related'

export interface CliReferenceCommand {
  path: string
  role: string
  example?: string
}

export interface CliReferenceContent {
  locale: Locale
  title: string
  intro: string
  tocTitle: string
  sections: Record<CliSectionId, { title: string; body: string }>
  commandsHeading: string
  commandUsageLabel: string
  commandOptionsLabel: string
  commandExampleLabel: string
  commands: CliReferenceCommand[]
  representativeExamples: string[]
  copyLabels: { copy: string; copied: string; failed: string }
  links: {
    shareWithAi: { href: string; label: string }
    connect: { href: string; label: string }
    updates: { href: string; label: string }
    privateHandoff: { href: string; label: string }
    npm: { href: string; label: string }
  }
  og: { title: string; description: string }
}

const roleByPath: Record<string, string> = {
  append:
    'Append a local UTF-8 file to an existing single-file HTML or Markdown artifact.',
  artifacts: 'Browse and read artifacts.',
  'artifacts get': 'Read an artifact and its metadata.',
  'artifacts list':
    'List artifacts you can access, including project or home results.',
  changelog: 'Show CLI release notes.',
  comments: 'Work with comments on an artifact.',
  'comments delete': 'Delete a comment message.',
  'comments edit': 'Edit a comment message.',
  'comments list': 'List comment threads and messages.',
  'comments post': 'Post a comment, reply, or quoted comment.',
  'comments reopen': 'Reopen a resolved comment thread.',
  'comments resolve': 'Resolve a comment thread.',
  config: 'Inspect and change local CLI settings.',
  'config get': 'Read a setting at user, repository, or effective scope.',
  'config set': 'Save a setting at user or repository scope.',
  'config unset': 'Remove a setting at user or repository scope.',
  delete: 'Permanently delete an artifact.',
  doctor: 'Check authentication, configuration, and connectivity.',
  download: 'Download an artifact to a local path.',
  edit: 'Edit artifact title, visibility, grants, or destination.',
  init: 'Detect the agent, install its skill, and start setup.',
  login: 'Authorize the CLI with unrestricted or project-scoped agent access.',
  logout: 'Revoke and remove a saved credential.',
  move: 'Move an artifact to a project or home.',
  open: 'Read an Artifact Share URL and prepare the CLI skill when needed.',
  profiles: 'Manage named authentication profiles.',
  'profiles delete': 'Delete a named profile.',
  'profiles import-token':
    'Import a CI or manually issued token into a profile.',
  'profiles list': 'List saved profiles.',
  'profiles use': 'Select the active profile.',
  projects: 'Manage projects.',
  'projects create': 'Create a project.',
  'projects edit': 'Edit project details, audience, or archive state.',
  'projects list': 'List projects available to you.',
  resolve: 'Resolve a URL, ID, or other Artifact Share value.',
  share: 'Share a local file, folder, or static site.',
  skills: 'Manage the installed Artifact Share agent skill.',
  'skills ensure': 'Ensure the skill is installed for a detected tool.',
  'skills install': 'Install the skill for a selected tool.',
  'skills list': 'List installed skill targets.',
  'skills remove': 'Remove an installed skill.',
  'skills update': 'Update an installed skill.',
  update: 'Upload a new version behind an existing share URL.',
  whoami: 'Show the active account and workspace.',
}

export const CLI_REFERENCE_ENTRY_POINT = surface.commands.find(
  (command) => command.path === '',
)!

export const CLI_REFERENCE_PUBLIC_COMMANDS = surface.commands.filter(
  (command) => command.path !== '',
)

export const CLI_OUTPUT_SCHEMA_VERSION = 2

const CLI_REFERENCE_INVOCATION = 'npx --yes @artifactshare/cli'

export const CLI_REFERENCE_EXAMPLES: Record<string, string> = {
  init: 'npx --yes @artifactshare/cli init --json',
  share: 'npx --yes @artifactshare/cli share ./report.html --json',
  update:
    'npx --yes @artifactshare/cli update <artifact-id-or-url> ./report.html --json',
  append:
    'npx --yes @artifactshare/cli append <artifact-id-or-url> ./section.md --json',
  open: 'npx --yes @artifactshare/cli open <artifact-id-or-url> --json',
  'config get':
    'npx --yes @artifactshare/cli config get home_audience --scope effective --json',
  'config set':
    'npx --yes @artifactshare/cli config set home_audience private --scope user --json',
  login:
    'npx --yes @artifactshare/cli login --profile agent --preset agent --json',
  'profiles import-token':
    'printf \'%s\' "$ARTIFACTSHARE_TOKEN" | npx --yes @artifactshare/cli profiles import-token --profile ci --json',
}

export function cliReferenceUsage(path: string, usage: string): string {
  const contextualUsage =
    path && usage === CLI_REFERENCE_ENTRY_POINT.usage
      ? usage.replace('artifactshare', `artifactshare ${path}`)
      : usage
  return contextualUsage.replace(/^artifactshare\b/, CLI_REFERENCE_INVOCATION)
}

const commands: CliReferenceCommand[] = CLI_REFERENCE_PUBLIC_COMMANDS.map(
  (command) => ({
    path: command.path,
    role: roleByPath[command.path]!,
    example: CLI_REFERENCE_EXAMPLES[command.path],
  }),
)

const jaRoleByPath: Record<string, string> = {
  append:
    'ローカルの UTF-8 ファイルを既存の単一 HTML / Markdown の末尾へ追記します。',
  artifacts: '成果物を一覧表示し、読み取ります。',
  'artifacts get': '成果物とメタデータを読み取ります。',
  'artifacts list':
    'project または home を含む、アクセスできる成果物を一覧表示します。',
  changelog: 'CLI のリリースノートを表示します。',
  comments: '成果物のコメントを扱います。',
  'comments delete': 'コメントメッセージを削除します。',
  'comments edit': 'コメントメッセージを編集します。',
  'comments list': 'コメントのスレッドとメッセージを一覧表示します。',
  'comments post': 'コメント、返信、引用コメントを投稿します。',
  'comments reopen': '解決済みのコメントスレッドを再開します。',
  'comments resolve': 'コメントスレッドを解決済みにします。',
  config: 'ローカル CLI 設定を確認、変更します。',
  'config get': 'user、repository、effective のスコープで設定を読み取ります。',
  'config set': 'user または repository のスコープに設定を保存します。',
  'config unset': 'スコープに保存した設定を削除します。',
  delete: '成果物を完全に削除します。',
  doctor: '認証、設定、接続状態を確認します。',
  download: '成果物をローカルパスへダウンロードします。',
  edit: '成果物のタイトル、visibility、共有先、投稿先を編集します。',
  init: 'agent を検出し、skill をインストールして初期設定を始めます。',
  login:
    '通常権限または1プロジェクトに制限した agent 権限で CLI を認証します。',
  logout: '保存済みの認証情報を失効して削除します。',
  move: '成果物を project または home へ移動します。',
  open: 'Artifact Share URL を読み取り、必要なら CLI skill を準備します。',
  profiles: '名前付きの認証 profile を管理します。',
  'profiles delete': '名前付き profile を削除します。',
  'profiles import-token':
    'CI または手動発行 token を profile に取り込みます。',
  'profiles list': '保存済み profile を一覧表示します。',
  'profiles use': '使用する active profile を選択します。',
  projects: 'project を管理します。',
  'projects create': 'project を作成します。',
  'projects edit': 'project の詳細、audience、アーカイブ状態を編集します。',
  'projects list': '利用できる project を一覧表示します。',
  resolve: 'URL、ID、その他の Artifact Share の値を解決します。',
  share: 'ローカルのファイル、フォルダ、静的サイトを共有します。',
  skills: 'インストール済みの Artifact Share agent skill を管理します。',
  'skills ensure': '検出した tool に skill があることを確認します。',
  'skills install': '選択した tool に skill をインストールします。',
  'skills list': 'skill がインストールされた tool を一覧表示します。',
  'skills remove': 'tool からインストール済み skill を削除します。',
  'skills update': 'インストール済み skill を更新します。',
  update: '既存の共有 URL の背後に新しい版をアップロードします。',
  whoami: 'active account と workspace を表示します。',
}

const EN: CliReferenceContent = {
  locale: 'en',
  title: 'Artifact Share CLI reference',
  intro:
    'A public, machine-friendly guide to sharing, updating, reading, and organizing artifacts from a terminal.',
  tocTitle: 'On this page',
  sections: {
    introduction: {
      title: 'Introduction and authentication',
      body: 'Node.js 22.19 or newer is required. Start with the init command shown above, complete browser sign-in, or import a token for CI with profiles import-token. Use login --preset agent to restrict an agent to one selected project. A new profile defaults to unrestricted access; an existing profile keeps its previous preset. Use --profile to keep credentials separate, logout to revoke a browser-authenticated CLI session, and Settings → Tokens to revoke an API token.',
    },
    basics: {
      title: 'Basic operations',
      body: 'Use share for a file, folder, or static site; update to keep the same URL; open or artifacts get to read; download to save locally; comments for review; projects for organization; profiles and config for accounts and settings; and skills for agent setup.',
    },
    commands: {
      title: 'Command reference',
      body: 'The command surface below is generated from the public CLI help. Usage and accepted options are rendered from the generated surface snapshot.',
    },
    'json-exit': {
      title: 'JSON output and exit codes',
      body: 'With --json, piping, or another non-interactive invocation, successful results go to stdout as a common envelope with schema_version: 2, ok: true, command, and data. Failures go to stderr with schema_version: 2, ok: false, command, and error. Exit code 0 means success, 1 means a command failure, and 130 means cancellation. An auth_required response includes the verification URL and user code; approve it, then rerun the same command.',
    },
    destinations: {
      title: 'Projects, home, audience, and settings',
      body: 'A project destination uses the project audience. When share has no destination, it posts to home. Choose home_audience by purpose: use user scope for a personal safe default in this CLI environment, repository scope only for a policy agreed by all participants, and explicit --visibility for one post. Confirm the result with config get home_audience --scope effective --json. home_audience is the canonical setting: private means only you, and workspace means everyone in the workspace. Store repository settings in .artifactshare/config.json and user settings in the user config directory. Home resolution checks repository home_audience, repository default_artifact_visibility, user home_audience, user default_artifact_visibility, then the product default workspace. default_artifact_visibility is only a compatibility alias. default_project_visibility is an independent default for projects create. --grant-email adds an individual project share recipient; it does not implicitly change project visibility.',
    },
    recovery: {
      title: 'Failures and recovery',
      body: 'For auth_required or token_invalid, run login or import a valid profile token and rerun the same command. For validation_failed, check usage and options. For target_not_found, resolve the URL or ID again. For upload_not_allowed, contact Artifact Share support. For network_failed, check the base URL and retry without changing the destination.',
    },
    related: {
      title: 'Related guides',
      body: 'Use the connect guide to choose an integration, the Share with AI guide to learn how to ask an agent, the updates page for product changes, and the npm package page for installation details.',
    },
  },
  commandsHeading: 'All public commands',
  commandUsageLabel: 'Usage',
  commandOptionsLabel: 'Options',
  commandExampleLabel: 'Example',
  commands,
  representativeExamples: Object.values(CLI_REFERENCE_EXAMPLES),
  copyLabels: { copy: 'Copy command', copied: 'Copied', failed: 'Copy failed' },
  links: {
    shareWithAi: { href: '/share-with-ai', label: 'Share with AI' },
    connect: { href: '/connect', label: 'Connect' },
    updates: { href: '/updates', label: 'Updates' },
    privateHandoff: {
      href: '/guides/private-mobile-design-handoff',
      label: 'Private mobile design handoff',
    },
    npm: {
      href: 'https://www.npmjs.com/package/@artifactshare/cli',
      label: 'npm package',
    },
  },
  og: {
    title: 'Artifact Share CLI reference',
    description:
      'A public reference for the Artifact Share CLI, including every public command, JSON output, settings, destinations, and recovery.',
  },
}

const JA: CliReferenceContent = {
  ...EN,
  locale: 'ja',
  title: 'Artifact Share CLI リファレンス',
  intro:
    'ターミナルからファイルを共有、更新、読み取り、整理するための公開リファレンスです。',
  tocTitle: 'このページの内容',
  sections: {
    introduction: {
      title: '導入と認証',
      body: 'Node.js 22.19 以降が必要です。上記の init コマンドから始め、ブラウザでログインします。login --preset agent を使うと、AIエージェントの権限を選択した1プロジェクトだけに制限できます。新しいプロファイルの既定は unrestricted で、既存のプロファイルは前回の preset を引き継ぎます。資格情報は --profile で分け、ブラウザでログインしたCLIセッションは logout、APIトークンは「設定」→「トークン」から失効します。',
    },
    basics: {
      title: '基本操作',
      body: 'ファイル、フォルダ、静的サイトは share、同じ URL の差し替えは update、読み取りは open または artifacts get、保存は download、レビューは comments、整理は projects、アカウントと設定は profiles と config、agent の準備は skills を使います。',
    },
    commands: {
      title: 'コマンドリファレンス',
      body: '以下の command surface は公開 CLI の help から生成されています。構文と受理する option も生成 snapshot から描画します。',
    },
    'json-exit': {
      title: 'JSON と終了コード',
      body: '--json、pipe、その他の非対話実行では、成功を schema_version: 2、ok: true、command、data の共通 envelope として stdout に出します。失敗は schema_version: 2、ok: false、command、error として stderr に出します。終了コード 0 は成功、1 は command の失敗、130 はキャンセルです。auth_required には verification URL と user code が含まれるので、承認後に同じ command を再実行します。',
    },
    destinations: {
      title: 'project、home、audience、設定',
      body: 'project への投稿はその project の audience に届きます。投稿先を指定しない share は home に投稿します。home_audience は目的別に使い分けます。個人の安全な既定値には user、一緒に使う全員が合意した方針には repository、一回限りの指定には明示 --visibility を使い、config get home_audience --scope effective --json で実効値を確認します。正本の設定は home_audience で、private は自分だけ、workspace は社内全員です。repository 設定は .artifactshare/config.json、user 設定は user config directory に保存します。home の解決順は repository の home_audience、repository の default_artifact_visibility、user の home_audience、user の default_artifact_visibility、製品既定 workspace です。default_artifact_visibility は互換 alias の補足に限ります。default_project_visibility は projects create 用の独立した既定値です。--grant-email は project の個別共有先を追加するだけで、project の visibility を暗黙に変更しません。',
    },
    recovery: {
      title: '失敗と復旧',
      body: 'auth_required または token_invalid なら login か有効な profile token の import を行い、同じ command を再実行します。validation_failed は構文と option を確認します。target_not_found は URL または ID を解決し直します。upload_not_allowed は Artifact Share 運営へ問い合わせます。network_failed は base URL を確認して、投稿先を変えずに再試行します。',
    },
    related: {
      title: '関連ガイド',
      body: '接続方法は connect ガイド、agent への頼み方は AI から Artifact Share を使うガイド、変更情報は updates、導入の詳細は npm package ページを参照してください。',
    },
  },
  commandsHeading: '公開 command 一覧',
  commandUsageLabel: '構文',
  commandOptionsLabel: 'option',
  commandExampleLabel: '代表例',
  commands: commands.map((command) => ({
    ...command,
    role: jaRoleByPath[command.path]!,
  })),
  representativeExamples: Object.values(CLI_REFERENCE_EXAMPLES),
  copyLabels: {
    copy: 'command をコピー',
    copied: 'コピーしました',
    failed: 'コピーに失敗しました',
  },
  links: {
    shareWithAi: {
      href: '/share-with-ai',
      label: 'AI から Artifact Share を使う',
    },
    connect: { href: '/connect', label: '接続ガイド' },
    updates: { href: '/updates', label: '更新情報' },
    privateHandoff: {
      href: '/guides/private-mobile-design-handoff',
      label: 'モバイル文書の安全な引き継ぎ',
    },
    npm: {
      href: 'https://www.npmjs.com/package/@artifactshare/cli',
      label: 'npm package',
    },
  },
  og: {
    title: 'Artifact Share CLI リファレンス',
    description:
      '公開 CLI の全 command、JSON 出力、設定、投稿先、復旧方法をまとめたリファレンスです。',
  },
}

export const CLI_REFERENCE_SECTION_IDS: CliSectionId[] = [
  'introduction',
  'basics',
  'commands',
  'json-exit',
  'destinations',
  'recovery',
  'related',
]

export function cliReferenceContent(locale: Locale): CliReferenceContent {
  return locale === 'ja' ? JA : EN
}
