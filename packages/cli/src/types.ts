import type { FormData, RequestInit } from 'undici'

export type CliOptions = {
  allowPlaintextTokenStore?: boolean
  baseUrl?: string
  body?: string
  dryRun?: boolean
  force?: boolean
  grantEmail?: string | string[]
  help?: boolean
  home?: boolean
  include?: string | string[]
  insecureLocalhost?: boolean
  json?: boolean
  key?: string | true
  linkExpiresAt?: string
  noLinkExpiry?: boolean
  noSlackNotify?: boolean
  note?: string
  offset?: string
  output?: string
  profile?: string
  project?: string
  projectId?: string
  cursor?: string
  query?: string
  quote?: string
  quoteAfter?: string
  quoteBefore?: string
  replyTo?: string
  messageId?: string
  name?: string
  revokeEmail?: string | string[]
  scope?: string
  threadId?: string
  title?: string
  token?: string
  tool?: string | string[]
  addEmail?: string | string[]
  archive?: boolean
  removeEmail?: string | string[]
  unarchive?: boolean
  visibility?: string
  [key: string]: boolean | string | string[] | undefined
}

export type ParsedArgs = {
  command: CliCommand | undefined
  options: CliOptions
  positionals: string[]
}

export type CliCommand =
  | 'append'
  | 'login'
  | 'logout'
  | 'share'
  | 'open'
  | 'update'
  | 'edit'
  | 'delete'
  | 'resolve'
  | 'download'
  | 'artifacts'
  | 'artifacts list'
  | 'artifacts get'
  | 'comments'
  | 'comments list'
  | 'comments post'
  | 'comments edit'
  | 'comments resolve'
  | 'comments reopen'
  | 'comments delete'
  | 'whoami'
  | 'doctor'
  | 'profiles'
  | 'profiles list'
  | 'profiles use'
  | 'profiles import-token'
  | 'profiles delete'
  | 'projects'
  | 'projects list'
  | 'projects create'
  | 'projects edit'
  | 'move'
  | 'skills'
  | 'skills install'
  | 'skills ensure'
  | 'skills list'
  | 'skills update'
  | 'skills remove'
  | 'config'
  | 'config get'
  | 'config set'
  | 'config unset'
  | 'init'
  | 'changelog'

export type ChangelogLatestEntry = {
  version: string
  date: string
  body: string
}

export type ChangelogData = {
  version: string
  updates_url: string
  latest: ChangelogLatestEntry | null
}

export type OutputMode = {
  json: boolean
}

export type Recovery =
  | { kind: 'ask_human' }
  | { kind: 'change_input' }
  | { kind: 'report_issue' }
  | { kind: 'retry_later' }
  | { kind: 'run_command'; command: string }

export type CliError = {
  code: string
  message: string
  why: string
  hint: string
  agent_recoverable: boolean
  requires_human: boolean
  recovery: Recovery
  details?: Record<string, unknown>
}

export type CliErrorArgs = {
  code: string
  message: string
  why: string
  hint: string
  agentRecoverable: boolean
  requiresHuman: boolean
  recovery: Recovery
  details?: Record<string, unknown>
}

export type ProjectConfig = {
  default_project_id?: string | null
  default_profile?: string | null
  home_audience?: ArtifactVisibility
  default_artifact_visibility?: ArtifactVisibility
  default_project_visibility?: ArtifactVisibility
}

export type ArtifactVisibility = 'workspace' | 'private'
export type HomeAudienceConfigKey =
  | 'home_audience'
  | 'default_artifact_visibility'
export type ProjectVisibilityConfigKey = 'default_project_visibility'
export type ConfigKey = HomeAudienceConfigKey | ProjectVisibilityConfigKey

export type CredentialSource =
  | 'env'
  | 'token_option'
  | 'profile'
  | 'local_config'
  | 'project_config'
  | 'global_profile'
  | 'none'

export type ProfileCredentialSource = Extract<
  CredentialSource,
  'profile' | 'local_config' | 'project_config' | 'global_profile'
>

export function isProfileCredentialSource(
  source: CredentialSource | undefined,
): source is ProfileCredentialSource {
  return (
    source === 'profile' ||
    source === 'local_config' ||
    source === 'project_config' ||
    source === 'global_profile'
  )
}

export type ConfigValueSource = 'local' | 'project' | 'global' | 'none'

export type TokenStoreKind =
  | 'macos_keychain'
  | 'linux_secret_service'
  | 'plaintext_file'

export type ProfileCredentialKind = 'session' | 'api_token'

export type StoredProfileCredential =
  | {
      kind: 'session'
      session_token: string
      refresh_token: string
      expires_at?: string | null
      pending_rotation_id?: string
      device_id?: string
    }
  | {
      kind: 'api_token'
      token: string
    }

export type ProfileConfigEntry = {
  base_url?: string
  email?: string | null
  workspace_id?: string | null
  token_store?: TokenStoreKind
  updated_at?: string
}

export type GlobalConfig = {
  default_profile?: string | null
  profiles?: Record<string, ProfileConfigEntry>
  home_audience?: ArtifactVisibility
  default_artifact_visibility?: ArtifactVisibility
  default_project_visibility?: ArtifactVisibility
}

