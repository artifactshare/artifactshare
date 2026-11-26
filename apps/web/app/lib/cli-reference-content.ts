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
      body: Id extends 'introduction' | 'recovery' ? string[] : string
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
  'artifacts get':
    'Read data.title and data.visibility for the current artifact along with source, or pass --version <version-id> to read an earlier published version. When a read is truncated, pass the same --version with --offset <next_offset> to continue. version_id and format describe the returned source. data.title and data.visibility stay current on historical and continuation reads. Removed versions return version_removed. Static sites return metadata only: no content or format; --include, --version and --offset are unsupported. Updated get explicitly requests metadata. Older CLI releases still receive unsupported-kind for static sites, so open suggests download. For human and agent credentials, get includes retain_versions, version_count and total_size_bytes for versions the caller can list. Static-site history and totals include only published versions with a publication timestamp for every caller, including owners. Publisher credentials do not receive version_count or total_size_bytes.',
  'artifacts versions':
    'List retained file or static-site versions (version_id, created_at, size_bytes, is_current), newest first, 50 per page. Pass next_cursor as --cursor while has_more. retain_versions is null for unlimited; version_count and total_size_bytes cover versions the caller can list. Static-site history and totals include only published versions with a publication timestamp for every caller, including owners. Static-site bytes include all files per version, including inherited files. Publisher-created static-site versions may have a null creator. Logical bytes count reused files per version, not physical storage or billing. Managed histories can exceed the policy because human/current versions are protected. Publisher credentials do not receive version_count or total_size_bytes and cannot read history; inaccessible artifacts return target_not_found. Restart without --cursor if invalid.',
  'artifacts list':
    'List artifacts you can access, including project or home results. Pass --q to search body text and titles, or --query to match titles only (filters, paging and empty results: see Failures and recovery). Legacy list rows (without search filters) and human search rows include retain_versions, version_count and total_size_bytes for versions the caller can list. Restricted agent and bot search rows omit all three. Static-site history and totals include only published versions with a publication timestamp for every caller, including owners. Publisher credentials cannot list artifacts. Compare total_size_bytes client-side across pages.',
  changelog: 'Show CLI release notes.',
  comments: 'Work with comments on an artifact.',
  'comments delete': 'Delete a comment message.',
  'comments edit': 'Edit a comment message.',
  'comments list':
    'Read first/latest-three comment windows; use --thread-id and --before for older replies (up to 50). Text anchors include target_path: the page, plus any #/ or #!/ hash route on multi-file sites. PDF page comments add page_number with version_id and version_number of the version they were posted on.',
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
  'preview history':
    'Read local review history: each batch with its comments and the document before and after the agent reported.',
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
    'Share a local file (HTML, Markdown, PDF, or MP4 video up to 25 MiB; a .pdf must start with %PDF-, a .mp4 needs an ftyp box), folder, or static site. A share --key resend preserves visibility. If --visibility differs after normalization (at home, project compares as private), the command fails with key_visibility_mismatch before creating a version. Use edit <id> --visibility <value> --json to change it, and artifacts get <id> --json to check it for HTML and Markdown artifacts. Profiles logged in with login --preset agent must also pass --expected-version when republishing with --key (see Failures and recovery).',
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

const CLI_REFERENCE_INVOCATION = 'npx --yes @artifactshare/cli'

