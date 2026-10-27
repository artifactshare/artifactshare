/**
 * Public documentation metadata that is shared by the contract-surface
 * generator.  Wire schemas and endpoint metadata live in index.ts; this file
 * owns only the presentation choices that cannot be inferred from a runtime
 * schema (the short command examples and the existing discovery prose).
 */

export const CLI_AGENT_COMMANDS = {
  init: 'init --json',
  open: 'open <artifact-id-or-url> --json',
  share: 'share <path> --json',
  update: 'update <artifact-id-or-url> <path> --json',
  read: 'artifacts get <artifact-id-or-url> --json',
  download: 'download <artifact-id-or-url> --output ./artifact --json',
  login: 'login --json',
  logout: 'logout --json',
  doctor: 'doctor --json',
  edit: 'edit <artifact-id-or-url> --json',
  delete: 'delete <artifact-id-or-url> --json',
  resolve: 'resolve <value> --json',
  whoami: 'whoami --json',
  'artifacts list': 'artifacts list --json',
  'comments list': 'comments list <artifact-id-or-url> --json',
  'comments post': "comments post <artifact-id-or-url> --body '<text>' --json",
  'comments edit':
    "comments edit <artifact-id-or-url> --message-id <id> --body '<text>' --json",
  'comments resolve':
    'comments resolve <artifact-id-or-url> --thread-id <id> --json',
  'comments reopen':
    'comments reopen <artifact-id-or-url> --thread-id <id> --json',
  'comments delete':
    'comments delete <artifact-id-or-url> --thread-id <id> --json',
  'projects list': 'projects list --json',
  'projects create': "projects create '<name>' --json",
  'projects edit': 'projects edit <project-id> --json',
  'profiles list': 'profiles list --json',
  'profiles use': 'profiles use <name> --json',
  'profiles import-token': 'profiles import-token --profile <name> --json',
  'profiles delete': 'profiles delete <name> --json',
  'skills ensure': 'skills ensure --tool auto --json',
  'skills install': 'skills install --tool <name> --json',
  'skills list': 'skills list --json',
  'skills update': 'skills update --json',
  'skills remove': 'skills remove --tool <name> --json',
}

export const CLI_QUICK_REFERENCE = [
  ['Share a file or folder', 'share <path> --json'],
  [
    'Share a link with expiry',
    "share <path> --visibility link --link-expires-at '<RFC3339 UTC>' --json",
  ],
  ['Replace with same URL', 'update <target> <path> --json'],
  ['Append to same URL', 'append <target> <path> --json'],
  ['Read back source', 'artifacts get <target> --json'],
  ['Download a site bundle', 'download <target> --output ./out --json'],
  [
    'Download a whole project',
    'download --project-id <id> --output ./out --json',
  ],
  ['List your artifacts', 'artifacts list --json'],
  ['Post a comment', "comments post <target> --body '<text>' --json"],
  ['Read comments', 'comments list <target> --json'],
  [
    'Read older replies',
    'comments list <target> --thread-id <id> --before <older_cursor> --limit 50 --json',
  ],
  ['Change title or sharing', "edit <target> --title 'New' --json"],
  ['Move to a project', 'edit <target> --project-id <id> --json'],
  ['Create a project', "projects create 'Name' --json"],
  ['Find an ID from a title', 'resolve <value> --json'],
  ['Open a share URL', 'open <url> --json'],
  ['Preview a local file', 'preview <file> --json (local, no sign-in)'],
  ['Log out', 'logout --profile <name> --json'],
]

