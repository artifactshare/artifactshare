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
    'First command for agents opening a shared URL; ensures skills, then reads or suggests download',
  ],
  [
    'share <path>',
    'Share a file or folder as a new shared file (`--project`, `--home`, `--visibility`, `--key`, link expiry options)',
  ],
  [
    'update <target> <path>',
    'Add a new version to an existing file (ID or share URL)',
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
  ['resolve <value>', 'Find files by URL, ID, title, or project name'],
  ['artifacts get <target>', "Read a file's content and metadata back"],
  ['download <target>', 'Save a file or a whole static site locally'],
  [
    'comments list / post / edit / resolve / reopen / delete <target>',
    'Read, write, edit, resolve, reopen, and permanently delete comments',
  ],
  [
    'projects list / create / edit',
    'List, create, and edit project destinations and audience',
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
    'Set up this directory: detect Claude Code, Codex, or Cursor and install the skill in user scope, then show next steps; or save defaults with `--profile` / `--project-id`',
  ],
  [
    'skills ensure / install / list / update / remove',
    "Install or update the bundled usage guide in your AI agent's skills",
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
  // Keep the legacy operation requirement; the product scope is optional.
  operationScopes: ['openid', 'profile', 'email', 'offline_access'],
  description:
    'Artifact Share is reached programmatically through its remote MCP endpoint at /mcp (JSON-RPC over Streamable HTTP), not a REST API. An MCP client (Claude, ChatGPT, Cursor) authorizes with OAuth 2.1 and then calls tools to share, update, read, comment on, and organize artifacts. See /capabilities.md for the full tool list and /.well-known/agent.json for discovery.',
  endpointDescription:
    'Remote MCP server. Accepts JSON-RPC 2.0 (initialize, tools/list, tools/call) with an OAuth 2.1 bearer token. See /capabilities.md for the full tool list.',
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