export const CLI_REFERENCE_EXAMPLES: Record<string, string> = {
  init: 'npx --yes @artifactshare/cli init --json',
  share: 'npx --yes @artifactshare/cli share ./report.html --json',
  update:
    'npx --yes @artifactshare/cli update <artifact-id-or-url> ./report.html --expected-version <version-id> --json',
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
    'ローカルの UTF-8 ファイルを、既存の単一 HTML または Markdown の末尾へ追記します。',
  artifacts: 'ファイルの一覧表示、読み取り、削除を行います。',
  'artifacts delete': 'delete の別名です。ファイルを完全に削除します。',
  'artifacts get':
    '現在の表示タイトル（data.title）、共有範囲（data.visibility）、本文を読み取ります。過去のバージョンや続きを読み取るときも、タイトルと共有範囲には現在の情報が返ります。過去の公開済みのバージョンを読むには --version <version-id> を指定し、本文が途中で切れたときは同じ --version と --offset <next_offset> を渡して続きを取得します（version_id と format は返された本文のものです）。削除済みのバージョンを指定すると version_removed が返ります。静的サイトは本文を含まないメタデータだけを返し、--include・--version・--offset は使えません。現行の get はメタデータ応答を明示的に要求し、旧 CLI には従来どおり unsupported-kind を返すため、open では引き続きダウンロードを案内します。通常ユーザーまたは agent の資格情報では retain_versions・version_count・total_size_bytes も返ります。バージョン数と合計サイズの集計対象は呼び出し元が履歴で閲覧できるバージョンに限られ、静的サイトでは所有者を含め公開日時のある公開済みのバージョンだけを対象にします。publisher の資格情報には version_count と total_size_bytes を返しません。',
  'artifacts versions':
    '単一ファイルと静的サイトの保存済みのバージョンを新しい順に 50 件ずつ表示します。各行には version_id・created_at・size_bytes・is_current が含まれ、has_more が true のときは next_cursor を --cursor に渡して続きを取得します。retain_versions が null のときは上限なしです。version_count と total_size_bytes は呼び出し元が履歴で閲覧できるバージョンを集計し、静的サイトでは所有者を含め公開日時のある公開済みのバージョンだけを対象にします。各バージョンのサイズには前のバージョンから引き継いだファイルも含まれますが、再利用ファイルをバージョンごとに数える論理バイト数のため、実際の保存容量や請求額とは異なります。publisher が作った静的サイトのバージョンでは creator が null になることがあります。管理対象のファイルでは人が作成したバージョンと現在のバージョンを保護するため、バージョン数が保持設定を超える場合があります。publisher の資格情報では履歴・version_count・total_size_bytes を取得できません。閲覧できない対象は target_not_found になり、不正なカーソルで失敗したときは --cursor を外して取り直します。',
  'artifacts list':
    'プロジェクトや home を含め、アクセスできるファイルを一覧表示します。--q は本文とタイトル、--query はタイトルだけを対象に検索します（絞り込み・ページ送り・0 件時の対処は「失敗と復旧」を参照）。検索フィルターを使わない通常の一覧と、通常ユーザーの資格情報による検索では、各行の retain_versions・version_count・total_size_bytes で保持設定・バージョン数・論理バイト数を確認できます。制限付き agent や bot の検索結果にはこの 3 項目を含めません。バージョン数と合計サイズの集計対象は呼び出し元が履歴で閲覧できるバージョンに限られ、静的サイトでは所有者を含め公開日時のある公開済みのバージョンだけを対象にします。publisher の資格情報では一覧を取得できません。容量を比べたいときはページを取得して手元で total_size_bytes を比較します。',
  changelog: 'CLI の変更履歴（リリースノート）を表示します。',
  comments: 'ファイルに付いたコメントを操作します。',
  'comments delete': 'コメントを削除します。',
  'comments edit': 'コメントの本文を編集します。',
  'comments list':
    '各スレッドの最初のコメントと最新 3 件の返信を表示します。それ以前の返信は --thread-id と --before を使って最大 50 件ずつ取得できます。本文への引用コメントでは target_path にページの場所が返り、複数ファイルのサイトでは #/ や #!/ で始まるハッシュルートも含まれます。PDF ページへのコメントでは page_number に加え、投稿時のバージョンの version_id と version_number が返ります。',
  'comments post':
    'コメントや返信を投稿します。引用箇所の一致確認は投稿時には行わず、そのバージョンを共有ページで開いたときに完全一致で照合します。',
  'comments reopen': '解決済みのコメントスレッドを再開します。',
  'comments resolve': 'コメントスレッドを解決済みにします。',
  config: 'ローカルの CLI 設定を確認・変更します。',
  'config get':
    'user・repository・effective の各スコープで設定を読み取ります。',
  'config set': 'user または repository のスコープに設定を保存します。',
  'config unset': '指定したスコープに保存されている設定を削除します。',
  delete: 'ファイルを完全に削除します。',
  doctor: 'トークンの保存先、認証、設定、接続状態を診断します。',
  download: 'ファイルをローカルのパスへダウンロードします。',
  edit: 'ファイルのタイトル、共有範囲（visibility）、共有先、投稿先を変更します。',
  init: '利用中のエージェントを検出し、スキルをインストールして初期設定を進めます。',
  login:
    '通常権限、または 1 つのプロジェクトに絞った agent 権限で CLI にログインします。',
  logout: '保存済みの認証情報を失効させて削除します。',
  move: 'ファイルをプロジェクトまたは home へ移動します。',
  preview:
    'ローカルのファイルを共有ページと同じ見た目で表示し、その場でコメントできます。',
  'preview start':
    'ローカルの .md / .html を配信します。通常は preview <file> として起動します。',
  'preview next': '未処理のコメントバッチをエージェントへ返します。',
  'preview done':
    '標準入力の JSON で対応結果を一括報告します（世代単位で冪等）。',
  'preview reply':
    'スレッドへ返信を追記します（スレッドの状態は変わりません）。',
  'preview history':
    '送信したバッチごとに、コメントとエージェントが報告する前後の文書をローカル履歴から読み取ります。',
  'preview stop':
    'プレビューを終了します。コメントはローカルに保存されたまま残ります。',
  open: 'Artifact Share の URL を読み取り、必要なら CLI スキルを準備します。',
  profiles: '名前付きの認証プロファイルを管理します。',
  'profiles delete': '名前付きのプロファイルを削除します。',
  'profiles import-token':
    'CI 用または手動発行のトークンをプロファイルへ取り込みます。',
  'profiles list': '保存済みのプロファイルを一覧表示します。',
  'profiles use': '使用するプロファイルを切り替えます。',
  projects: 'プロジェクトを管理します。',
  'projects create': '新しいプロジェクトを作成します。',
  'projects edit': 'プロジェクトの詳細、共有範囲、アーカイブ状態を変更します。',
  'projects list': '現在投稿できる有効なプロジェクトを一覧表示します。',
  resolve: 'URL や ID などから対象の Artifact Share 情報を解決します。',
  share:
    'ローカルのファイル（HTML、Markdown、25 MiB までの PDF・MP4 動画。.pdf は先頭が %PDF-、.mp4 は ftyp box を持つ必要があります）、フォルダ、静的サイトを共有します。share --key は既存の共有範囲を変更せず、home の project 指定は private として比較します。正規化後の --visibility が現在の値と違う場合は新しいバージョンを作らず key_visibility_mismatch で失敗するため、変更には edit <id> --visibility <value> --json、HTML・Markdown の共有範囲確認には artifacts get <id> --json を使います。login --preset agent のプロファイルで --key を使って再公開するときは、--expected-version の指定も必要です（「失敗と復旧」を参照）。',
  skills: 'インストール済みの Artifact Share エージェントスキルを管理します。',
  'skills ensure':
    '検出したツールにスキルが入っていることを確認し、必要なら導入・更新します。',
  'skills install': '指定したツールにスキルをインストールします。',
  'skills list': 'スキルが入っているツールを一覧表示します。',
  'skills remove': '指定したツールからインストール済みのスキルを削除します。',
  'skills update': 'インストール済みのスキルを更新します。',
  update:
    '同じ共有リンクのまま新しいバージョンをアップロードします。login --preset agent でログインしたプロファイルでは --expected-version の指定が必要です（「失敗と復旧」を参照）。任意の --label で変更内容のメモを付けられます（NFC 正規化と前後の Unicode 空白除去のあと 1〜80 コードポイント。内部の空白と大文字小文字は保持し、文字・結合文字・数字・句読点・記号・空白・結合絵文字を許可）。省略するとラベルなしで作成され、あとから変更はできません。成功時の JSON では data.version.label に保存されたラベル（省略時は null）、data.version.number に共有ページのバージョン番号（v{number}）が返ります（古いサーバーでは省略される場合があります）。履歴は artifacts get --include versions で取得できます。--label が空・制御文字を含む・不正・不可視文字のみ・重複指定のいずれかだと、認証前にローカルで validation_failed になります。',
  whoami: '現在使っているアカウントとワークスペースを表示します。',
}