export const CLI_README_COMMANDS = [
  [
    'open <target>',
    'First command for agents opening a share or artifactshareusercontent.com execution URL; ensures skills, then reads or suggests download',
  ],
  [
    'share <path>',
    'Share a file or folder as a new shared file (`--project`, `--home`, `--visibility`, `--key`, link expiry options)',
  ],
  [
    'update <target> <path>',
    'Add a new version to an existing file (ID or share URL); optional `--label` adds a version note',
  ],
  [
    'append <target> <path>',
    'Append a non-empty UTF-8 file without a separator: at Markdown source end or before `</body>` in HTML, falling back to source end',
  ],
  [
    'edit <target>',
    'Change title, sharing, link expiry, explicit viewers, or project placement',
  ],
  ['delete <target>', 'Permanently delete a file you shared'],
  [
    'artifacts delete <target>',
    'Alias of delete; permanently delete a file you shared',
  ],
  ['resolve <value>', 'Find files by URL, ID, title, or project name'],
  ['artifacts get <target>', "Read a file's content and metadata back"],
  ['download <target>', 'Save a file or a whole static site locally'],
  [
    'comments list / post / edit / resolve / reopen / delete <target>',
    'Read, write, edit, resolve, reopen, and permanently delete comments',
  ],
  [
    'projects list / create / edit',
    'List eligible project destinations; create and edit projects and audience',
  ],
  [
    'move <target>',
    'Move an existing file into a project or back home; `edit` is preferred for new automation',
  ],
  [
    '`preview <file>` (alias of `preview start`)',
    'Serve a local Markdown or HTML file with the product viewer look for browser annotation; local only, no sign-in, nothing uploaded',
  ],
  [
    '`preview next` / `preview done` / `preview reply` / `preview stop`',
    'Agent loop for a live preview: poll submitted annotation batches, report fixed/skipped outcomes from stdin, reply into a thread, and stop the session',
  ],
  [
    '`login` / `logout` / `whoami`',
    'Sign in, revoke a device-login credential before removing it locally, and check who you are',
  ],
  [
    'doctor',
    'Diagnose token storage, auth, destination, network, and upload readiness — tells you the next command to run',
  ],
  [
    'changelog',
    "Show the installed version, this release's notes, and the public updates page",
  ],
  [
    'profiles list / use / import-token / delete',
    'Switch between local account profiles, import an issued token from stdin, and delete profile entries',
  ],
  [
    'init',
    'Set up this directory: detect Claude Code, Codex, or Cursor and install the full skill folder in user scope (migrating managed legacy Cursor project rules), then show next steps; or save defaults with `--profile` / `--project-id`',
  ],
  [
    'skills ensure / install / list / update / remove',
    "Install or update the bundled usage guide in your AI agent's skills; Claude user scope follows CLAUDE_CONFIG_DIR (blank values are unavailable)",
  ],
]

export const MCP_OPENAPI_METADATA = {
  openapi: '3.1.0',
  title: 'Artifact Share API',
  version: '0.1.0',
  resourcePath: '/mcp',
  authBasePath: '/api/auth',
  oauthAuthorizePath: '/api/auth/oauth2/authorize',
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'artifactshare:access',
  ],
  // The MCP handler requires the product scope in the bearer token.
  operationScopes: ['artifactshare:access'],
  description:
    'Artifact Share is reached programmatically through its remote MCP endpoint at /mcp (JSON-RPC over Streamable HTTP) and authenticated CLI REST endpoints. An MCP client (Claude, ChatGPT, Cursor) authorizes with OAuth 2.1 and then calls tools to share, update, read, comment on, and organize artifacts. See /capabilities.md for the full tool list and /.well-known/agent.json for discovery.',
  endpointDescription:
    'Publisher device credentials are limited to their scoped artifact REST endpoints and cannot access MCP. Remote MCP server. Accepts JSON-RPC 2.0 (initialize, tools/list, tools/call) with an OAuth 2.1 bearer token. See /capabilities.md for the full tool list.',
  oauthDescription:
    'OAuth 2.1 authorization-code flow with PKCE, served under /api/auth. MCP clients obtain the bearer token for /mcp this way; the same endpoints are advertised at /.well-known/oauth-authorization-server.',
  scopeDescriptions: {
    openid: 'Authenticate the user',
    profile: 'Read basic profile (name, locale)',
    email: 'Read the verified email address',
    offline_access: 'Issue a refresh token for offline use',
    'artifactshare:access':
      'View, share, update, and permanently delete Artifact Share files; manage projects and comments',
  },
}

// Option explanations displayed alongside the generated command reference.
export const CLI_REFERENCE_OPTION_HELP = {
  share: ['--expected-version'],
  update: ['--expected-version'],
  download: ['--force'],
  'skills install': ['--force'],
  'skills update': ['--force'],
  edit: ['--visibility', '--retain-versions'],
}

/** @param {string} name */
const restRef = (name) => ({ $ref: `#/components/schemas/${name}` })
const restString = { type: 'string', minLength: 1 }
const nullableString = { type: ['string', 'null'] }
const retention = { type: ['integer', 'null'], minimum: 1 }
const visibility = {
  type: 'string',
  enum: ['private', 'workspace', 'project', 'link'],
}
/** @param {Record<string, object>} properties
 * @param {string[]} [required]
 * @param {boolean} [strict]
 */
