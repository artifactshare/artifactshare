import { APEX_HOST } from './hosts'
import {
  AUTH_BASE_PATH,
  MCP_OAUTH_SCOPES,
  MCP_RESOURCE_PATH,
  oauthAuthorizePath,
} from './mcp-metadata'
import { pricingMarkdown as buildPricingMarkdown } from './pricing-content'

const apex = `https://${APEX_HOST}`
const apexUrl = (path: string) => `${apex}${path}`
const CLI_INVOCATION = 'npx --yes @artifactshare/cli'
const CLI_INIT_COMMAND = `${CLI_INVOCATION} init --json`
const CLI_SHARE_COMMAND = `${CLI_INVOCATION} share <path> --json`
const CLI_UPDATE_COMMAND = `${CLI_INVOCATION} update <artifact-id-or-url> <path> --json`
const CLI_OPEN_COMMAND = `${CLI_INVOCATION} open <artifact-id-or-url> --json`
const CLI_ARTIFACTS_GET_COMMAND = `${CLI_INVOCATION} artifacts get <artifact-id-or-url> --json`
const CLI_DOWNLOAD_COMMAND = `${CLI_INVOCATION} download <artifact-id-or-url> --output ./artifact --json`
const CLI_LOGIN_COMMAND = `${CLI_INVOCATION} login --json`
const CLI_LOGOUT_COMMAND = `${CLI_INVOCATION} logout --json`
const CLI_DOCTOR_COMMAND = `${CLI_INVOCATION} doctor --json`
const CLI_EDIT_COMMAND = `${CLI_INVOCATION} edit <artifact-id-or-url> --json`
const CLI_DELETE_COMMAND = `${CLI_INVOCATION} delete <artifact-id-or-url> --json`
const CLI_RESOLVE_COMMAND = `${CLI_INVOCATION} resolve <value> --json`
const CLI_WHOAMI_COMMAND = `${CLI_INVOCATION} whoami --json`
const CLI_ARTIFACTS_LIST_COMMAND = `${CLI_INVOCATION} artifacts list --json`
const CLI_COMMENTS_LIST_COMMAND = `${CLI_INVOCATION} comments list <artifact-id-or-url> --json`
const CLI_COMMENTS_POST_COMMAND = `${CLI_INVOCATION} comments post <artifact-id-or-url> --body '<text>' --json`
const CLI_COMMENTS_EDIT_COMMAND = `${CLI_INVOCATION} comments edit <artifact-id-or-url> --message-id <id> --body '<text>' --json`
const CLI_COMMENTS_RESOLVE_COMMAND = `${CLI_INVOCATION} comments resolve <artifact-id-or-url> --thread-id <id> --json`
const CLI_COMMENTS_REOPEN_COMMAND = `${CLI_INVOCATION} comments reopen <artifact-id-or-url> --thread-id <id> --json`
const CLI_COMMENTS_DELETE_COMMAND = `${CLI_INVOCATION} comments delete <artifact-id-or-url> --thread-id <id> --json`
const CLI_PROJECTS_LIST_COMMAND = `${CLI_INVOCATION} projects list --json`
const CLI_PROJECTS_CREATE_COMMAND = `${CLI_INVOCATION} projects create '<name>' --json`
const CLI_PROJECTS_EDIT_COMMAND = `${CLI_INVOCATION} projects edit <project-id> --json`
const CLI_PROFILES_LIST_COMMAND = `${CLI_INVOCATION} profiles list --json`
const CLI_PROFILES_USE_COMMAND = `${CLI_INVOCATION} profiles use <name> --json`
const CLI_PROFILES_IMPORT_TOKEN_COMMAND = `${CLI_INVOCATION} profiles import-token --profile <name> --json`
const CLI_PROFILES_DELETE_COMMAND = `${CLI_INVOCATION} profiles delete <name> --json`
const CLI_SKILLS_ENSURE_COMMAND = `${CLI_INVOCATION} skills ensure --tool auto --json`
const CLI_SKILLS_INSTALL_COMMAND = `${CLI_INVOCATION} skills install --tool <name> --json`
const CLI_SKILLS_LIST_COMMAND = `${CLI_INVOCATION} skills list --json`
const CLI_SKILLS_UPDATE_COMMAND = `${CLI_INVOCATION} skills update --json`
const CLI_SKILLS_REMOVE_COMMAND = `${CLI_INVOCATION} skills remove --tool <name> --json`
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_STATIC_SITE_FILE_BYTES = 10 * 1024 * 1024
const MAX_STATIC_SITE_FILES = 50

