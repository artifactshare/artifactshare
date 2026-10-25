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
  sections: {
    [Id in CliSectionId]: {
      title: string
      body: Id extends 'recovery' ? string[] : string
    }
  }
  commandsHeading: string
  commandUsageLabel: string
  commandOptionsLabel: string
  commandExampleLabel: string
  optionHelp: Record<string, Record<string, string>>
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
  artifacts: 'Browse, read, and delete artifacts.',
  'artifacts delete': 'Alias of delete: permanently delete an artifact.',
  'artifacts get': 'Read an artifact and its metadata.',
  'artifacts list':
    'List artifacts you can access, including project or home results.',
  changelog: 'Show CLI release notes.',
  comments: 'Work with comments on an artifact.',
  'comments delete': 'Delete a comment message.',
  'comments edit': 'Edit a comment message.',
  'comments list':
    'Read first/latest-three comment windows; use --thread-id and --before for older replies (up to 50).',
  'comments post':
    'Post a comment or reply. Quote positions stay unchecked until a viewer resolves the exact context.',
  'comments reopen': 'Reopen a resolved comment thread.',
  'comments resolve': 'Resolve a comment thread.',
  config: 'Inspect and change local CLI settings.',
  'config get': 'Read a setting at user, repository, or effective scope.',
  'config set': 'Save a setting at user or repository scope.',
  'config unset': 'Remove a setting at user or repository scope.',
  delete: 'Permanently delete an artifact.',
  doctor:
    'Check token storage, authentication, configuration, and connectivity.',
  download: 'Download an artifact to a local path.',
  edit: 'Edit artifact title, visibility, grants, or destination.',
  init: 'Detect the agent, install its skill, and start setup.',
  login: 'Authorize the CLI with unrestricted or project-scoped agent access.',
  logout: 'Revoke and remove a saved credential.',
  move: 'Move an artifact to a project or home.',
  preview: 'Preview a local file with the product viewer look and annotate it.',
  'preview start':
    'Serve a local .md or .html file for annotation. Invoked as preview <file>.',
  'preview next': 'Return every undelivered annotation batch to the agent.',
  'preview done':
    'Report batch outcomes from stdin JSON, idempotent per generation.',
  'preview reply':
    'Append a reply to an annotation thread without changing state.',
  'preview stop': 'Stop a live preview session; annotations stay saved.',
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
  'projects list': 'List active projects you can post into.',
  resolve: 'Resolve a URL, ID, or other Artifact Share value.',
  share:
    'Share a local file, folder, or static site. Profiles logged in with login --preset agent must also pass --expected-version when republishing with --key (see Failures and recovery).',
  skills: 'Manage the installed Artifact Share agent skill.',
  'skills ensure': 'Ensure the skill is installed for a detected tool.',
  'skills install': 'Install the skill for a selected tool.',
  'skills list': 'List installed skill targets.',
  'skills remove': 'Remove an installed skill.',
  'skills update': 'Update an installed skill.',
  update:
    'Upload a new version behind an existing share URL. Profiles logged in with login --preset agent must also pass --expected-version (see Failures and recovery). Optional --label adds an immutable 1–80-code-point note, normalized to NFC with outer Unicode spaces trimmed; internal spacing and case stay unchanged. Letters, marks, numbers, punctuation, symbols, spaces, and joined emoji are allowed. Omission creates an unlabeled version. Successful JSON includes the stored label at data.version.label, or null when omitted. data.version.number matches the Viewer version number (v{number}); older servers may omit it. Read version history with artifacts get --include versions. Empty labels, control characters, and invalid, invisible-only, or repeated --label values fail locally with validation_failed before authentication.',
  whoami: 'Show the active account and workspace.',
}

export const CLI_REFERENCE_ENTRY_POINT = surface.commands.find(
  (command) => command.path === '',
)!

export const CLI_REFERENCE_PUBLIC_COMMANDS = surface.commands.filter(
  (command) => command.path !== '',
)

export const CLI_OUTPUT_SCHEMA_VERSION = 2

const CLI_REFERENCE_INVOCATION =
  'npm exec --yes --package=@artifactshare/cli -- artifactshare'