const objectSchema = (
  properties,
  required = Object.keys(properties),
  strict = false,
) => ({
  type: 'object',
  properties,
  required,
  ...(strict ? { additionalProperties: false } : {}),
})
export const REST_SCHEMAS = {
  CommentThreadWindow: objectSchema({
    id: restString,
    status: { enum: ['open', 'resolved'] },
    created_at: restString,
    updated_at: restString,
    resolved_at: nullableString,
    message_count: { type: 'integer', minimum: 0 },
    reply_count: { type: 'integer', minimum: 0 },
    older_cursor: nullableString,
    anchor: { type: 'object' },
    messages: {
      type: 'array',
      maxItems: 51,
      description:
        'Current first message plus latest three replies, or at most 50 requested replies.',
      items: objectSchema({
        message_id: restString,
        body: { type: 'string' },
        author_name: nullableString,
        author_email: restString,
        agent: nullableString,
        created_at: restString,
        updated_at: restString,
      }),
    },
  }),
  CommentsListResponse: objectSchema(
    {
      artifact_id: restString,
      share_url: nullableString,
      comments: {
        type: 'array',
        maxItems: 50,
        items: restRef('CommentThreadWindow'),
      },
      has_more: { type: 'boolean' },
    },
    ['artifact_id', 'comments'],
  ),
  PublisherAdoptRequest: objectSchema(
    { publisher_client_id: restString },
    undefined,
    true,
  ),
  PublisherAdoptResponse: objectSchema(
    { id: restString, publisher_client_id: restString },
    undefined,
    true,
  ),
  PublisherRetentionRequest: objectSchema(
    { retain_versions: retention },
    undefined,
    true,
  ),
  ArtifactDeleteResponse: objectSchema({
    id: restString,
    deleted: { const: true },
  }),
  ArtifactReadResponse: objectSchema(
    {
      id: restString,
      share_url: { type: 'string', format: 'uri' },
      version_id: restString,
      format: { enum: ['html', 'markdown'] },
      content: { type: 'string' },
      size_bytes: { type: 'number', minimum: 0 },
      truncated: { type: 'boolean' },
      next_offset: { type: ['integer', 'null'], minimum: 0 },
      link_expires_at: nullableString,
      project_id: nullableString,
      versions: { type: 'array', items: { type: 'object' } },
      comments: { type: 'array', items: { type: 'object' } },
      versions_has_more: { type: 'boolean' },
      comments_has_more: { type: 'boolean' },
    },
    [
      'id',
      'share_url',
      'version_id',
      'format',
      'content',
      'size_bytes',
      'truncated',
      'next_offset',
    ],
  ),
  PublisherSingleFileReadResponse: {
    allOf: [restRef('ArtifactReadResponse'), objectSchema({ visibility })],
  },
  PublisherStaticSiteReadResponse: objectSchema({
    id: restString,
    share_url: { type: 'string', format: 'uri' },
    version_id: restString,
    artifact_kind: { const: 'static_site' },
    visibility,
    project_id: nullableString,
    link_expires_at: nullableString,
    retain_versions: retention,
  }),
  PublisherArtifactReadResponse: {
    oneOf: [
      restRef('PublisherSingleFileReadResponse'),
      restRef('PublisherStaticSiteReadResponse'),
    ],
  },
  CliEditRequest: objectSchema(
    {
      retain_versions: retention,
      title: { type: 'string' },
      visibility,
      link_expires_at: nullableString,
      add_emails: { type: 'array', items: { type: 'string' } },
      remove_emails: { type: 'array', items: { type: 'string' } },
      destination: {
        oneOf: [{ const: 'home' }, objectSchema({ project_id: restString })],
      },
    },
    [],
  ),
  CliEditResponse: objectSchema(
    {
      artifact: objectSchema({ id: restString, url: nullableString }, ['id']),
      title: { type: 'string' },
      destination: objectSchema({
        type: { enum: ['home', 'project'] },
        project_id: nullableString,
      }),
      share: objectSchema({ visibility, link_expires_at: nullableString }, [
        'visibility',
      ]),
      retain_versions: retention,
      deleted_versions: { type: 'integer', minimum: 0 },
    },
    ['artifact', 'title', 'destination', 'share'],
  ),
}
const restSecurity = [{ cliBearer: [] }, { browserSession: [] }]
const pathId = { name: 'id', in: 'path', required: true, schema: restString }
/** @param {string} summary
 * @param {string} description
 * @param {object} response
 * @param {object | null} request
 * @param {string[]} presets
 * @param {object} [errors]
 */