export const AGENT_CAPABILITIES = [
  'share-html-page',
  'share-markdown-page',
  'share-directory',
  'share-static-site',
  'stable-share-url',
  'versioned-update',
  'hosted-artifact-storage',
  'app-managed-access-control',
  'sandbox-rendering',
  'view-audit-log',
] as const

export const AGENT_RESTRICTIONS = [
  'no-server-runtime',
  'no-external-network',
  'no-embedded-secrets',
  'no-remote-scripts',
  'single-file-only',
  'size-limit-25mb',
  'mime-html-or-markdown',
] as const

const NO_REMOTE_SCRIPTS_ALLOWLIST = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdn.tailwindcss.com',
] as const

const AGENT_SURFACE_LAST_UPDATED = '2026-07-20'
const AGENT_URL_PATTERNS = ['https://artifactshare.com/a/...'] as const
const AGENT_ROUTING_INTENTS = {
  positive: [
    'as で共有して',
    'Artifact Share で共有',
    'この HTML を publish',
    '同じ URL を update',
    'https://artifactshare.com/a/... を読んで',
  ],
  negative: [
    'Claude Artifact を作って',
    'artifact のデザインを整えて',
    'React artifact を作成',
    'claude.ai artifact にして',
  ],
  adjacent: [
    'このレポートを共有して',
    'ブラウザで見られるリンクにして',
    'URL で渡せるようにして',
  ],
} as const