export const CLI_REFERENCE_EXAMPLES: Record<string, string> = {
  init: 'npm exec --yes --package=@artifactshare/cli -- artifactshare init --json',
  share:
    'npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --json',
  update:
    'npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> ./report.html --expected-version <version-id> --json',
  append:
    'npm exec --yes --package=@artifactshare/cli -- artifactshare append <artifact-id-or-url> ./section.md --json',
  open: 'npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json',
  'config get':
    'npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json',
  'config set':
    'npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json',
  login:
    'npm exec --yes --package=@artifactshare/cli -- artifactshare login --profile agent --preset agent --json',
  'profiles import-token':
    'printf \'%s\' "$ARTIFACTSHARE_TOKEN" | npm exec --yes --package=@artifactshare/cli -- artifactshare profiles import-token --profile ci --json',
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
  artifacts: '成果物の一覧表示、読み取り、削除を行います。',
  'artifacts delete': 'delete の別名です。成果物を完全に削除します。',
  'artifacts get': '成果物とメタデータを読み取ります。',
  'artifacts list':
    'project または home を含む、アクセスできる成果物を一覧表示します。',
  changelog: 'CLI のリリースノートを表示します。',
  comments: '成果物のコメントを扱います。',
  'comments delete': 'コメントメッセージを削除します。',
  'comments edit': 'コメントメッセージを編集します。',
  'comments list':
    '各スレッドの最初のコメントと最新3件の返信を表示します。以前の返信は --thread-id と --before で最大50件ずつ取得します。',
  'comments post':
    'コメントや返信を投稿します。引用位置は投稿時には確認せず、その版をビューアーで開いたときに完全一致で確認します。',
  'comments reopen': '解決済みのコメントスレッドを再開します。',
  'comments resolve': 'コメントスレッドを解決済みにします。',
  config: 'ローカル CLI 設定を確認、変更します。',
  'config get': 'user、repository、effective のスコープで設定を読み取ります。',
  'config set': 'user または repository のスコープに設定を保存します。',
  'config unset': 'スコープに保存した設定を削除します。',
  delete: '成果物を完全に削除します。',
  doctor: 'トークンの保存先、認証、設定、接続状態を確認します。',
  download: '成果物をローカルパスへダウンロードします。',
  edit: '成果物のタイトル、visibility、共有先、投稿先を編集します。',
  init: 'agent を検出し、skill をインストールして初期設定を始めます。',
  login:
    '通常権限または1プロジェクトに制限した agent 権限で CLI を認証します。',
  logout: '保存済みの認証情報を失効させて削除します。',
  move: '成果物を project または home へ移動します。',
  preview:
    'ローカルファイルを共有ページと同じ見た目で表示し、コメントできます。',
  'preview start':
    'ローカルの .md / .html を配信します。preview <file> として起動します。',
  'preview next': '未処理のコメントバッチをエージェントへ返します。',
  'preview done': '標準入力の JSON で結果を一括報告します（世代単位で冪等）。',
  'preview reply': 'スレッドへ返信を追記します。状態は変わりません。',
  'preview stop': 'プレビューを終了します。コメントは保存されたままです。',
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
  'projects list': '現在投稿できる有効なプロジェクトを一覧表示します。',
  resolve: 'URL、ID、その他の Artifact Share の値を解決します。',
  share:
    'ローカルのファイル、フォルダ、静的サイトを共有します。login --preset agent でログインしたプロファイルでは、--key で再公開する際に --expected-version の指定も必要です（「失敗と復旧」を参照）。',
  skills: 'インストール済みの Artifact Share agent skill を管理します。',
  'skills ensure': '検出した tool に skill があることを確認します。',
  'skills install': '選択した tool に skill をインストールします。',
  'skills list': 'skill がインストールされた tool を一覧表示します。',
  'skills remove': 'tool からインストール済み skill を削除します。',
  'skills update': 'インストール済み skill を更新します。',
  update:
    '既存の共有 URL のまま、新しい版をアップロードします。login --preset agent でログインしたプロファイルでは --expected-version の指定も必要です（「失敗と復旧」を参照）。任意の --label で変更内容のメモを付けられます。NFC 正規化と前後の Unicode 空白の除去後、1〜80 コードポイントが必要です。内部の空白と大文字小文字は保持します。文字・結合文字・数字・句読点・記号・空白・結合絵文字を許可します。省略時はラベルなしの版を作成し、作成後のラベルは変更できません。成功時の JSON は data.version.label に保存されたラベルを返し、省略時は null を返します。data.version.number は Viewer の版番号（v{number}）と一致します。古いサーバーではこのフィールドが省略される場合があります。artifacts get --include versions で履歴を取得できます。--label の値が空、制御文字を含む、不正、不可視文字のみ、または指定が重複している場合は、認証前にローカルで validation_failed エラーになります。',
  whoami: 'active account と workspace を表示します。',
}