export type Destination =
  | { containerId: string | null; error?: never }
  | { error: CliError; containerId?: never }

export type FetchInit = RequestInit & {
  insecureLocalhost?: boolean
}

export type RequestConfig =
  | { init: FetchInit; error?: never }
  | { error: CliError }

export type ApiErrorOptions = {
  operation?: 'append'
  authenticated?: boolean
  artifactTarget?: boolean
  baseUrl?: string
  credentialSource?: CredentialSource
  profileCredentialKind?: ProfileCredentialKind | undefined
  editSettings?: boolean
  profile?: string | undefined
  projectTarget?: boolean
}

export type DirectoryFile = {
  path: string
  relativePath: string
}

export type UploadPayload = {
  form: FormData
  kind: 'html_page' | 'markdown_page' | 'static_site'
}

export type UploadPayloadResult =
  | { payload: UploadPayload; error?: never }
  | { error: CliError; payload?: never }

export type NetworkFailure = {
  networkError: unknown
}

export type ApiBody = {
  id?: string | null
  shareUrl?: string | null
  artifactKind?: string | null
  versionId?: string | null
  query?: string
  candidates?: unknown[]
  project?: unknown
  projects?: unknown[]
  artifacts?: unknown[]
  limit?: number
  next_cursor?: string | null
  visibility?: string
  link_expires_at?: string | null
  has_more?: boolean
  share_url?: string
  version_id?: string
  format?: string
  content?: string
  size_bytes?: number
  truncated?: boolean
  next_offset?: number | null
  artifact_kind?: string
  artifact_id?: string
  access_token?: string
  token_type?: string
  refresh_token?: string
  refresh_token_expires_at?: string
  expires_at?: string
  comments?: unknown[]
  thread_id?: string
  thread_deleted?: boolean
  deleted?: boolean
  reply?: boolean
  thread?: unknown
  files?: unknown[]
  total_size_bytes?: number
  auth?: { ok?: boolean }
  user?: { email?: string | null }
  upload?: { ok?: boolean; code?: unknown }
  status?: string | null
  created?: boolean
  message?: string
  error?: string | { code?: unknown; message?: string; details?: unknown }
}

export type ProfilesListEntry = {
  name: string
  base_url: string | null
  email: string | null
  workspace_id: string | null
  token_store: TokenStoreKind | null
  updated_at: string | null
  is_default: boolean
  token_present: boolean
}

export type ProfilesListData = {
  default_profile: string | null
  profiles: ProfilesListEntry[]
}

export type ProfilesImportTokenData = {
  profile: string
  token_store: TokenStoreKind
  user: { email: string | null }
  workspace: { id: string | null; hosted_domain: string | null }
  base_url: string
}

export type LogoutData = {
  profile: string
  credential_removed: boolean
  token_store: TokenStoreKind | null
}

export type ProfilesDeleteData = {
  profile: string
  credential_removed: boolean
  token_store: TokenStoreKind | null
  profile_deleted: true
  previous_default: string | null
  default_profile: string | null
}

export type ProjectsListEntry = {
  id: string
  name: string | null
  description: string | null
  base_visibility: string | null
  file_count: number | null
  updated_at: string | null
  is_default: boolean
}

export type ProjectsListData = {
  default_project_id: string | null
  projects: ProjectsListEntry[]
}

export type ProjectsCreateData = {
  project: {
    id: string
    name: string | null
    description: string | null
    base_visibility: string | null
  }
  next_command: string
}

export type ProjectsEditData = {
  project: {
    id: string
    name: string | null
    description: string | null
    base_visibility: string | null
    file_count: number | null
    archived: boolean
  }
  audience: string[]
}

export type MoveData = {
  artifact: {
    id: string
    url: string | null
  }
  destination:
    | { type: 'project'; project_id: string }
    | { type: 'home'; project_id: null }
  share: {
    visibility: string
    project_audience_may_change: boolean
  }
}

export type EditData = {
  artifact: {
    id: string
    url: string | null
  }
  title: string
  destination:
    | { type: 'project'; project_id: string }
    | { type: 'home'; project_id: null }
  share: {
    visibility: string
    link_expires_at: string | null
  }
}

export type SkillsTargetAction =
  | 'installed'
  | 'updated'
  | 'update_recommended'
  | 'unchanged'
  | 'removed'
  | 'not_installed'
  | 'skipped_unmanaged'

export type SkillsActionTarget = {
  tool: string
  scope: string
  path: string
  action: SkillsTargetAction
  update_command?: string
}

export type SkillsActionData = {
  dry_run: boolean
  targets: SkillsActionTarget[]
}

export type SkillAutoUpdateTarget = {
  tool: string
  scope: 'user'
  path: string
  action: 'updated' | 'update_recommended'
  installed_version: number
  bundled_version: number
  update_command?: string
}

export type SkillAutoUpdateData = {
  targets: SkillAutoUpdateTarget[]
}

export type SkillAutoUpdateContainer = {
  skills?: {
    auto_update?: SkillAutoUpdateData
  }
}