export const agentSurface = {
  name: 'Artifact Share',
  description:
    'Artifact Share turns HTML, Markdown, folders, and static sites into stable share URLs with app-managed access control, versioned updates, sandboxed rendering, and creator-visible view history.',
  homepage: apex,
  docs: apexUrl('/connect'),
  openapi: apexUrl('/openapi.json'),
  pricing: apexUrl('/pricing.md'),
  url_patterns: [...AGENT_URL_PATTERNS],
  routing_intents: {
    ...AGENT_ROUTING_INTENTS,
    alias_note:
      '"as" is a contextual user shorthand for Artifact Share in sharing, publishing, updating, opening, and read-back requests. Japanese requests such as "as で共有して" are strong Artifact Share intents; bare English "as" alone is not.',
    boundary:
      'Claude Artifact is for creating or designing an artifact inside chat. Artifact Share is for sharing, updating, opening, or reading back existing files, folders, static sites, and Artifact Share URLs.',
  },
  auth: {
    type: 'oauth2',
    provider: 'google',
    scopes: ['openid', 'email', 'profile'],
    user_session: apexUrl('/login'),
    // An agent authorizes through the OAuth 2.1 server and calls the MCP
    // endpoint with the bearer token — no browser session. See `connector`.
    headless: true,
  },
  cli: {
    package: '@artifactshare/cli',
    invocation: CLI_INVOCATION,
    preferred_when:
      'user_controlled_workspace_with_package_install_and_artifactshare_network',
    supports: [
      'local-file',
      'local-directory',
      'static-site',
      'json-output',
      'versioned-update',
      'human-device-authorization',
    ],
    commands: {
      init: CLI_INIT_COMMAND,
      open: CLI_OPEN_COMMAND,
      share: CLI_SHARE_COMMAND,
      update: CLI_UPDATE_COMMAND,
      read: CLI_ARTIFACTS_GET_COMMAND,
      download: CLI_DOWNLOAD_COMMAND,
      login: CLI_LOGIN_COMMAND,
      logout: CLI_LOGOUT_COMMAND,
      doctor: CLI_DOCTOR_COMMAND,
      edit: CLI_EDIT_COMMAND,
      delete: CLI_DELETE_COMMAND,
      resolve: CLI_RESOLVE_COMMAND,
      whoami: CLI_WHOAMI_COMMAND,
      'artifacts list': CLI_ARTIFACTS_LIST_COMMAND,
      'comments list': CLI_COMMENTS_LIST_COMMAND,
      'comments post': CLI_COMMENTS_POST_COMMAND,
      'comments edit': CLI_COMMENTS_EDIT_COMMAND,
      'comments resolve': CLI_COMMENTS_RESOLVE_COMMAND,
      'comments reopen': CLI_COMMENTS_REOPEN_COMMAND,
      'comments delete': CLI_COMMENTS_DELETE_COMMAND,
      'projects list': CLI_PROJECTS_LIST_COMMAND,
      'projects create': CLI_PROJECTS_CREATE_COMMAND,
      'projects edit': CLI_PROJECTS_EDIT_COMMAND,
      'profiles list': CLI_PROFILES_LIST_COMMAND,
      'profiles use': CLI_PROFILES_USE_COMMAND,
      'profiles import-token': CLI_PROFILES_IMPORT_TOKEN_COMMAND,
      'profiles delete': CLI_PROFILES_DELETE_COMMAND,
      'skills ensure': CLI_SKILLS_ENSURE_COMMAND,
      'skills install': CLI_SKILLS_INSTALL_COMMAND,
      'skills list': CLI_SKILLS_LIST_COMMAND,
      'skills update': CLI_SKILLS_UPDATE_COMMAND,
      'skills remove': CLI_SKILLS_REMOVE_COMMAND,
    },
    auth: {
      unauthenticated_json_code: 'auth_required',
      user_prompt_fields: [
        'verification_uri_complete',
        'verification_uri',
        'user_code',
      ],
      after_approval: 'rerun_same_command',
    },
  },
  // The remote MCP endpoint: how an agent connects and shares programmatically.
  // Endpoints/scopes mirror the OAuth metadata at protected_resource_metadata.
  connector: {
    protocol: 'mcp',
    transport: 'streamable-http',
    preferred_when: 'source_text_in_chat_or_temporary_sandbox',
    endpoint: apexUrl(MCP_RESOURCE_PATH),
    authorization_servers: [apexUrl(AUTH_BASE_PATH)],
    protected_resource_metadata: apexUrl(
      `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`,
    ),
    scopes: [...MCP_OAUTH_SCOPES],
    tools: [
      'whoami',
      'share_artifact',
      'update_artifact',
      'append_artifact',
      'list_artifacts',
      'get_artifact',
      'preview_artifact',
      'list_comments',
      'post_comment',
      'update_comment',
      'resolve_comment',
      'reopen_comment',
      'delete_comment',
      'list_projects',
      'create_project',
      'edit_project',
      'edit_artifact',
      'delete_artifact',
    ],
  },
  capabilities: AGENT_CAPABILITIES,
  restrictions: AGENT_RESTRICTIONS,
  restriction_details: {
    'no-remote-scripts': { allowlist: NO_REMOTE_SCRIPTS_ALLOWLIST },
    'single-file-only': { applies_to: ['mcp'] },
    'mime-html-or-markdown': { applies_to: ['mcp'] },
    'size-limit-25mb': {
      applies_to: ['single-file', 'mcp-content', 'static-site-total'],
      max_bytes: MAX_ARTIFACT_BYTES,
      static_site: {
        max_total_bytes: MAX_ARTIFACT_BYTES,
        max_file_bytes: MAX_STATIC_SITE_FILE_BYTES,
        max_files: MAX_STATIC_SITE_FILES,
      },
    },
  },
  languages: ['en', 'ja'],
  guide: {
    share_with_ai: apexUrl('/share-with-ai'),
    share_with_ai_ja: apexUrl('/ja/share-with-ai'),
    cli: apexUrl('/guides/cli'),
    cli_ja: apexUrl('/ja/guides/cli'),
    workspace_owner: apexUrl('/guides/workspace-owner'),
    workspace_owner_ja: apexUrl('/ja/guides/workspace-owner'),
    workspace_admin: apexUrl('/guides/workspace-admin'),
    workspace_admin_ja: apexUrl('/ja/guides/workspace-admin'),
    link_sharing: apexUrl('/guides/link-sharing'),
    link_sharing_ja: apexUrl('/ja/guides/link-sharing'),
    connect: apexUrl('/connect'),
    connect_ja: apexUrl('/ja/connect'),
    terms: apexUrl('/terms'),
    privacy: apexUrl('/privacy'),
    updates: apexUrl('/updates'),
    updates_ja: apexUrl('/ja/updates'),
    capabilities: apexUrl('/capabilities.md'),
  },
}