const EN: CliReferenceContent = {
  locale: 'en',
  optionHelp: {},
  title: 'Artifact Share CLI reference',
  intro:
    'A public, machine-friendly guide to sharing, updating, reading, and organizing artifacts from a terminal.',
  tocTitle: 'On this page',
  sections: {
    introduction: {
      title: 'Introduction and authentication',
      body: `Node.js 22.19 or newer is required. Start with ${CLI_REFERENCE_EXAMPLES.init}, complete browser sign-in, or import a token for CI with profiles import-token. Use login --preset agent to restrict an agent to one selected project. A new profile defaults to unrestricted access; an existing profile keeps its previous preset. API-only publisher credentials require a normalized device_name and explicit browser choice to create or continue a client. Duplicate names require continuation or another device_name; names cannot be edited during approval. Publisher versions refresh content and live viewers without changing human activity order, feeds or unread signals. Version history marks scheduled updates. API updated_at remains the actual mutation time. Publisher credentials create private HTML/Markdown files or static sites in home and manage artifacts created by or assigned to their client, even after sharing or moving within the workspace. With a publisher credential, single-file updates require expected_version; static-site deltas use base_version and delete_path. With a publisher credential, the exact download endpoint returns source bytes for single files and a manifest for static sites; individual asset downloads are denied. With a publisher credential, readback includes visibility and is metadata-only for static sites. Publisher credentials can delete these artifacts; with a publisher credential, POST/PATCH edit accepts only retain_versions (positive integer or null); pruning deletes eligible old versions permanently. On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions. Owner unrestricted credentials or a browser session can POST /api/cli/artifacts/:id/adopt with publisher_client_id from whoami/doctor. Audited assignment replaces the previous client's access. With a publisher credential, list, resolve, comments, audience edits, move, projects, append and upsert remain denied. CLI publisher login/resume and publishing/download workflows are unsupported; doctor reports the client scope. Use --profile to keep credentials separate, logout to revoke a browser-authenticated CLI session, and Settings → Tokens to revoke an API token.`,
    },
    basics: {
      title: 'Basic operations',
      body: 'Targets accept artifact IDs, share URLs, and version-scoped execution URLs on artifactshareusercontent.com (a- for authenticated viewing, l- for link viewing). Legacy execution URLs resolve to IDs only. Use share for a file, folder, or static site; update to keep the same URL; open or artifacts get to read; download to save locally; comments for review; projects for organization; profiles and config for accounts and settings; and skills for agent setup. REST API only: POST /api/shareables/:id/versions?artifact_kind=static_site accepts base_version=v1 and repeated delete_path values, for example delete_path=data/old.parquet. Sent files replace matching paths; remaining files are inherited. The base must be current (409 version_conflict otherwise) and supplies the expected version, including for agents. An explicit expected_version must match it. Deletion requires a base; sending and deleting the same path is invalid. A delete-only update must retain index.html or index.md. Version bytes describe the complete file list; workspace quota counts unique stored objects. CLI update has no inheritance flags. Browser share pages pass their URL fragment (#) to HTML, Markdown, and static-site frames, follow changes inside them, and include it in Copy link for sharing filtered views or headings. Only a static site’s entrypoint updates the share fragment; subpages leave it unchanged. CLI local preview is unchanged.',
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
      body: 'Destination lists show only active projects you can post into. Private projects permit their creator, active team-plan workspace owners/admins, or verified contributors/managers. Free/plus admin status, viewer access and artifact-only grants do not grant placement rights. Agents and bots retain their fixed project and require a verified contributor/manager grant for private projects; publishers cannot select projects. edit accepts --visibility private|workspace|project|link. Project visibility requires the artifact to be in a project after the edit; use --project-id <id> in the same request if needed. An explicit --visibility project at home (including --home) is refused without changes. Moving a project-visible artifact home makes it private only when project visibility is not explicitly requested. A project destination uses the project audience. When share has no destination, it posts to home. Choose home_audience by purpose: use user scope for a personal safe default in this CLI environment, repository scope only for a policy agreed by all participants, and explicit --visibility for one post. Confirm the result with config get home_audience --scope effective --json. home_audience is the canonical setting: private means only you, and workspace means everyone in the workspace. Store repository settings in .artifactshare/config.json and user settings in the user config directory. Home resolution checks repository home_audience, repository default_artifact_visibility, user home_audience, user default_artifact_visibility, then the product default workspace. default_artifact_visibility is only a compatibility alias. default_project_visibility is an independent default for projects create. --grant-email adds an individual project share recipient; it does not implicitly change project visibility.',
    },
    recovery: {
      title: 'Failures and recovery',
      body: [
        'Download IDs must match ^[a-z0-9]{10}$; invalid or duplicate list/index IDs fail before writes. Download accepts linked output parents and rechecks their resolved directory identities. Linked output roots, indexes, and listed artifact trees are refused, even with --force. Preflight checks every listed artifact tree, including unchanged versions, and the index; unrelated content is not walked. Network failures and invalid manifest paths, bodies, or identities remain per-artifact; every boundary violation stops further publication, including the final index. Successful replacements retain originals and previous indexes in data.backup_paths and human output. Failed recovery also names retained paths in the error; inspect them before manual cleanup.',
        'When saving configuration, init refuses linked or changed config paths. Node path-based operations cannot guarantee atomic confinement against arbitrary concurrent changes. Init preserves unknown config keys. Git worktrees and submodules still save config, but .git files, links, gitdir or commondir files inside .git, and unsafe exclude paths produce git_exclude_warning with the exact line to add manually.',
        'Files named by another spelling (such as Windows short names) use their stored names for kind and content type; disappearing listed files are changed, and relative paths with a regular file in the middle (for example file.txt/x) are not_found. For share, append, and update, relative paths stay in the physical current directory and reject linked components. Absolute paths trust parents but reject a linked selection or included descendant. Every .. component is rejected: pass a direct absolute path. Copy linked content into the selection or pass the target by absolute path. Names that start with a dot (.) and excluded names are skipped before inspection. Local reads finish before authentication or project lookup; authentication retries reuse verified content. validation_failed includes details.path and details.reason: parent_traversal, link, outside_cwd, not_found, changed, unsupported_guarantee, or invalid_type. Check missing paths, pass an absolute path for outside_cwd, retry changed selections, and follow the named guarantee or file-type hint. For upload_read_failed, check details.errno, filesystem availability and permissions, then retry. POSIX uses available no-follow opens; Windows checks handle identity and rejects links reported by lstat. Transient swap-and-restore and same-identity, same-size edits may escape detection.',
        'For auth_required or token_invalid, run login or import a valid profile token and rerun the same command. For unknown_option, correct details.option using the hint or command help; options are checked before authentication, requests or writes. For invalid_expected_version, use a version id from data.version.id in share/update output or data.version_id from artifacts get <target> --json, rather than a number. Both errors use recovery.kind: change_input. For unsupported_node_version, upgrade Node.js to 22.19.0 or newer; this requires human or environment action (recovery.kind: ask_human, agent_recoverable: false, requires_human: true). For validation_failed without a details.reason, check usage and options. For target_not_found, resolve the URL or ID again. For self_upload_disabled, sign in with Google or Microsoft and rerun the same command. For network_failed, check the base URL and retry without changing the destination. For expected_version_required after login --preset agent, pass data.version.id from the previous successful share or update output as --expected-version when retrying update or share --key. If that output is unavailable, for single-file HTML and Markdown artifacts, artifacts get <target> --json returns the current version as data.version_id. For static sites, download <target> --json returns it as data.version.id. Check the returned current content (data.content, or the downloaded files for static sites) and reapply your changes to it if it differs from what you edited. Pass the returned value as --expected-version.',
      ],
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
  optionHelp: {
    share: {
      '--expected-version':
        '--key で更新する際の現在のバージョン ID。番号ではなく、前回の share/update の data.version.id を指定します。artifacts get では data.version_id として返されます。',
    },
    update: {
      '--expected-version':
        '更新対象の現在のバージョン ID。番号ではなく、前回の share/update の data.version.id を指定します。artifacts get では data.version_id として返されます。agent プリセットでのログインでは必須です。',
    },
    download: {
      '--force': '既存の出力を置換し、復旧用のバックアップを保持します。',
    },
    edit: {
      '--retain-versions':
        'N または all(所有者のみ)。最新の N 版を残します。publisher の資格で作成したファイル、または publisher のクライアントに割り当てられたファイルでは、publisher の資格で追加した版だけを数え、人が追加した版はすべて残します。対象となる古い版の削除は取り消せません。all で制限を外します。',
    },
  },
  title: 'Artifact Share CLI リファレンス',
  intro:
    'ターミナルからファイルを共有、更新、読み取り、整理するための公開リファレンスです。',
  tocTitle: 'このページの内容',
  sections: {
    introduction: {
      title: '導入と認証',
      body: `Node.js 22.19 以降が必要です。${CLI_REFERENCE_EXAMPLES.init} から始め、ブラウザでログインします。CI では、代わりに profiles import-token でトークンを取り込めます。login --preset agent を使うと、AIエージェントの権限を選択した1プロジェクトだけに制限できます。新しいプロファイルの既定は unrestricted で、既存のプロファイルは前回の preset を引き継ぎます。資格情報は --profile で分け、ブラウザでログインしたCLIセッションは logout、APIトークンは「設定」→「トークン」から失効させます。publisher は API 専用です。publisher による版の追加は定期更新として扱い、一覧の順序やフィード、未読表示を変えません。履歴で定期更新の印を確認できます。API の updated_at は実際の更新時刻です。publisher の資格情報では、device_name を指定し、ブラウザで新規作成か既存クライアントの継続を選択します。publisher の資格情報では、同名での新規作成はできません。別の名前でログインをやり直してください。publisher の資格情報では、ホームにあなただけが見られるファイルや静的サイトを作成し、作成・割り当て済みのものを管理できます。publisher の資格情報では、単一ファイルの更新は expected_version、静的サイトの差分更新は base_version と delete_path を使います。publisher の資格情報では、download は単一ファイルなら元データ、静的サイトならパスとハッシュのマニフェストを返します。publisher の資格情報では、個別アセットの取得はできません。publisher の資格情報では、内容を取得すると共有範囲も返し、静的サイトではメタデータだけを返します。publisher の資格情報では、削除と POST/PATCH による retain_versions（正整数または null）の変更ができ、対象となる古い版の削除は取り消せません。publisher の資格で作成したファイル、または publisher のクライアントに割り当てられたファイルでは、以前のクライアントによる版も含め、publisher の資格で追加した版だけを数えます。publisher の資格で追加した最新 N 件の版と現在の版を残し、人が追加した版はすべて残します。下書きは数えません。このルールは所有者が unrestricted 資格情報で設定するときも同じです。それ以外のファイルでは、これまでどおりすべての公開版を数えます。所有者は unrestricted 資格情報かブラウザセッションで POST /api/cli/artifacts/:id/adopt に publisher_client_id を送り、既存の成果物を割り当てられます。ID は whoami/doctor で確認します。割り当ては以前のクライアントのアクセスを置き換え、毎回監査ログに記録されます。publisher の資格情報では、一覧、検索、コメント、共有範囲変更、移動、プロジェクト操作、追記、上書き投稿には使えません。CLI での publisher ログイン・再開や投稿・ダウンロードには対応していません。doctor はクライアントの権限を表示します。`,
    },
    basics: {
      title: '基本操作',
      body: '対象には成果物 ID、共有 URL、artifactshareusercontent.com のバージョン付き実行 URL（認証済みは a-、リンク閲覧は l-）を指定できます。旧配信 URL は ID の解決だけに使います。ファイル、フォルダ、静的サイトは share、同じ URL の差し替えは update、読み取りは open または artifacts get、保存は download、レビューは comments、整理は projects、アカウントと設定は profiles と config、agent の準備は skills を使います。REST API の POST /api/shareables/:id/versions?artifact_kind=static_site では、base_version=v1 と繰り返しの delete_path（例: delete_path=data/old.parquet）を指定できます。送信したファイルを差し替え、それ以外のファイルは現在の版から引き継ぎます。基準は現在の公開バージョンに限り、古い場合は 409 version_conflict を返します。base_version は、エージェントの更新で必要な expected_version の代わりにもなります。expected_version も指定する場合は、base_version と同じ値にしてください。削除には基準の指定が必要で、同じパスの送信と削除はできません。削除だけの更新でも index.html または index.md を残してください。バージョンのサイズはファイル一覧の合計、保存容量は重複を除いた実体の合計です。CLI update に継承用のオプションはありません。ブラウザーの共有ページは URL のフラグメント（#）を HTML・Markdown・静的サイトに渡し、フレーム内の変更を URL に反映します。「リンクをコピー」にも含まれるため、絞り込み状態や見出しを共有できます。静的サイトでは最初に開くページだけが共有 URL のフラグメントを更新し、サブページでは変更しません。CLI のローカルプレビューは対象外です。',
    },
    commands: {
      title: 'コマンドリファレンス',
      body: '以下のコマンド一覧は、公開 CLI の help から生成しています。構文と使える option も、生成した snapshot から表示しています。',
    },
    'json-exit': {
      title: 'JSON と終了コード',
      body: '--json、pipe、その他の非対話実行では、成功を schema_version: 2、ok: true、command、data の共通 envelope として stdout に出します。失敗は schema_version: 2、ok: false、command、error として stderr に出します。終了コード 0 は成功、1 は command の失敗、130 はキャンセルです。auth_required には verification URL と user code が含まれるので、承認後に同じ command を再実行します。',
    },
    destinations: {
      title: 'project、home、audience、設定',
      body: '投稿先の一覧には、現在投稿できる有効なプロジェクトだけが表示されます。非公開プロジェクトへ投稿できるのは、作成者、team プランの有効な owner/admin、または確認済みメールアドレスで登録された contributor/manager です。free/plus の管理者権限、閲覧権限、成果物への個別共有だけでは投稿できません。エージェントと bot は固定の投稿先に制限され、非公開プロジェクトでは contributor/manager の権限も必要です。publisher はプロジェクトを選択できません。edit は --visibility private|workspace|project|link を指定できます。project の共有範囲には、編集後の保存先がプロジェクトであることが必要です。必要なら同じコマンドに --project-id <id> を指定します。home での明示的な --visibility project（--home との併用を含む）は変更せずに拒否します。プロジェクトの成果物を home に移す場合、project を明示指定していなければ private になります。 project への投稿はその project の audience に届きます。投稿先を指定しない share は home に投稿します。home_audience は目的別に使い分けます。個人の安全な既定値には user、一緒に使う全員が合意した方針には repository、一回限りの指定には明示 --visibility を使い、config get home_audience --scope effective --json で実効値を確認します。正本の設定は home_audience で、private は自分だけ、workspace は社内全員です。repository 設定は .artifactshare/config.json、user 設定は user config directory に保存します。home の解決順は repository の home_audience、repository の default_artifact_visibility、user の home_audience、user の default_artifact_visibility、製品既定 workspace です。default_artifact_visibility は、互換性のために残している別名です。default_project_visibility は projects create 用の独立した既定値です。--grant-email は project の個別共有先を追加するだけで、project の visibility を暗黙に変更しません。',
    },
    recovery: {
      title: '失敗と復旧',
      body: [
        'download の ID は ^[a-z0-9]{10}$ に限定し、一覧と index の不正な ID や重複は書き込み前に拒否します。出力ルートの親がリンクでも使用でき、リンク先のディレクトリの同一性を再確認します。ルート、index、一覧に含まれる成果物ツリーのリンクは --force でも拒否します。事前検査では変更のない成果物を含む全対象と index を確認し、無関係な内容は走査しません。通信エラーやマニフェストのパス・内容・IDの不備は成果物ごとの失敗として記録しますが、書き込み境界の違反を検出したら、後続の成果物と最終 index の公開を中断します。置換前のデータと index は成功後も保持し、data.backup_paths と人向け出力で案内します。復旧に失敗した場合もエラーに保存先を示します。内容を確認してから手動で削除してください。',
        '設定保存時の init は、設定パスのリンクや差し替えを拒否します。Node のパスベース操作では、検査と操作の間の任意の同時変更まで原子的に防ぐ保証はありません。init は未知の設定キーを保持します。Git worktree と submodule でも設定は保存しますが、.git ファイル、リンク、.git の中の gitdir や commondir のファイル、安全に更新できない exclude は git_exclude_warning で手動追加する行を案内します。',
        'Windows の短い名前など、別の綴りで指定したファイルは、保存されている本来の名前から種類と content type を決めます。列挙後に消えたファイルは changed、途中に通常のファイルを含む相対パス（例: file.txt/x）は not_found になります。share・append・update の相対パスは物理的な現在のディレクトリ内に限定され、途中のリンクも拒否されます。絶対パスの親ディレクトリは信頼しますが、選択対象とその配下のリンクは拒否します。親ディレクトリ参照（..）を含むパスは使えません。直接の絶対パスを指定してください。リンク先を選択範囲にコピーするか、リンク先の絶対パスを指定します。ドット（.）で始まる名前と除外対象は、検査の前に省きます。認証やプロジェクト検索の前に読み取りを完了し、認証の再試行では検証済みの内容を再利用します。validation_failed の details.path と details.reason（parent_traversal、link、outside_cwd、not_found、changed、unsupported_guarantee、invalid_type）を確認してください。見つからないパスは確認し、outside_cwd では絶対パスを指定し、読み取り中の変更は再試行し、保証やファイル種別の問題は個別のヒントに従います。upload_read_failed では details.errno とファイルシステムの状態・権限を確認して再試行します。POSIX では利用可能な no-follow open を使い、Windows ではハンドルの同一性を確認して lstat がリンクと判定した対象を拒否します。検査の間に差し替えて元に戻す操作や、同じファイルを同じサイズで書き換える操作は検出できない場合があります。',
        'auth_required または token_invalid なら login か有効な profile token の import を行い、同じ command を再実行します。unknown_option は認証・通信・書き込みの前に返されます。details.option をヒントやコマンドのヘルプに従って修正してください。invalid_expected_version では番号ではなく、share/update の出力の data.version.id、または artifacts get <target> --json の data.version_id を指定します。どちらも recovery.kind: change_input です。unsupported_node_version では Node.js を 22.19.0 以上に更新してください。人または実行環境側の対応が必要です（recovery.kind: ask_human、agent_recoverable: false、requires_human: true）。details.reason がない validation_failed は構文と option を確認します。target_not_found は URL または ID を解決し直します。self_upload_disabled は Google または Microsoft でログインして、同じ command を再実行します。network_failed は base URL を確認して、投稿先を変えずに再試行します。login --preset agent でログインして expected_version_required が返された場合は、前回成功した share または update の出力にある data.version.id を --expected-version に指定して、update または share --key を再実行します。前回の出力がない場合、単一ファイルの HTML・Markdown では artifacts get <target> --json が現在のバージョンを data.version_id として返します。静的サイトでは download <target> --json が data.version.id として返します。返された現在の内容（data.content、静的サイトではダウンロードしたファイル）を確認し、編集元の内容と異なる場合は、その現在の内容に変更を適用し直します。返された値を --expected-version に指定します。',
      ],
    },
    related: {
      title: '関連ガイド',
      body: '接続方法は connect ガイド、agent への頼み方は AI から Artifact Share を使うガイド、変更情報は updates、導入の詳細は npm package ページを参照してください。',
    },
  },
  commandsHeading: '公開コマンド一覧',
  commandUsageLabel: '構文',
  commandOptionsLabel: 'option',
  commandExampleLabel: '代表例',
  commands: commands.map((command) => ({
    ...command,
    role: jaRoleByPath[command.path]!,
  })),
  representativeExamples: Object.values(CLI_REFERENCE_EXAMPLES),
  copyLabels: {
    copy: 'コマンドをコピー',
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

export function cliReferenceOptionHelp(
  commandPath: string,
  help: string,
  locale: Locale,
): string {
  const match = /^(--[a-z0-9-]+)(?: <[^>]+>)?/.exec(help)
  const description =
    match && cliReferenceContent(locale).optionHelp[commandPath]?.[match[1]]
  return description ? `${match![0]} ${description}` : help
}