const restOperation = (
  summary,
  description,
  response,
  request,
  presets,
  errors = {},
) => ({
  summary,
  description,
  security: restSecurity,
  parameters: [pathId],
  'x-credential-presets': presets,
  ...(request
    ? {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: request } },
        },
      }
    : {}),
  responses: {
    200: {
      description: 'Success.',
      content: { 'application/json': { schema: response } },
    },
    400: { description: 'Invalid payload or query.' },
    401: { description: 'Authentication required.' },
    403: { description: 'Credential scope denied.' },
    404: {
      description:
        'Missing or ineligible artifact/client (scope is not disclosed).',
    },
    405: { description: 'Method unavailable to this credential preset.' },
    409: { description: 'Concurrent change or source unavailable.' },
    ...errors,
  },
})
export const REST_OPERATIONS = {
  '/api/cli/artifacts/{id}/comments': {
    get: {
      ...restOperation(
        'Read bounded comment windows',
        'Default: at most 50 threads, open first. Each contains its first message plus latest three replies. Use thread_id and before=older_cursor for older replies (limit 1–50), or mutually exclusive around_message_id for a target-containing page. Counts describe stored messages. has_more concerns threads only.',
        restRef('CommentsListResponse'),
        null,
        ['unrestricted', 'agent', 'browser-session'],
      ),
      parameters: [
        pathId,
        ...['thread_id', 'before', 'around_message_id'].map((name) => ({
          name,
          in: 'query',
          schema: restString,
        })),
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        },
      ],
    },
    post: restOperation(
      'Post or change a comment',
      'Creation and replies share 20 admissions per verified user/artifact per fixed UTC minute across transports and tokens. Up to 40 admissions may straddle a minute boundary. Validation and observed capacity refusals are uncharged; failures after admission consume budget. Threads allow 500 stored messages. Success readback is bounded; refresh_required indicates committed success requiring a targeted read, never an automatic replay.',
      { type: 'object' },
      { type: 'object' },
      ['unrestricted', 'agent', 'browser-session'],
      {
        409: {
          description:
            'thread-capacity: start a new thread; or resolved/version conflict.',
        },
        429: {
          description:
            'rate-limited. error.details includes retry_after_seconds and retry_at.',
          headers: {
            'Retry-After': { schema: { type: 'integer', minimum: 1 } },
          },
        },
        502: {
          description:
            'commit-failed. Do not automatically replay an uncertain write.',
        },
      },
    ),
  },
  '/api/cli/artifacts/{id}/adopt': {
    post: restOperation(
      'Assign an artifact to a publisher client',
      'Current human owner only, using unrestricted CLI Bearer or browser session. Target client must belong to the owner in the same workspace. Strict JSON. Replaces effective assignment; repeat assignment is audited. Publisher, agent, bootstrap and bridge cannot adopt.',
      restRef('PublisherAdoptResponse'),
      restRef('PublisherAdoptRequest'),
      ['unrestricted', 'browser-session'],
      { 415: { description: 'JSON content type required.' } },
    ),
  },
  '/api/cli/artifacts/{id}': {
    get: {
      ...restOperation(
        'Read an artifact',
        'Publisher: only created or assigned artifacts still owned by the approver. Includes visibility; static sites return metadata only. All include requests and static-site offset are denied. Other presets retain single-file readback.',
        {
          anyOf: [
            restRef('ArtifactReadResponse'),
            restRef('PublisherArtifactReadResponse'),
          ],
        },
        null,
        ['unrestricted', 'agent', 'publisher', 'browser-session'],
      ),
      parameters: [
        pathId,
        {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer', minimum: 0 },
        },
        {
          name: 'include',
          in: 'query',
          schema: { type: 'array', items: { enum: ['versions', 'comments'] } },
        },
      ],
    },
    delete: restOperation(
      'Delete an artifact',
      'Publisher may delete only its created or assigned artifacts still owned by the approver. Uses guarded storage and database cleanup.',
      restRef('ArtifactDeleteResponse'),
      null,
      ['unrestricted', 'publisher', 'browser-session'],
    ),
  },
  '/api/cli/shareables/{id}/edit': {
    post: restOperation(
      'Edit artifact settings',
      'Publisher accepts strictly retain_versions only (positive integer or null), for its own artifacts. On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions. Prunes immediately; clearing cannot restore content. Other credentials keep existing edit permissions.',
      restRef('CliEditResponse'),
      {
        anyOf: [
          restRef('CliEditRequest'),
          restRef('PublisherRetentionRequest'),
        ],
      },
      ['unrestricted', 'agent', 'publisher', 'browser-session'],
    ),
    patch: restOperation(
      'Edit publisher retention',
      'Publisher only. Strict retain_versions payload on its created or assigned artifacts. On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions. Other presets and browser sessions receive 405.',
      restRef('CliEditResponse'),
      restRef('PublisherRetentionRequest'),
      ['publisher'],
    ),
  },
}