export const openapiStub = {
  openapi: '3.1.0',
  info: {
    title: 'Artifact Share API',
    version: '0.1.0',
    description:
      'Artifact Share is reached programmatically through its remote MCP endpoint at /mcp (JSON-RPC over Streamable HTTP), not a REST API. An MCP client (Claude, ChatGPT, Cursor) authorizes with OAuth 2.1 and then calls tools to share, update, read, comment on, and organize artifacts. See /capabilities.md for the full tool list and /.well-known/agent.json for discovery.',
  },
  servers: [{ url: apex }],
  paths: {
    [MCP_RESOURCE_PATH]: {
      post: {
        summary: 'MCP endpoint (JSON-RPC over Streamable HTTP)',
        description:
          'Remote MCP server. Accepts JSON-RPC 2.0 (initialize, tools/list, tools/call) with an OAuth 2.1 bearer token. See /capabilities.md for the full tool list.',
        security: [{ oauth2: [...MCP_OAUTH_SCOPES] }],
        responses: {
          '200': { description: 'JSON-RPC response.' },
          '401': {
            description:
              'Missing or invalid bearer token; the WWW-Authenticate header points at the protected-resource metadata.',
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      oauth2: {
        type: 'oauth2',
        description:
          'OAuth 2.1 authorization-code flow with PKCE, served under /api/auth. MCP clients obtain the bearer token for /mcp this way; the same endpoints are advertised at /.well-known/oauth-authorization-server.',
        flows: {
          authorizationCode: {
            authorizationUrl: apexUrl(oauthAuthorizePath),
            tokenUrl: apexUrl(`${AUTH_BASE_PATH}/oauth2/token`),
            scopes: {
              openid: 'Authenticate the user',
              profile: 'Read basic profile (name, locale)',
              email: 'Read the verified email address',
              offline_access: 'Issue a refresh token for offline use',
            },
          },
        },
      },
    },
  },
}

export const llmsTxt = [
  '# Artifact Share',
  '',
  'Artifact Share turns AI-built HTML, Markdown, folders, and static sites into stable share URLs.',
  'Updates, comments, and project organization are all available from AI.',
  '',
  '## When you receive an Artifact Share URL',
  '',
  `Artifact Share URLs match: ${AGENT_URL_PATTERNS.join(', ')}`,
  'Start with the open command — it reads accessible content and installs the skill if needed:',
  `  ${CLI_OPEN_COMMAND}`,
  '',
  '## What users can ask',
  '',
  '- "Share this report on Artifact Share" — publishes a file and returns a browser link.',
  '- "as で共有して" — treats "as" as Artifact Share in Japanese sharing requests.',
  '- "Update the as link with this new version" — replaces the content behind the same URL.',
  '- "Check comments on my as file and reply" — reads comments and posts replies.',
  '- "Move this to the Q3 Report project on as" — organizes files into a project.',
  '- "Download this file" (with a URL) — saves the shared file locally.',
  '- "Log out of Artifact Share here" — removes a saved local CLI credential.',
  '"as" is a short alias for "Artifact Share" that users commonly type.',
  'Do not treat bare "artifact" as Artifact Share. Claude Artifact is for creating or designing an artifact inside chat; Artifact Share is for sharing, updating, opening, or reading back existing files and URLs.',
  '',
  '## CLI commands',
  '',
  'Use the CLI when a coding agent can access a user-controlled workspace, install the CLI package, and reach Artifact Share.',
  'Prefer the CLI when a coding agent can access a user-controlled workspace, install the CLI package, and reach Artifact Share; otherwise use the remote MCP server for source text in chat or a temporary sandbox.',
  'If shell access is unavailable, use the remote MCP server; a temporary file alone does not establish the CLI capabilities.',
  '',
  `- First-time setup (detect the agent, install the skill, then sign in): ${CLI_INIT_COMMAND}`,
  `- Read an Artifact Share URL: ${CLI_OPEN_COMMAND}`,
  `- Share a local file, folder, or static site: ${CLI_SHARE_COMMAND}`,
  `- Update the same share URL with a new version: ${CLI_UPDATE_COMMAND}`,
  `- Read a single-file artifact: ${CLI_ARTIFACTS_GET_COMMAND}`,
  `- Download a static site or multi-file artifact: ${CLI_DOWNLOAD_COMMAND}`,
  `- Remove the saved local credential: ${CLI_LOGOUT_COMMAND}`,
  '',
  'If the CLI JSON reports auth_required, show the user the verification URL and user_code from the response, then rerun the same command after they approve.',
  '',
  '## MCP (chat-only connectors)',
  '',
  'Use remote MCP for source text created in chat or a temporary sandbox when CLI network access is unavailable or uncertain.',
  'Claude, ChatGPT, and Cursor connect via MCP for small single-file shares.',
  'For link sharing, MCP uses link_expires_at: an RFC3339 UTC timestamp for a finite expiry, null for no expiration, or omission to use the workspace default when creating and preserve the current expiry when editing.',
  'The CLI uses --link-expires-at <RFC3339 UTC> or --no-link-expiry; do not pass both. Free cannot use link sharing, and Team workspace policy can disable it.',
  '',
  '## Notes',
  '',
  'If no target path is specified, ask the user before uploading secrets or large directories.',
  '',
  'Share with AI guide: https://artifactshare.com/share-with-ai',
  'Share with AI guide (Japanese): https://artifactshare.com/ja/share-with-ai',
  'CLI reference: https://artifactshare.com/guides/cli',
  'CLI reference (Japanese): https://artifactshare.com/ja/guides/cli',
  'Workspace owner guide: https://artifactshare.com/guides/workspace-owner',
  'Workspace owner guide (Japanese): https://artifactshare.com/ja/guides/workspace-owner',
  'Workspace admin guide: https://artifactshare.com/guides/workspace-admin',
  'Workspace admin guide (Japanese): https://artifactshare.com/ja/guides/workspace-admin',
  'Link sharing guide: https://artifactshare.com/guides/link-sharing',
  'Link sharing guide (Japanese): https://artifactshare.com/ja/guides/link-sharing',
  'Connect guide: https://artifactshare.com/connect',
  'Connect guide (Japanese): https://artifactshare.com/ja/connect',
  'Capabilities reference: https://artifactshare.com/capabilities.md',
  'Agent contract: https://artifactshare.com/.well-known/agent.json',
  'Terms of service: https://artifactshare.com/terms',
  'Privacy policy: https://artifactshare.com/privacy',
  'Product updates: https://artifactshare.com/updates',
  'Product updates (Japanese): https://artifactshare.com/ja/updates',
  '',
].join('\n')

export const capabilitiesMd = [
  '# Artifact Share — Capabilities',
  '',
  `Last updated: ${AGENT_SURFACE_LAST_UPDATED}`,
  '',
  '## Overview',
  '',
  'Artifact Share turns HTML, Markdown, folders, and static sites into stable share URLs.',
  'Every feature — sharing, updating, commenting, and project organization — is available from AI.',
  '',
  '## Routes',
  '',
  'There are two ways to use Artifact Share programmatically:',
  '',
  '- **CLI** — use when a coding agent can access a user-controlled workspace, install the CLI package, and reach Artifact Share.',
  '  This includes Codex, Claude Code, Cursor Agent, and CI pipelines when those conditions are available. The CLI handles local files, folders, multi-file sites, and multiple Google accounts flexibly.',
  '  Start with `open` for a received URL, `share` for a new file, or `update` for a replacement.',
  '  Full public command reference: https://artifactshare.com/guides/cli',
  '- **Remote MCP** — use for source text created in chat or a temporary sandbox when CLI network access is unavailable or uncertain.',
  '  MCP is best for small single-file HTML or Markdown shares. For folders or larger sites, use the CLI.',
  '',
  '## Operations',
  '',
  '| Operation | MCP | CLI | Notes |',
  '|---|---|---|---|',
  '| Share a file | share_artifact | share | MCP: single HTML/Markdown only. CLI: files, folders, static sites; both support link visibility and optional expiry. |',
  '| Update (replace content, same URL) | update_artifact | update | Both routes behave the same. |',
  '| Append content (same URL, new version) | append_artifact | append | Markdown: source end. HTML: before an ASCII case-insensitive </body>, or source end if absent. No separator. |',
  '| List artifacts | list_artifacts | artifacts list | |',
  '| Read artifact content | get_artifact | artifacts get, open | `open` also installs/updates the CLI skill. |',
  '| Download to local disk | — | download | MCP cannot download files. |',
  '| Post a comment | post_comment | comments post | Supports replies and text-anchored quotes. |',
  '| Edit a comment | update_comment | comments edit | |',
  '| Delete a comment | delete_comment | comments delete | |',
  '| List comments | list_comments | comments list | |',
  '| Resolve a comment thread | resolve_comment | comments resolve | |',
  '| Reopen a comment thread | reopen_comment | comments reopen | |',
  '| List projects | list_projects | projects list | |',
  '| Create a project | create_project | projects create | |',
  '| Edit a project | edit_project | projects edit | Name, description, visibility, members, archive. |',
  '| Edit artifact metadata | edit_artifact | edit | Title, visibility, link expiry, grants, project assignment. |',
  '| Delete an artifact | delete_artifact | delete | Permanently removes the artifact and all versions. |',
  '| Publish a folder or static site | — | share <directory> | MCP is single-file only. |',
  '',
  '## Link sharing and expiry',
  '',
  'Free does not allow link sharing. The web settings still show the setting and explain that it is available from Plus; this is informational, not a link-sharing action.',
  'Plus allows per-artifact link sharing and lets the owner set the default and maximum expiry. Plus has no workspace-wide link-sharing switch.',
  'Team adds workspace-wide link-sharing enable/disable controls for owners and admins. New Team workspaces have link sharing disabled.',
  'The default and maximum expiry are 1 to 365 days, initially 30 and 90. A no-expiration default requires a no-limit maximum. MCP and CLI return link_expires_at as a UTC timestamp or null.',
  'MCP share_artifact and edit_artifact accept a nullable link_expires_at. Omit it on create to use the workspace default; omit it on edit to preserve the current expiry. The CLI uses --link-expires-at <RFC3339 UTC> or --no-link-expiry, which are mutually exclusive.',
  '',
  '## MCP tools',
  '',
  'The remote MCP server exposes the following 18 tools:',
  '',
  '| Tool | Description |',
  '|---|---|',
  '| whoami | Check the signed-in user and workspace. |',
  '| share_artifact | Share a single HTML or Markdown file; visibility `link` supports finite RFC3339 UTC or unlimited expiry. |',
  '| update_artifact | Replace the content behind an existing share URL (new version). |',
  '| append_artifact | Append content exactly as provided. Markdown uses the source end; HTML uses the position before an ASCII case-insensitive </body>, falling back to the source end. Creates a new version at the same URL. |',
  '| list_artifacts | List artifacts the user has posted. |',
  "| get_artifact | Read an artifact's content and metadata (supports offset for large files). |",
  '| preview_artifact | Get a browser-preview URL for an artifact. |',
  '| list_comments | List comment threads on an artifact. |',
  '| post_comment | Post a comment or reply on an artifact. |',
  '| update_comment | Edit a comment the user posted. |',
  '| resolve_comment | Mark a comment thread as resolved. |',
  '| reopen_comment | Reopen a resolved comment thread. |',
  '| delete_comment | Delete a comment the user posted. |',
  '| list_projects | List projects in the workspace. |',
  '| create_project | Create a new project. |',
  "| edit_project | Edit a project's name, description, visibility, or members. |",
  "| edit_artifact | Edit an artifact's title, visibility, link expiry, grants, or project assignment. |",
  '| delete_artifact | Permanently delete an artifact and all its versions. |',
  '',
  '## CLI commands',
  '',
  `All commands use the invocation prefix: \`${CLI_INVOCATION}\``,
  '',
  '| Command | Description |',
  '|---|---|',
  `| init | First-time setup: detect the agent, install the skill, sign in. |`,
  `| open <target> | Read a shared URL and install/update the skill. The recommended first command. |`,
  `| share <path> | Share a local file, folder, or static site. Returns a stable URL. |`,
  `| update <target> <path> | Replace content behind an existing URL with a new version. |`,
  `| artifacts list | List artifacts the user has posted. |`,
  `| artifacts get <target> | Read a single-file artifact's content and metadata. |`,
  `| download <target> | Download an artifact (single file or static site) to local disk. |`,
  `| login | Sign in interactively (device authorization flow). |`,
  `| logout | Remove the saved credential for a CLI profile. |`,
  `| edit <target> | Edit title, visibility, grants, or project assignment. |`,
  `| delete <target> | Permanently delete an artifact. |`,
  `| resolve <value> | Look up an artifact by URL, ID, title, or project name. |`,
  `| whoami | Show the signed-in user and workspace. |`,
  `| comments list <target> | List comments on an artifact. |`,
  `| comments post <target> | Post a comment or reply. |`,
  `| comments edit <target> | Edit a comment. |`,
  `| comments resolve <target> | Mark a comment thread as resolved. |`,
  `| comments reopen <target> | Reopen a resolved comment thread. |`,
  `| comments delete <target> | Delete a comment. |`,
  `| projects list | List projects in the workspace. |`,
  `| projects create <name> | Create a new project. |`,
  `| projects edit <id> | Edit a project. |`,
  `| profiles list/use/import-token/delete | Manage local CLI profiles and saved credentials. |`,
  '',
  '`<target>` accepts an artifact ID, share URL, or sandbox URL.',
  'Append `--json` to any command for machine-readable JSON output.',
  'For link visibility, use `--link-expires-at <RFC3339 UTC>` for a finite expiry or `--no-link-expiry` for no expiration. Omit both to use the workspace default on share or preserve the current expiry on edit.',
  'If a link operation fails, inspect the structured error recovery: `link_sharing_plan_required` needs Plus or Team, `link_sharing_disabled` needs a Team admin to enable the workspace setting, and `link_expiry_invalid` needs a future timestamp within policy or an allowed no-expiration request.',
  'If the CLI reports `auth_required`, show the user the `verification_uri_complete` and `user_code`, then rerun the same command after they approve.',
  '',
  '## Restrictions',
  '',
  '| Restriction | Applies to | Details |',
  '|---|---|---|',
  '| No server-side runtime | All | Shared content is static HTML/Markdown rendered in a sandboxed iframe. |',
  '| No outbound network from content | All | Uploaded content cannot make network requests (CSP enforced). |',
  '| No embedded secrets | All | Do not include API keys, tokens, or credentials in shared files. |',
  `| Remote scripts allowlist | All | Only these CDNs are allowed: ${NO_REMOTE_SCRIPTS_ALLOWLIST.join(', ')}. |`,
  '| Single file only | MCP | MCP can share one HTML or Markdown file per call. Use the CLI for folders. |',
  '| HTML or Markdown only | MCP | MCP accepts text/html and text/markdown content types. |',
  `| Size limit | All | Single file: ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB. Static site total: ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB (max ${MAX_STATIC_SITE_FILES} files, ${MAX_STATIC_SITE_FILE_BYTES / 1024 / 1024} MB per file). |`,
  '',
  '## Not yet available',
  '',
  'The following operations are not currently supported:',
  '',
  '- **Version deletion** — individual versions cannot be deleted. To stop sharing, change the visibility to private or delete the entire artifact.',
  '- **Full-text search** — there is no text search across artifact content. Use `artifacts list` or `projects list` to find items by title or project.',
  '- **Project deletion** — projects can be archived but not deleted.',
  '',
  '## Links',
  '',
  `- Share with AI guide: ${apexUrl('/share-with-ai')}`,
  `- Share with AI guide (Japanese): ${apexUrl('/ja/share-with-ai')}`,
  `- CLI reference: ${apexUrl('/guides/cli')}`,
  `- CLI reference (Japanese): ${apexUrl('/ja/guides/cli')}`,
  `- Workspace owner guide: ${apexUrl('/guides/workspace-owner')}`,
  `- Workspace owner guide (Japanese): ${apexUrl('/ja/guides/workspace-owner')}`,
  `- Workspace admin guide: ${apexUrl('/guides/workspace-admin')}`,
  `- Workspace admin guide (Japanese): ${apexUrl('/ja/guides/workspace-admin')}`,
  `- Link sharing guide: ${apexUrl('/guides/link-sharing')}`,
  `- Link sharing guide (Japanese): ${apexUrl('/ja/guides/link-sharing')}`,
  `- Connect guide: ${apexUrl('/connect')}`,
  `- Connect guide (Japanese): ${apexUrl('/ja/connect')}`,
  `- Agent contract: ${apexUrl('/.well-known/agent.json')}`,
  `- Terms of service: ${apexUrl('/terms')}`,
  `- Privacy policy: ${apexUrl('/privacy')}`,
  `- Product updates: ${apexUrl('/updates')}`,
  `- Product updates (Japanese): ${apexUrl('/ja/updates')}`,
  '',
].join('\n')

export const pricingMarkdown = buildPricingMarkdown()

/** Anonymous, cacheable, cross-origin-readable responses (agent.json, openapi,
 * OAuth discovery). Reused so the header set stays identical across them. */
export const PUBLIC_CACHEABLE_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
}

export const AGENT_SURFACE_HEADERS_JSON = {
  ...PUBLIC_CACHEABLE_CORS_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
}

export const AGENT_SURFACE_HEADERS_MD = {
  ...PUBLIC_CACHEABLE_CORS_HEADERS,
  'Content-Type': 'text/markdown; charset=utf-8',
}

export const AGENT_SURFACE_HEADERS_TXT = {
  ...PUBLIC_CACHEABLE_CORS_HEADERS,
  'Content-Type': 'text/plain; charset=utf-8',
}