const EN: CliReferenceContent = {
  locale: 'en',
  optionHelp: {
    'artifacts versions': {
      '--cursor':
        'Continue with next_cursor from the previous history page; omit to restart.',
    },
  },
  title: 'Artifact Share CLI reference',
  intro:
    'A public, machine-friendly guide to sharing, updating, reading, and organizing artifacts from a terminal.',
  tocTitle: 'On this page',
  sections: {
    introduction: {
      title: 'Introduction and authentication',
      body: [
        `Node.js 22.19 or newer is required. Start with ${CLI_REFERENCE_EXAMPLES.init}, complete browser sign-in, or import a token for CI with profiles import-token.`,
        `Claude Code user skills go to CLAUDE_CONFIG_DIR/skills when set, otherwise ~/.claude/skills. Relative paths resolve against the CLI working directory without tilde expansion. Blank values skip automatic writes; set a non-empty path or unset CLAUDE_CONFIG_DIR. Run skills list or doctor to see unavailable targets. Shared skill directory links are resolved and reported once with aliases and resolved_folder_path. User links outside bundled, owned, pending and reserved CLI paths are ignored and reported in user_links. Unmanaged folders without ownership records or a managed legacy rule remain skipped_unmanaged on update and remove, even when SKILL.md or references is a link; list/doctor report them as unmanaged without reading link referents. For managed folders and forced installs, protected-path links are refused even with --force; replace the named link with a regular file or directory or remove it. Updates preserve edits unless you use skills update --force. Newer installed versions have update_available: false and a newer-CLI hint, with no update recommendation; skills install and skills update leave them untouched unless --force requests an explicit downgrade. Updates without --dry-run remove temporary files left by an interrupted CLI update; --dry-run leaves them untouched.`,
        `Use login --preset agent to restrict an agent to one selected project. A new profile defaults to unrestricted access; an existing profile keeps its previous preset. Use --profile to keep credentials separate, logout to revoke a browser-authenticated CLI session, and Settings → Tokens to revoke an API token.`,
        `Publisher version appends return a stable app /a/:id shareUrl for HTML, Markdown and static sites, independent of current visibility. Opening it uses normal viewer authorization and host routing; human update URLs retain their existing visibility behavior. API-only publisher credentials require a normalized device_name and explicit browser choice to create or continue a client. Duplicate names require continuation or another device_name; names cannot be edited during approval. Publisher versions refresh content and live viewers without changing human activity order, feeds or unread signals. Version history marks scheduled updates. API updated_at remains the actual mutation time. Publisher credentials create private HTML/Markdown files or static sites in home and manage artifacts created by or assigned to their client, even after sharing or moving within the workspace. With a publisher credential, single-file updates require expected_version; static-site deltas use base_version and delete_path. With a publisher credential, the exact download endpoint returns source bytes for single files and a manifest for static sites; individual asset downloads are denied. With a publisher credential, readback includes visibility and is metadata-only for static sites. Publisher credentials can delete these artifacts; with a publisher credential, POST/PATCH edit accepts only retain_versions (positive integer or null); pruning deletes eligible old versions permanently. On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions. Owner unrestricted credentials or a browser session can POST /api/cli/artifacts/:id/adopt with publisher_client_id from whoami/doctor. Audited assignment replaces the previous client's access. With a publisher credential, list, resolve, comments, audience edits, move, projects, append and upsert remain denied. CLI publisher login/resume and publishing/download workflows are unsupported; doctor reports the client scope.`,
      ],
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
      body: 'With --json, piping, or another non-interactive invocation, successful results go to stdout as a common envelope with schema_version: 2, ok: true, command, and data. Failures go to stderr with schema_version: 2, ok: false, command, and error. Unfiltered skills update/remove partial failures keep ok: true on stdout with failed action rows, code: skill_update_conflict and hint in data.targets, and exit with status 1. Exit code 0 means success, 1 means a command failure, and 130 means cancellation. An auth_required response includes the verification URL and user code; approve it, then rerun the same command.',
    },
    destinations: {
      title: 'Projects, home, audience, and settings',
      body: 'Destination lists show only active projects you can post into. Private projects permit their creator, active team-plan workspace owners/admins, or verified contributors/managers. Free/plus admin status, viewer access and artifact-only grants do not grant placement rights. Human agents retain their fixed project. Workspace bots can use multiple administrator-approved projects without reimport; projects list shows eligible approvals and doctor checks the set. Private-project reports must explicitly use project visibility. Both require a verified contributor/manager grant for private projects; publishers cannot select projects. edit accepts --visibility private|workspace|project|link. Project visibility requires the artifact to be in a project after the edit; use --project-id <id> in the same request if needed. An explicit --visibility project at home (including --home) is refused without changes. Moving a project-visible artifact home makes it private only when project visibility is not explicitly requested. A project destination uses the project audience. When share has no destination, it posts to home. Choose home_audience by purpose: use user scope for a personal safe default in this CLI environment, repository scope only for a policy agreed by all participants, and explicit --visibility for one post. Confirm the result with config get home_audience --scope effective --json. home_audience is the canonical setting: private means only you, and workspace means everyone in the workspace. Store repository settings in .artifactshare/config.json and user settings in the user config directory. Home resolution checks repository home_audience, repository default_artifact_visibility, user home_audience, user default_artifact_visibility, then the account-aware product default. Home without an explicit or configured audience defaults to workspace when the account supports it, otherwise private. Explicit or configured workspace still fails when unavailable; sharing never automatically switches to link. Choose --visibility link deliberately. Config inspection is offline: value workspace with source product_default is an unresolved policy placeholder. Share and preview resolve it against the account. Older servers without workspace.visibility_available retain workspace and its existing rejection. whoami and doctor report workspace.visibility_available. Private fallback share results include visibility_source: product_default_private and visibility_hint. default_artifact_visibility is only a compatibility alias. default_project_visibility is an independent default for projects create. --grant-email adds an individual project share recipient; it does not implicitly change project visibility.',
    },
    recovery: {
      title: 'Failures and recovery',
      body: [
        'Use artifacts list --q to search body text and titles. --query matches titles only; combining it with --q, owner or period filters returns validation_failed. Filter with repeatable --owner-user-ids (user IDs, not email addresses; MCP uses the owner_user_ids array), --project-id or --home, and --date-field updated|viewed with --days 7|30|90 or ISO --from/--to. A date-only upper bound includes that UTC day. API empty q browses; CLI --q must be nonblank.',
        'Search returns excerpts and groups matching documents with the same normalized title. group_size counts allowed matching documents across the search; total counts matching groups, capped at 1000. eq means exact, gte a lower bound. Repeat filters with --cursor; restart without it after changing filters or credentials. Restricted agents and bots search only the intersection of person discovery and their readable project range, without version summaries. Publishers, bridge and bootstrap cannot list/search.',
        'Rephrase the query and search again before concluding that nothing exists. Completed zero-result searches succeed with search_hint: "Rephrase the query and search again before concluding that nothing exists." Retry with fewer or different words. With two or more normalized terms and no matches for all terms, search automatically retries for any of the terms; no additional flag or OR syntax is needed. Its search_hint is: "No documents matched all query terms. These results match any of the terms. Rephrase the query and search again."',
        'HTTP 429: search_daily_limit_exceeded. Full-text search shares 1,000 requests per actor per UTC day across clients. Wait until error.details.retry_at (UTC ISO); retry_after_seconds mirrors Retry-After. Title-only listing is unaffected.',
        'HTTP 503: Search capacity exceeded (search_capacity_exceeded). Narrow the query or filters and search again. This error is not a zero-result search. The CLI reports it as service_error with details.api_code search_capacity_exceeded; MCP returns the search_capacity_exceeded tool error.',

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
    'artifacts versions': {
      '--cursor':
        '前の履歴ページで返った next_cursor を指定します。最初から取得する場合は省略します。',
    },
    'artifacts get': {
      '--version':
        '読み取る公開済みのバージョンの ID。省略すると現在の本文を返します。',
    },
    share: {
      '--expected-version':
        '--key で更新するときの現在のバージョン ID。バージョン番号ではなく、前回の share / update で返った data.version.id を指定します（artifacts get では data.version_id）。',
    },
    update: {
      '--expected-version':
        '更新対象の現在のバージョン ID。バージョン番号ではなく、前回の share / update で返った data.version.id を指定します（artifacts get では data.version_id）。agent プリセットでログインしているときは必須です。',
    },
    download: {
      '--force': '既存の出力を置き換え、復旧用のバックアップを残します。',
    },
    edit: {
      '--retain-versions':
        'N または all（所有者のみ）。最新の N バージョンを残します。publisher の資格情報で作成したファイルや publisher クライアントに割り当てたファイルでは、publisher が追加したバージョンだけを数え、人が追加したバージョンはすべて残します。削除された古いバージョンは元に戻せません。all で上限を解除します。',
    },
  },
  title: 'Artifact Share CLI リファレンス',
  intro:
    'ターミナルからファイルを共有、更新、読み取り、整理するための公開リファレンスです。',
  tocTitle: 'このページの内容',
  sections: {
    introduction: {
      title: '導入と認証',
      body: [
        `Node.js 22.19 以降が必要です。まず ${CLI_REFERENCE_EXAMPLES.init} を実行してブラウザでログインします。CI 環境では、代わりに profiles import-token でトークンを取り込んで使います。`,
        `Claude Code のユーザー向けスキルは、CLAUDE_CONFIG_DIR が設定されていればその配下の skills、未設定なら ~/.claude/skills に配置されます。相対パスは CLI の作業ディレクトリを基準に解決され、~ は展開しません。空文字や空白だけのときは自動書き込みを行わないため、空でないパスを設定するか環境変数を解除してください（利用できない理由は skills list や doctor で確認できます）。スキルフォルダを共有するディレクトリリンクはリンク先ごとに一度だけ処理し、aliases と resolved_folder_path を表示します。同梱パス・所有権記録・更新途中の記録・CLI の予約パスに含まれないユーザー追加リンクはたどらずに無視し、user_links に表示します。所有権記録や管理対象の旧ルールがない未管理フォルダは、SKILL.md や references がリンクであっても update / remove の双方で skipped_unmanaged として残し、list / doctor でもリンク先を読まずに未管理と表示します。管理対象のフォルダや強制インストールでは、保護対象パスのリンクは --force を付けても拒否されるため、リンクを通常のファイルやディレクトリへ置き換えるか削除してください。手元で編集したファイルを上書きするには skills update --force を使います。--dry-run 以外の更新では途中で止まった更新の一時ファイルを削除しますが、--dry-run では削除しません。新しい CLI が入れたバージョンには update_available: false と理由を hint に表示して更新を勧めず、skills install / skills update は --force を明示したときだけダウングレードします。`,
        `login --preset agent を使うと、AI エージェントの権限を、選んだ 1 つのプロジェクトだけに絞れます。新しいプロファイルの既定は unrestricted で、既存プロファイルは前回の preset を引き継ぎます。資格情報は --profile で分けられ、ブラウザでログインした CLI セッションは logout、API トークンは「設定」→「トークン」から失効できます。`,
        `publisher は API 専用の資格情報です。バージョンの追加で返る shareUrl は HTML・Markdown・静的サイトのいずれも共有範囲によらず /a/:id 形式になり、開くときは通常のアクセス確認とホスト振り分けが動きます（人による更新の URL は従来どおりです）。publisher が追加したバージョンは定期更新として扱われ、一覧の並び順・フィード・未読表示は変わりません。履歴には定期更新の印が付き、API の updated_at には実際の更新時刻が入ります。認証時は device_name を指定し、ブラウザで新規クライアントを作るか既存クライアントを使い続けるかを選びます（同名での新規作成はできないため、別の名前でやり直してください）。この資格情報で扱えるのは、ホームに自分だけの公開範囲で作ったファイル・静的サイトと、作成または割り当て済みの対象に限られます。単一ファイルの更新には expected_version、静的サイトの差分更新には base_version と delete_path を使い、download は単一ファイルなら元データ、静的サイトならパスとハッシュのマニフェストを返します（個別アセットの取得はできません）。内容の取得時は共有範囲も返り、静的サイトではメタデータのみ返ります。また、削除と POST/PATCH による retain_versions（正の整数または null）の変更が可能で、上限を超えた古いバージョンの削除は取り消せません。publisher で作成・割り当てされたファイルでは、以前のクライアント分を含め publisher が追加したバージョンだけを数え、最新 N バージョンと現在のバージョン、さらに人が追加したすべてのバージョンを残します（下書きは数えません。所有者が unrestricted 資格情報で設定するときも同じ規則で、それ以外のファイルは従来どおり全公開版を数えます）。所有者は unrestricted 資格情報かブラウザセッションから POST /api/cli/artifacts/:id/adopt に whoami/doctor で確認した publisher_client_id を送り、既存ファイルを割り当てられます（以前のクライアントのアクセスは置き換わり、監査ログに記録されます）。なお、publisher の資格情報では一覧・解決・コメント・共有範囲変更・移動・プロジェクト操作・追記・上書き投稿は利用できず、CLI での publisher ログインや投稿・ダウンロードにも対応していません。クライアントの権限範囲は doctor で確認できます。`,
      ],
    },
    basics: {
      title: '基本操作',
      body: '操作対象にはファイル ID、共有リンク、artifactshareusercontent.com のバージョン付き実行 URL（認証済みは a-、リンク閲覧は l-）を指定できます。旧配信 URL は ID の解決にのみ使えます。コマンドの役割は、新規共有が share、同じ URL のままの更新が update、読み取りが open または artifacts get、ローカル保存が download、レビューが comments、整理が projects、アカウントと設定が profiles と config、エージェントの準備が skills です。REST API の POST /api/shareables/:id/versions?artifact_kind=static_site では、base_version=v1 と繰り返しの delete_path（例: delete_path=data/old.parquet）を指定して、送信したファイルだけを更新し残りを現在のバージョンから引き継げます。基準にできるのは現在の公開版に限られ、古い場合は 409 version_conflict が返ります。base_version はエージェント更新時の expected_version の代わりにもなります（両方指定する場合は同じ値にしてください）。削除には基準の指定が必要で、同じパスの送信と削除は同時に行えません。削除だけの更新でも index.html または index.md は残してください。バージョンのサイズはファイル一覧の合計、保存容量は重複を除いた実体の合計です。CLI の update には継承用のオプションはありません。また、ブラウザの共有ページは URL のフラグメント（#）を HTML・Markdown・静的サイトへ渡し、フレーム内の変化を共有ページの URL へ反映します。「リンクをコピー」にも含まれるため、絞り込み状態や見出し位置をそのまま共有できます。静的サイトでは最初に開くページだけがフラグメントを更新し、サブページでは変わりません。CLI のローカルプレビューは対象外です。',
    },
    commands: {
      title: 'コマンドリファレンス',
      body: '以下のコマンド一覧は、公開 CLI の help から自動生成しています。構文と使えるオプションも、生成済みのスナップショットから表示しています。',
    },
    'json-exit': {
      title: 'JSON と終了コード',
      body: '--json、パイプ、その他の非対話実行では、成功時に schema_version: 2、ok: true、command、data を含む共通形式で stdout へ出力し、失敗時は schema_version: 2、ok: false、command、error を stderr へ出力します。ツールを絞らずに実行した skills update / remove で一部だけ失敗した場合は、stdout の ok: true と data.targets を保ったまま失敗行に action: failed、code: skill_update_conflict、hint を返し、終了コード 1 で終わります。終了コードは 0 が成功、1 がコマンドの失敗、130 がキャンセルです。auth_required が返った場合は含まれている verification URL と user code で承認し、同じコマンドを再実行してください。',
    },
    destinations: {
      title: 'project、home、共有範囲、設定',
      body: '投稿先の一覧には、現在投稿できる有効なプロジェクトだけが表示されます。非公開プロジェクトへ投稿できるのは、作成者、Team プランの有効なオーナー・管理者、または確認済みメールアドレスで登録された contributor / manager です。Free / Plus の管理者権限、閲覧権限、ファイル単位の個別共有だけでは投稿できません。人間のエージェントは本人が承認した 1 つの投稿先に制限され、ワークスペースの bot は管理者が承認した複数の投稿先を資格情報の再取り込みなしで選べます。非公開プロジェクト向けのレポートでは --visibility project を明示してください（いずれも非公開プロジェクトでは contributor / manager の権限が必要です）。publisher はプロジェクトを選べません。edit では --visibility private|workspace|project|link を指定できますが、project を指定するには編集後の保存先がプロジェクトである必要があり、必要なら同じコマンドで --project-id <id> を指定します。home に対する明示的な --visibility project（--home との併用を含む）は変更せずに拒否されます。プロジェクトのファイルを home に移す場合、project を明示していなければ private になります。プロジェクトへ投稿したファイルはそのプロジェクトの共有範囲に届き、投稿先を省略した share は home へ投稿されます。home_audience は目的に応じて使い分けます。個人の安全な既定値には user、参加者全員で合意した方針には repository、1 回だけの指定には明示の --visibility を使い、実効値は config get home_audience --scope effective --json で確認します。基準となる設定キーは home_audience（private は自分だけ、workspace は社内全員）で、repository 設定は .artifactshare/config.json、user 設定は user config ディレクトリに保存されます。home の解決順は repository の home_audience → repository の default_artifact_visibility → user の home_audience → user の default_artifact_visibility → アカウントに応じた製品既定値です。未設定時は、ワークスペース共有を使えるアカウントなら workspace、それ以外は private になります。明示指定や設定で workspace を選んだ場合は、利用できなければエラーになり、自動で link へは切り替わりません（リンク共有には --visibility link を明示してください）。config はオフラインで動くため、source が product_default の workspace は未確定の方針を表し、share とプレビュー時にアカウントを確認して確定します。whoami と doctor は workspace.visibility_available を返します（この項目を返さない旧サーバーでは workspace と従来のエラー動作を維持します）。private へ切り替わったときの共有結果には visibility_source: product_default_private と visibility_hint が含まれます。default_artifact_visibility は互換性のための別名、default_project_visibility は projects create 用の、ほかの設定とは別の既定値です。--grant-email はプロジェクトの個別共有先を足すだけで、プロジェクトの visibility 自体は変えません。',
    },
    recovery: {
      title: '失敗と復旧',
      body: [
        'artifacts list --q は本文とタイトル、--query はタイトルだけを検索します。両方の同時指定や、--query と所有者・期間フィルターの併用は validation_failed になります。--owner-user-ids にはメールアドレスではなくユーザー ID を繰り返し指定でき（MCP では owner_user_ids 配列）、--project-id または --home で場所を絞れます。期間は --date-field updated|viewed と --days 7|30|90、または ISO 形式の --from/--to で指定します（日付だけの上限はその UTC 日を含みます）。API では空の q で一覧検索になりますが、CLI の --q は空文字を指定できません。',
        '検索は抜粋を返し、正規化したタイトルが同じ文書を 1 つにまとめます。group_size は一致した閲覧可能な文書数、total はグループ総数（上限 1000、eq は正確な件数、gte は下限）です。--cursor で続きを取得するときは同じ条件を繰り返し、条件や資格情報を変えたら cursor なしでやり直してください。制限付きエージェントとボットは、発見可能かつ資格情報で読めるプロジェクト内だけを検索し、バージョンの集計は返しません。publisher・bridge・bootstrap は一覧取得・検索とも利用できません。',
        '0 件でも存在しないと決めつけず、言い換えて再検索してください。正常に完了して 0 件だった場合は成功扱いとなり、search_hint: "Rephrase the query and search again before concluding that nothing exists." が返ります。語を減らすか別の語に変えて再検索してください。正規化後の語が 2 つ以上あり、すべての語に一致する文書がなければ、いずれかの語に一致する検索へ自動で切り替わります（追加フラグや OR 構文は不要です）。このときの search_hint は "No documents matched all query terms. These results match any of the terms. Rephrase the query and search again." です。',
        'HTTP 429 の search_daily_limit_exceeded は 1 日の検索回数上限に達したエラーです。全文検索は全クライアント共通で利用者 1 人につき UTC の 1 日あたり 1,000 回までです。error.details.retry_at（UTC）まで待ってから再実行してください（retry_after_seconds は Retry-After と同じ待ち時間です）。タイトルだけの一覧取得は回数に含まれません。',
        'HTTP 503 の search_capacity_exceeded は検索容量の上限を超えたエラーです。検索語や条件を絞って再検索してください（検索が成功して 0 件だったわけではありません）。CLI では service_error（details.api_code が search_capacity_exceeded）、MCP では search_capacity_exceeded のツールエラーとして返ります。',

        'download で扱う ID は ^[a-z0-9]{10}$ に限られ、一覧や index に不正な ID や重複があると書き込み前に拒否されます。出力先の親ディレクトリがリンクであっても使用でき、リンク先の同一性を再確認します。一方、出力ルート・index・一覧に含まれるファイルツリー内のリンクは --force を付けても拒否されます。事前検査では変更のない対象を含む全ファイルと index を確認し、無関係な内容は走査しません。通信エラーやマニフェストの不備（パス・内容・ID）はファイルごとの失敗として記録しますが、書き込み境界の違反を検出すると後続のファイルと最終 index の公開を中断します。置き換え前のデータと index は成功後も保持され、data.backup_paths と人向け出力に保存先が表示されます。復旧に失敗したときもエラーに保存先が出るため、内容を確認してから手動で削除してください。',
        '設定保存時の init は、設定パスのリンクや途中の差し替えを拒否します（Node のパスベース操作では、検査と操作の間の同時変更まで原子的に防ぐ保証はありません）。init は未知の設定キーをそのまま残します。Git worktree や submodule でも設定は保存できますが、.git ファイル、リンク、.git 内の gitdir / commondir ファイル、安全に更新できない exclude は git_exclude_warning となり、手動で追加すべき行を案内します。',
        'Windows の短い名前など別表記で指定したファイルも、保存されている本来の名前から種類と content type を判定します。列挙後に消えたファイルは changed、途中に通常ファイルを含む相対パス（例: file.txt/x）は not_found になります。share・append・update の相対パスは物理的なカレントディレクトリ内に限られ、途中のリンクも拒否されます。絶対パスは親ディレクトリを信頼しますが、選択対象とその配下のリンクは拒否されます。親ディレクトリ参照（..）を含むパスは使えないため、直接の絶対パスを指定するか、リンク先を対象範囲内へコピーしてください。ドット（.）で始まる名前と除外対象は検査前に省きます。ローカル読み取りは認証やプロジェクト検索の前に完了させ、認証の再試行時には検証済みの内容を再利用します。validation_failed が出たときは details.path と details.reason（parent_traversal、link、outside_cwd、not_found、changed、unsupported_guarantee、invalid_type）を確認し、パスの見直しや絶対パス指定、再試行、個別ヒントに従って対処してください。upload_read_failed は details.errno とファイルシステムの状態・権限を確認して再試行します。POSIX では利用可能な no-follow open を使い、Windows ではハンドルの同一性を確認して lstat がリンクと判定した対象を拒否します（ただし検査中の差し替え・復元や同サイズの書き換えは検出できない場合があります）。',
        'auth_required または token_invalid のときは、login をやり直すか有効なトークンをプロファイルに取り込んでから同じコマンドを再実行します。unknown_option は認証・通信・書き込みの前に返るため、details.option をヒントやヘルプに沿って修正してください。invalid_expected_version ではバージョン番号ではなく、share / update 出力の data.version.id か artifacts get <target> --json の data.version_id を渡します（いずれも recovery.kind: change_input）。unsupported_node_version は Node.js を 22.19.0 以上へ更新する必要があり、人や実行環境側での対応が求められます（recovery.kind: ask_human、agent_recoverable: false、requires_human: true）。details.reason のない validation_failed は構文とオプションを、target_not_found は URL や ID を確認し直します。self_upload_disabled は Google または Microsoft でログインして再実行し、network_failed は base URL を確認して投稿先を変えずに再試行します。login --preset agent で expected_version_required が返ったときは、前回成功した share / update 出力の data.version.id を --expected-version に渡して再実行してください。前回の出力がない場合は、単一 HTML / Markdown なら artifacts get <target> --json の data.version_id、静的サイトなら download <target> --json の data.version.id を取得し、現在の内容（data.content またはダウンロードしたファイル）が編集元と違っていれば変更を適用し直したうえで --expected-version に指定します。',
      ],
    },
    related: {
      title: '関連ガイド',
      body: '接続方法は接続ガイド、エージェントへの頼み方は「AI から Artifact Share を使う」ガイド、変更履歴は更新情報、パッケージの詳細は npm ページをご覧ください。',
    },
  },
  commandsHeading: '公開コマンド一覧',
  commandUsageLabel: '構文',
  commandOptionsLabel: 'オプション',
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
      '公開 CLI の全コマンド、JSON 出力、設定、投稿先、復旧方法をまとめたリファレンスです。',
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