export type OpenData = {
  skills: SkillsActionData
  open:
    | { kind: 'read'; artifact: ArtifactGetData }
    | { kind: 'download_required'; next_command: string }
}

export type SkillsListTarget = {
  tool: string
  scope: string
  path: string
  detected: boolean
  installed: boolean
  managed: boolean
  installed_version: number | null
  update_available: boolean
}

export type SkillsListData = {
  bundled_version: number
  targets: SkillsListTarget[]
}

export type InitConfigData = {
  mode: 'config'
  path: string
  written: boolean
  config: {
    default_profile: string | null
    default_project_id: string | null
  }
  read_path?: string
  git_exclude_applied?: boolean
  git_exclude_warning?: string
}

export type InitNextStep = {
  id: 'login' | 'share'
  title: string
  command: string
  done?: boolean
  requires_browser_approval?: boolean
  awaits_user_action?: boolean
}

export type InitOnboardingData = {
  mode: 'onboarding'
  skills: SkillsActionData
  signed_in: boolean
  next_steps: InitNextStep[]
}

export type InitData = InitConfigData | InitOnboardingData

export type DoctorConfigFileData = {
  present: boolean
  path: string | null
  default_profile: string | null
  default_project_id: string | null
  code?: string
  hint?: string
}

export type DoctorConfigEffectiveData = {
  default_profile: string | null
  default_profile_source: ConfigValueSource
  default_profile_path: string | null
  default_project_id: string | null
  default_project_id_source: ConfigValueSource
  default_project_id_path: string | null
}

export type DoctorConfigData = {
  local: DoctorConfigFileData
  project: DoctorConfigFileData
  global: {
    present: boolean
    default_profile: string | null
    profile_count: number
  }
  effective: DoctorConfigEffectiveData
}

export type DoctorSkillsTarget = {
  tool: string
  scope: string
  path: string
  installed: boolean
  managed: boolean
  installed_version: number | null
  update_available: boolean
  update_command: string | null
}

export type DoctorSkillsData = {
  bundled_version: number
  update_available: boolean
  update_command: string | null
  targets: DoctorSkillsTarget[]
}

export type AuthRecoveryData = {
  login_command: string
  token_url: string
  env_var: string
  token_option: string
}

export type PendingDeviceAuth = {
  base_url: string
  profile: string
  device_code: string
  verification_uri: string
  verification_uri_complete: string | null
  user_code: string
  expires_at: string
  interval_seconds: number
  created_at: string
}

export type DeviceAuthErrorDetails = {
  profile: string
  verification_uri: string
  verification_uri_complete: string | null
  user_code: string
  expires_at: string
  interval_seconds: number
  instruction: string
  retry_hint: string
}

export type DoctorData = {
  next_command: string | null
  base_url: string
  config: DoctorConfigData
  skills: DoctorSkillsData
  auth: {
    credential_source: CredentialSource
    profile?: string
    token_present: boolean
    ok: boolean
    code?: string
    hint?: string
    email?: string | null
    recovery?: AuthRecoveryData
  }
  destination:
    | { ok: false; code: string; hint: string }
    | { ok: true; type: 'project' | 'home'; project_id: string | null }
  network: {
    ok: boolean
    code?: string
    hint?: string
  }
  upload: {
    ok: boolean
    checked: boolean
    code?: string | null
    hint?: string
  }
}

export type ResolveData = {
  query?: string
  candidates?: unknown[]
  has_more?: boolean
}

export type ArtifactGetData = {
  id?: string
  share_url?: string
  version_id?: string
  format?: string
  content?: string
  size_bytes?: number
  truncated?: boolean
  next_offset?: number | null
  link_expires_at?: string | null
}

export type ArtifactsListEntry = {
  id: string
  title: string
  share_url: string
  visibility: string
  link_expires_at?: string | null
  updated_at: string
  project_id: string | null
  owner_email?: string
  artifact_kind?: string
}

export type ArtifactsListData = {
  artifacts: ArtifactsListEntry[]
  limit: number
  has_more: boolean
  next_cursor: string | null
}

export type DeleteData = {
  id: string
  deleted: true
}

export type CommentsListData = {
  artifact_id: string
  share_url: string | null
  comments: unknown[]
  has_more: boolean
}

export type CommentsPostData = {
  artifact_id: string
  share_url: string | null
  thread_id: string
  reply: boolean
  thread: unknown
}

export type CommentsActionData = {
  artifact_id: string
  share_url: string | null
  thread_id: string
  thread: unknown
}

export type CommentsDeleteData = {
  artifact_id: string
  share_url: string | null
  thread_id: string
  deleted: true
  thread_deleted: boolean
  thread?: unknown
}

export type DownloadManifestFile = {
  path: string
  size_bytes: number
  content_type: string
  sha256: string
}

export type DownloadManifest = {
  id: string
  share_url: string
  version_id: string
  artifact_kind: string
  files: DownloadManifestFile[]
  total_size_bytes: number
  project_id?: string | null
}

export type DownloadPlan = {
  root: string
  tempRoot: string
  replaceExisting: boolean
  files: Array<DownloadManifestFile & { targetPath: string }>
}
