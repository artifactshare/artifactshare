#!/usr/bin/env node

import {
  cli,
  define,
  lazy,
  type CommandContext,
  type CommandRunner,
} from 'gunshi'
import { generate } from 'gunshi/generator'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  commandNameFromArgv,
  firstCommandCandidate,
  joinLeadingDashValues,
  normalizeArgvForGunshi,
  validateRawArgs,
  insertDefaultSubcommand,
} from './args.js'
import {
  doctorRunner,
  changelogRunner,
  configGetRunner,
  configSetRunner,
  configUnsetRunner,
  artifactsGetRunner,
  artifactsListRunner,
  commentsDeleteRunner,
  commentsEditRunner,
  commentsListRunner,
  commentsPostRunner,
  commentsReopenRunner,
  commentsResolveRunner,
  deleteRunner,
  downloadRunner,
  editRunner,
  initRunner,
  loginRunner,
  logoutRunner,
  moveRunner,
  profilesListRunner,
  profilesDeleteRunner,
  profilesImportTokenRunner,
  profilesUseRunner,
  parentCommandRunner,
  projectsCreateRunner,
  projectsEditRunner,
  projectsListRunner,
  openRunner,
  shareRunner,
  resolveRunner,
  skillsInstallRunner,
  skillsEnsureRunner,
  skillsListRunner,
  skillsRemoveRunner,
  skillsUpdateRunner,
  updateRunner,
  appendRunner,
  whoamiRunner,
  previewRunner,
  previewNextRunner,
  previewDoneRunner,
  previewReplyRunner,
  previewStopRunner,
} from './commands.js'
import {
  unexpectedError,
  unknownCommandError,
  validationError,
} from './errors.js'
import { outputModeFromArgv, writeFailure, writeText } from './output.js'
import { loadCliVersion } from './version.js'
import {
  agentDownloadCommand,
  CLI_INVOCATION,
  DEFAULT_BASE_URL,
  TOKEN_ENV_VAR,
  TOKEN_OPTION,
} from './constants.js'

async function main(rawArgv: string[]): Promise<void> {
  const argv = insertDefaultSubcommand(joinLeadingDashValues(rawArgv))
  const command = commandNameFromArgv(argv)
  const commandCandidate = firstCommandCandidate(argv)
  const rawError = validateRawArgs(argv, command)
  if (rawError) {
    return writeFailure(
      command ?? 'unknown',
      rawError,
      outputModeFromArgv(argv),
      1,
    )
  }
  if (command === undefined && commandCandidate !== undefined) {
    return writeFailure(
      'unknown',
      unknownCommandError(commandCandidate),
      outputModeFromArgv(argv),
      1,
    )
  }
  const gunshiArgv =
    command === undefined
      ? ['--help']
      : normalizeArgvForGunshi(argv, commandCandidate)
  const usage = await runGunshi(gunshiArgv).catch((error) => {
    if (error instanceof AggregateError) {
      writeFailure(
        command ?? 'unknown',
        validationError(
          'Arguments are invalid.',
          error.errors
            .map((item) =>
              item instanceof Error ? item.message : String(item),
            )
            .join(' '),
        ),
        outputModeFromArgv(argv),
        1,
      )
      return undefined
    }
    throw error
  })
  if (usage) writeText(usage)
}

async function runGunshi(argv: string[]): Promise<string | undefined> {
  return cli(argv, entryCommand, await cliOptions())
}

async function cliOptions(version = loadCliVersion()) {
  return {
    name: 'artifactshare',
    description: 'Artifact Share CLI',
    version: await version,
    subCommands: {
      login: lazyCommand(loginDefinition, loginRunner),
      logout: lazyCommand(logoutDefinition, logoutRunner),
      share: lazyCommand(shareDefinition, shareRunner),
      open: lazyCommand(openDefinition, openRunner),
      update: lazyCommand(updateDefinition, updateRunner),
      append: lazyCommand(appendDefinition, appendRunner),
      edit: lazyCommand(editDefinition, editRunner),
      delete: lazyCommand(deleteDefinition, deleteRunner),
      resolve: lazyCommand(resolveDefinition, resolveRunner),
      download: lazyCommand(downloadDefinition, downloadRunner),
      move: lazyCommand(moveDefinition, moveRunner),
      artifacts: artifactsDefinition,
      comments: commentsDefinition,
      whoami: lazyCommand(whoamiDefinition, whoamiRunner),
      doctor: lazyCommand(doctorDefinition, doctorRunner),
      changelog: lazyCommand(changelogDefinition, changelogRunner),
      preview: previewDefinition,
      profiles: profilesDefinition,
      projects: projectsDefinition,
      config: configDefinition,
      skills: skillsDefinition,
      init: lazyCommand(initDefinition, initRunner),
    },
    usageSilent: true,
  } as const
}

export async function generateCliHelp(path: string[]): Promise<string> {
  return generate(path.length ? path : null, entryCommand, await cliOptions())
}

function lazyCommand(
  definition: ReturnType<typeof define>,
  runner: (ctx: Readonly<CommandContext>) => Promise<void>,
) {
  return lazy(
    (): Promise<CommandRunner> =>
      Promise.resolve(async (ctx: Readonly<CommandContext>) => {
        await runner(ctx)
      }),
    definition,
  )
}

const commonArgs = {
  json: {
    type: 'boolean',
    toKebab: true,
    description: 'Print stable JSON output',
  },
  baseUrl: {
    type: 'string',
    toKebab: true,
    description:
      'Artifact Share base URL (default: ARTIFACTSHARE_BASE_URL or https://artifactshare.com)',
  },
  token: {
    type: 'string',
    toKebab: true,
    description: `Bearer token (default: ${TOKEN_ENV_VAR})`,
  },
  profile: {
    type: 'string',
    toKebab: true,
    description: 'Profile name for saved CLI credentials',
  },
  allowPlaintextTokenStore: {
    type: 'boolean',
    toKebab: true,
    description:
      'Allow a plaintext token file (0600 on POSIX; unavailable on Windows)',
  },
  insecureLocalhost: {
    type: 'boolean',
    toKebab: true,
    description: 'Allow self-signed HTTPS only for localhost dev servers',
  },
} as const

const entryCommand = define({
  name: 'artifactshare',
  description: 'Artifact Share CLI',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare init --json
npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share <path> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> <path> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --title "New title" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare delete <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare resolve <url-id-or-title> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects create "Launch review" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --add-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare move <artifact-id-or-url> --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments list <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body "<text>" --json
${agentDownloadCommand('<artifact-id-or-url>')}
npm exec --yes --package=@artifactshare/cli -- artifactshare login --profile default
npm exec --yes --package=@artifactshare/cli -- artifactshare logout --profile default --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles use <name> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool codex --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare init --profile <name> --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share <path> --home --json
npm exec --yes --package=@artifactshare/cli -- artifactshare whoami --json
npm exec --yes --package=@artifactshare/cli -- artifactshare doctor --json

Authentication:
  Interactive terminal: run ${CLI_INVOCATION} login --profile default, then approve in your browser.
  Attended local agent: run ${CLI_INVOCATION} login --profile <name> --preset agent; add --project <name-or-id> to confirm a fixed project.
  CI injects a token; shared agent platforms use a workspace-managed bot outside the model sandbox.

Common failures:
  auth_required          Use ${TOKEN_ENV_VAR} or ${TOKEN_OPTION}; tokens are issued at ${DEFAULT_BASE_URL}/settings/tokens
  invalid_destination    Choose --project-id <id> or --home
  target_not_found       Use an artifact ID, share URL, or sandbox URL
  upload_not_allowed     Sharing is temporarily unavailable; contact Artifact Share support`,
  run: () => {},
})

const loginDefinition = define({
  name: 'login',
  description:
    'Sign in with browser device authorization and save a CLI profile.',
  toKebab: true,
  args: {
    ...commonArgs,
    preset: {
      type: 'string',
      description: 'Authorization preset: unrestricted or agent',
    },
    project: {
      type: 'string',
      description:
        'Exact project name or id to confirm with --preset agent (login only)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare login --profile default
npm exec --yes --package=@artifactshare/cli -- artifactshare login --profile client-a --preset agent --project 'Weekly Reports' --json

login requires browser approval in an interactive terminal.
For an attended agent on your machine, use --preset agent; --project makes the browser confirm one fixed project, while omitting it keeps the project picker.
For CI, inject a token issued at ${DEFAULT_BASE_URL}/settings/tokens. For a shared agent platform, use a workspace-managed bot credential in a trusted host outside the model sandbox. Do not pass tokens to login.

Common failures:
  auth_denied                The browser approval was denied
  auth_expired               The device code expired before approval
  token_store_unavailable    Configure an OS credential store or use the explicit plaintext fallback`,
})

const logoutDefinition = define({
  name: 'logout',
  description: 'Revoke and remove the saved credential for a CLI profile.',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare logout --profile client-a --json
npm exec --yes --package=@artifactshare/cli -- artifactshare logout --json

logout revokes a device-login refresh credential before removing it locally. API-token profiles are removed locally only. Profile metadata stays in config.json for re-login hints.
When no --profile is passed, the global default profile is used.

Common failures:
  validation_failed          Pass --profile or set a default profile; bearer-token-only auth has nothing to remove
  profile_not_found          Run profiles list to see saved profiles
  token_store_unavailable    Configure an OS credential store or use the explicit plaintext fallback`,
})

const shareDefinition = define({
  name: 'share',
  description: 'Share a file or directory.',
  toKebab: true,
  args: {
    ...commonArgs,
    path: {
      type: 'positional',
      description: 'File or directory to share',
    },
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Share into a project',
    },
    project: {
      type: 'string',
      toKebab: true,
      description: 'Share into a project by exact name',
    },
    home: {
      type: 'boolean',
      toKebab: true,
      description: 'Share to home instead of a project',
    },
    visibility: {
      type: 'string',
      toKebab: true,
      description:
        'private, workspace, project, or link (default: project for a project destination, otherwise resolved from config)',
    },
    linkExpiresAt: {
      type: 'string',
      toKebab: true,
      description: 'Set a finite link expiry as an RFC3339 UTC timestamp',
    },
    noLinkExpiry: {
      type: 'boolean',
      toKebab: true,
      description: 'Set link sharing to unlimited expiry',
    },
    noSlackNotify: {
      type: 'boolean',
      toKebab: true,
      description: 'Do not notify the project Slack channel for this post',
    },
    grantEmail: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Add an explicit viewer; repeat for multiple viewers',
    },
    key: {
      type: 'string',
      toKebab: true,
      description:
        'Stable key for create-or-update: the first share creates the artifact, repeats add versions. Not a secret; it appears in logs and JSON',
    },
    expectedVersion: {
      type: 'string',
      toKebab: true,
      description:
        'Require this current version when --key updates an existing artifact',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare share report.html --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share report.html --project-id <id> --key nightly-report --json

Posting to a project delivers to the audience defined by that project.
With no destination, share posts to home. Choose the setting by purpose:
  Personal safe default (this CLI environment only):
    npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json
  Shared policy agreed by all repository participants:
    npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience workspace --scope repository --json
  One-time audience for a single post: pass --visibility private|workspace|link.
  Link sharing accepts --link-expires-at <RFC3339 UTC> or --no-link-expiry;
  these expiry options are mutually exclusive.
  Pass --no-slack-notify to suppress the project Slack notification for this post.
  Check the resolved audience before posting:
    npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json

To keep an existing share URL, use update:
  npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> <path> --json

For repeat jobs, use --key: first share creates the artifact, later runs add versions.

Common failures:
  auth_required          Set ARTIFACTSHARE_TOKEN before share
  upload_not_allowed     Publishing is temporarily unavailable; contact Artifact Share support
  file_too_large         Reduce file or directory size and retry
  validation_failed      Check file type (.html / .md for single files) and directory layout
  key_target_moved       The artifact for --key moved; update it by ID or use a new key
  key_kind_mismatch      The artifact for --key is a different kind; use a new key`,
})

const updateDefinition = define({
  name: 'update',
  description: 'Add a new version to an existing artifact.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
    path: {
      type: 'positional',
      description: 'File or directory to add as the new version',
    },
    expectedVersion: {
      type: 'string',
      toKebab: true,
      description: 'Only update when this is still the current version id',
    },
  },
  examples: `Target:
  Accepts an artifact ID, /a/<id> share URL, or <id>.sandbox.* URL.
  Titles and project names are not updated directly; resolve them to an ID first.

Common failures:
  auth_required          Set ARTIFACTSHARE_TOKEN before update
  target_not_found       Retry with an artifact ID, share URL, or sandbox URL
  artifact_kind_mismatch Use a file for single-file artifacts or a directory for static sites
  upload_not_allowed     Publishing is temporarily unavailable; contact Artifact Share support
  file_too_large         Reduce file or directory size and retry
  validation_failed      Check file type (.html / .md for single files) and directory layout`,
})

const appendDefinition = define({
  name: 'append',
  description:
    'Append a local UTF-8 file without a separator: at the end of Markdown source, or before an ASCII case-insensitive </body> in HTML and at the end if none exists. Creates a new version at the same URL.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID or share URL',
    },
    path: { type: 'positional', description: 'Non-empty UTF-8 file to append' },
  },
  examples: `Append <path> without a separator and create a new version at the existing share URL.\n\nFor Markdown, the file is added at the end of the current source. For HTML, it is inserted immediately before an ASCII case-insensitive </body> closing tag; when the tag is absent, it is added at the end.\n\nStatic sites are not supported. Use update to replace the full source instead.`,
})

const editDefinition = define({
  name: 'edit',
  description: 'Edit artifact title, sharing, or project placement.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
    title: {
      type: 'string',
      toKebab: true,
      description: 'Set display title; pass an empty value to clear it',
    },
    visibility: {
      type: 'string',
      toKebab: true,
      description: 'private, workspace, or link',
    },
    linkExpiresAt: {
      type: 'string',
      toKebab: true,
      description: 'Set a finite link expiry as an RFC3339 UTC timestamp',
    },
    noLinkExpiry: {
      type: 'boolean',
      toKebab: true,
      description: 'Set link sharing to unlimited expiry',
    },
    grantEmail: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Add an explicit viewer; repeat for multiple viewers',
    },
    revokeEmail: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Remove an explicit viewer; repeat for multiple viewers',
    },
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Move into this project',
    },
    home: {
      type: 'boolean',
      toKebab: true,
      description: 'Move back to the owner home area',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare edit abc123def4 --title "Launch plan" --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare edit abc123def4 --visibility private --grant-email viewer@example.com --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare edit https://artifactshare.com/a/abc123def4 --project-id prj123 --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare edit abc123def4 --home --json

Link sharing accepts --visibility link with either --link-expires-at <RFC3339 UTC> or --no-link-expiry. These expiry options are mutually exclusive.

Edit changes artifact settings without adding a new version. Use update to replace content.
Move remains available for placement-only automation; edit is the main command for post-share settings.

Common failures:
  auth_required          Set ARTIFACTSHARE_TOKEN before edit
  target_not_found       Retry with an artifact ID, share URL, or sandbox URL
  destination_conflict   Choose either --project-id or --home
  invalid_destination    Use an active project id from projects list, or --home
  workspace_unavailable  Use --visibility private for personal Google accounts
  too_many_grants        Remove viewers or grant fewer email addresses`,
})

const deleteDefinition = define({
  name: 'delete',
  description: 'Permanently delete an artifact you shared.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare delete abc123def4 --json
npm exec --yes --package=@artifactshare/cli -- artifactshare delete https://artifactshare.com/a/abc123def4 --json

Delete permanently removes the artifact and its version history. This cannot be undone.
Use resolve first when a user gives a title or project name, then pass the id here.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before delete
  target_not_found   Retry with an artifact ID, share URL, or sandbox URL
  service_error      Retry later if deletion could not complete`,
})

const resolveDefinition = define({
  name: 'resolve',
  description: 'Find artifact, version, and project candidates before writing.',
  toKebab: true,
  args: {
    ...commonArgs,
    value: {
      type: 'positional',
      description: 'Share URL, sandbox URL, ID, title, or project name',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare resolve "Weekly report" --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare resolve https://artifactshare.com/a/abc123def4 --json

Use resolve before write commands when a user gives a title or project name.
Pass the returned artifact id or project id to the next command.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before resolve
  validation_failed  Pass a non-empty URL, ID, title, or project name
  network_failed     Check --base-url and network access`,
})

const downloadDefinition = define({
  name: 'download',
  description: 'Save an artifact source or static site bundle locally.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      // Optional so `download --project-id <id>` can run without a target;
      // runDownload validates the two modes' exclusivity itself.
      required: false,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Download every visible artifact in this project',
    },
    output: {
      type: 'string',
      toKebab: true,
      description: 'Output directory (default: artifact ID)',
    },
    force: {
      type: 'boolean',
      toKebab: true,
      description: 'Allow writing into an existing output directory',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare download abc123def4 --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare download --project-id <id> --output ./project-download --json
  ${agentDownloadCommand('https://artifactshare.com/a/abc123def4')}

Use resolve first when a user gives a title or project name, then pass the id here.
Download writes files to a directory so the result can be inspected or passed to update.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before download
  target_not_found   Retry with an artifact ID, share URL, or sandbox URL
  output_exists      Choose another --output path or pass --force
  validation_failed  Check --output and downloaded file paths`,
})

const openDefinition = define({
  name: 'open',
  description: 'Prepare agent skills and read an Artifact Share URL.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare open https://artifactshare.com/a/abc123def4 --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare open abc123def4 --json

Use this as the first command when an agent receives an Artifact Share URL.
It installs or updates the bundled Artifact Share skill in user scope (Claude Code,
Codex, or Cursor detected from the working directory; all three if none are
detected), then reads single-file artifacts. Cursor project scope is not
auto-installed; use skills install --tool cursor --scope project. Existing
project-scope skills are not modified. For static sites or multi-file artifacts,
the JSON includes a download next_command.

Common failures:
  auth_required           Set ARTIFACTSHARE_TOKEN before open
  skill_update_conflict   Inspect the file or run skills install --tool <tool> --force
  target_not_found        Retry with an artifact ID, share URL, or sandbox URL
  validation_failed       Pass a non-empty artifact ID or URL`,
})

const moveDefinition = define({
  name: 'move',
  description: 'Move an artifact into a project or back home.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID or /a/<id> share URL',
    },
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Move into this project',
    },
    home: {
      type: 'boolean',
      toKebab: true,
      description: 'Move back to the owner home area',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare move abc123def4 --project-id prj123 --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare move https://artifactshare.com/a/abc123def4 --home --json

Move changes the artifact destination. It does not add grants. Project visibility
artifacts may change audience when moved between projects; the JSON response
reports project_audience_may_change.

Common failures:
  auth_required          Set ARTIFACTSHARE_TOKEN before move
  target_not_found       Retry with an artifact ID or share URL
  destination_conflict   Choose either --project-id or --home
  invalid_destination    Use an active project id from projects list, or --home`,
})

const artifactsGetDefinition = define({
  name: 'get',
  description: 'Read a single-file artifact source and metadata.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
    offset: {
      type: 'string',
      toKebab: true,
      description: 'Character offset for continuing a truncated read',
    },
    include: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Extra data to include: versions or comments',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get abc123def4 --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get https://artifactshare.com/a/abc123def4 --include versions --include comments --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get abc123def4 --offset 200000 --json

Use resolve first when a user gives a title or project name, then pass the id here.
Read the successful JSON from data.content (the source) and data.version_id (the current version).
The response also includes data.truncated and data.next_offset. If data.truncated is true, call again with --offset set to data.next_offset and concatenate data.content until data.truncated is false.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before artifacts get
  target_not_found   Retry with an artifact ID, share URL, or sandbox URL
  unsupported_kind   Use download for static sites or other multi-file artifacts
  validation_failed  Check --offset and --include values`,
})

const artifactsListDefinition = define({
  name: 'list',
  description: 'List artifacts you shared, newest first.',
  toKebab: true,
  args: {
    ...commonArgs,
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Only artifacts in this project',
    },
    home: {
      type: 'boolean',
      toKebab: true,
      description: 'Only artifacts in the unfiled home area',
    },
    query: {
      type: 'string',
      toKebab: true,
      description: 'Only artifacts whose title contains this text',
    },
    cursor: {
      type: 'string',
      toKebab: true,
      description:
        'Continue listing from the cursor returned by the previous page',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --project-id <id> --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --home --query report --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --project-id <id> --cursor <token> --json

Use an id from this list with update, edit, move, delete, artifacts get, or comments list.

Common failures:
  auth_required       Set ARTIFACTSHARE_TOKEN before artifacts list
  invalid_destination Run projects list, then retry with --project-id <id> or --home
  validation_failed   Choose only one of --project-id or --home`,
})

const artifactsDefinition = define({
  name: 'artifacts',
  description: 'Read Artifact Share artifacts.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    list: lazyCommand(artifactsListDefinition, artifactsListRunner),
    get: lazyCommand(artifactsGetDefinition, artifactsGetRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <artifact-id-or-url> --json

Use artifacts list to find IDs for update, edit, move, delete, artifacts get, and comments list.
Use artifacts get to read back Markdown or HTML before update.`,
  run: parentCommandRunner('artifacts'),
})

const commentsListDefinition = define({
  name: 'list',
  description: 'Read the comments on an artifact.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments list abc123def4 --json

Returns up to 50 threads (open threads first); has_more reports whether more exist.
Each thread carries its messages, status, and quoted-text anchor when present.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before comments list
  target_not_found   Retry with an artifact ID, share URL, or sandbox URL`,
})

const commentsPostDefinition = define({
  name: 'post',
  description: 'Comment on an artifact, reply, or anchor a quoted span.',
  toKebab: true,
  args: {
    ...commonArgs,
    artifactIdOrUrl: {
      type: 'positional',
      toKebab: true,
      description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
    },
    body: {
      type: 'string',
      toKebab: true,
      description: 'Comment text (required)',
    },
    replyTo: {
      type: 'string',
      toKebab: true,
      description: 'Reply to this thread id from comments list',
    },
    quote: {
      type: 'string',
      toKebab: true,
      description:
        'Anchor the comment to this exact text from the artifact (new threads only)',
    },
    quoteBefore: {
      type: 'string',
      toKebab: true,
      description: 'Text just before the quote, to pick the right occurrence',
    },
    quoteAfter: {
      type: 'string',
      toKebab: true,
      description: 'Text just after the quote, to pick the right occurrence',
    },
    agent: {
      type: 'string',
      toKebab: true,
      description:
        'Agent name posting on behalf of the user (e.g. Claude, Cursor)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments post abc123def4 --body "Looks good" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post abc123def4 --body "Done" --reply-to <thread-id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post abc123def4 --body "Fix this" --quote "exact text" --json

Copy quote text from artifacts get so it matches the artifact exactly.

Common failures:
  auth_required      Set ARTIFACTSHARE_TOKEN before comments post
  target_not_found   Retry with an artifact ID, share URL, or sandbox URL
  thread_not_found   Run comments list and retry with a listed thread id
  thread_resolved    Reopen the thread in the viewer, or start a new thread
  quote_not_found    Copy the exact text from artifacts get
  validation_failed  Pass --body, and do not combine --quote with --reply-to`,
})

const commentThreadActionArgs = {
  ...commonArgs,
  artifactIdOrUrl: {
    type: 'positional',
    toKebab: true,
    description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
  },
  threadId: {
    type: 'string',
    toKebab: true,
    description: 'Thread id from comments list',
  },
} as const

const commentMessageActionArgs = {
  ...commonArgs,
  artifactIdOrUrl: {
    type: 'positional',
    toKebab: true,
    description: 'Artifact ID, /a/<id> share URL, or <id>.sandbox.* URL',
  },
  messageId: {
    type: 'string',
    toKebab: true,
    description: 'Message id from comments list',
  },
} as const

const commentsEditDefinition = define({
  name: 'edit',
  description: 'Edit a comment message you wrote.',
  toKebab: true,
  args: {
    ...commentMessageActionArgs,
    body: {
      type: 'string',
      toKebab: true,
      description: 'Updated comment text (required)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments edit abc123def4 --message-id <message-id> --body "Updated text" --json

Common failures:
  message_not_found  Run comments list and retry with a listed message_id
  forbidden          You can edit only your own comments
  validation_failed  Pass --message-id and --body`,
})

const commentsResolveDefinition = define({
  name: 'resolve',
  description: 'Mark a comment thread as resolved.',
  toKebab: true,
  args: commentThreadActionArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments resolve abc123def4 --thread-id <thread-id> --json

Common failures:
  thread_not_found   Run comments list and retry with a listed thread_id
  forbidden          Resolving needs the thread author, artifact owner, or workspace admin
  validation_failed  Pass --thread-id`,
})

const commentsReopenDefinition = define({
  name: 'reopen',
  description: 'Reopen a resolved comment thread.',
  toKebab: true,
  args: commentThreadActionArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments reopen abc123def4 --thread-id <thread-id> --json

Common failures:
  thread_not_found   Run comments list and retry with a listed thread_id
  forbidden          Reopening needs the thread author, artifact owner, or workspace admin
  validation_failed  Pass --thread-id`,
})

const commentsDeleteDefinition = define({
  name: 'delete',
  description: 'Permanently delete a comment message or a whole thread.',
  toKebab: true,
  args: {
    ...commentThreadActionArgs,
    messageId: {
      type: 'string',
      toKebab: true,
      description: 'Message id from comments list; omit to delete the thread',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments delete abc123def4 --thread-id <thread-id> --message-id <message-id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments delete abc123def4 --thread-id <thread-id> --json

Deleting comments cannot be undone. Omit --message-id only when deleting the whole thread.

Common failures:
  thread_not_found   Run comments list and retry with a listed thread_id
  message_not_found  Retry with a message_id from that thread
  forbidden          You can delete your own comments; owners/admins can delete any thread
  validation_failed  Pass --thread-id`,
})

const previewNextDefinition = define({
  name: 'next',
  description:
    'Return every undelivered annotation batch; with --wait, block until one is submitted.',
  toKebab: true,
  args: {
    ...commonArgs,
    file: {
      type: 'positional',
      toKebab: true,
      required: false,
      description: 'Previewed file path (omit when only one session is live)',
    },
    wait: {
      type: 'string',
      toKebab: true,
      description: 'Seconds to block waiting for a submission (0-3600)',
    },
    session: {
      type: 'string',
      toKebab: true,
      description: 'Preview session id from the ready JSON',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare preview next ./lp.html --wait 90
npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session 0123456789abcdef

Returns {items: []} with timed_out: true when the wait expires, and
session_ended: true when the preview shuts down while waiting. Successful
results include the sanitized agent notification projection.

Common failures:
  preview_session_not_found  Start a session with: preview <file>
  preview_wait_conflict      Use the existing wait, or retry after it returns
  preview_request_failed     The preview rejected the request; check the input`,
})

const previewDoneDefinition = define({
  name: 'done',
  description:
    'Report batch outcomes (fixed | skipped) from stdin JSON; idempotent per generation.',
  toKebab: true,
  args: {
    ...commonArgs,
    file: {
      type: 'positional',
      toKebab: true,
      required: false,
      description: 'Previewed file path (omit when only one session is live)',
    },
    stdin: {
      type: 'boolean',
      toKebab: true,
      description: 'Read {"items": [...]} from standard input (required)',
    },
    session: {
      type: 'string',
      toKebab: true,
      description: 'Preview session id from the ready JSON',
    },
  },
  examples: `printf '%s' '{"items":[{"thread":"t1","generation":1,"outcome":"fixed","note":"Tightened the headline"}]}' | npm exec --yes --package=@artifactshare/cli -- artifactshare preview done ./lp.html --stdin

Each item returns accepted | stale | already_reported | unknown_thread. The
result also includes the sanitized agent notification projection.

Common failures:
  preview_session_not_found  Start a session with: preview <file>
  preview_request_failed     The preview rejected the batch; check thread ids and generations`,
})

const previewReplyDefinition = define({
  name: 'reply',
  description:
    'Append a reply to an annotation thread without changing its state.',
  toKebab: true,
  args: {
    ...commonArgs,
    file: {
      type: 'positional',
      toKebab: true,
      required: false,
      description: 'Previewed file path (omit when only one session is live)',
    },
    thread: {
      type: 'string',
      toKebab: true,
      description: 'Thread id from preview next (required)',
    },
    body: {
      type: 'string',
      toKebab: true,
      description: 'Reply text (required)',
    },
    session: {
      type: 'string',
      toKebab: true,
      description: 'Preview session id from the ready JSON',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare preview reply ./lp.html --thread t1 --body "Which shade of coral?"

Common failures:
  preview_session_not_found  Start a session with: preview <file>
  preview_request_failed     Unknown thread id; list them with preview next`,
})

const previewStopDefinition = define({
  name: 'stop',
  description: 'Stop a live preview session. Annotations stay saved on disk.',
  toKebab: true,
  args: {
    ...commonArgs,
    file: {
      type: 'positional',
      toKebab: true,
      required: false,
      description: 'Previewed file path (omit when only one session is live)',
    },
    session: {
      type: 'string',
      toKebab: true,
      description: 'Preview session id from the ready JSON',
    },
    force: {
      type: 'boolean',
      toKebab: true,
      description:
        'Clear a session record once its process is gone (refused while it is alive)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop ./lp.html
npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop ./lp.html --force

Common failures:
  preview_session_not_found  Nothing to stop; the session already ended
  preview_request_failed     The preview rejected the request; check the input`,
})

const previewStartDefinition = define({
  name: 'start',
  description:
    'Serve a local .md or .html file with the product viewer look. Invoked as: preview <file>.',
  toKebab: true,
  args: {
    ...commonArgs,
    file: {
      type: 'positional',
      toKebab: true,
      required: false,
      description: 'Local .md or .html file to preview',
    },
    noOpen: {
      type: 'boolean',
      toKebab: true,
      description: 'Do not open the browser automatically',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare preview ./lp.html
npm exec --yes --package=@artifactshare/cli -- artifactshare preview ./lp.html --no-open

Prints one ready JSON line ({url, session, share_origin, reused, agent}) and
keeps serving until stopped. Re-running against a live session reuses it.

Common failures:
  validation_failed            Pass a single local .md or .html file
  preview_session_unverified   Retry an unresponsive session; stop and restart a session created by an older CLI`,
})

const previewDefinition = define({
  name: 'preview',
  description:
    'Preview a local .md or .html file with the product viewer look, annotate it in the browser, and hand batches to an agent. Nothing is uploaded.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    start: lazyCommand(previewStartDefinition, previewRunner),
    next: lazyCommand(previewNextDefinition, previewNextRunner),
    done: lazyCommand(previewDoneDefinition, previewDoneRunner),
    reply: lazyCommand(previewReplyDefinition, previewReplyRunner),
    stop: lazyCommand(previewStopDefinition, previewStopRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare preview ./lp.html
npm exec --yes --package=@artifactshare/cli -- artifactshare preview next ./lp.html --wait 90

Common failures:
  validation_failed            Pass a single local .md or .html file
  preview_session_unverified   Retry an unresponsive session; stop and restart a session created by an older CLI
  preview_session_not_found    No live session; start one with preview <file>`,
  run: parentCommandRunner('preview'),
})

const commentsDefinition = define({
  name: 'comments',
  description:
    'Read, write, edit, resolve, reopen, and delete artifact comments.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    list: lazyCommand(commentsListDefinition, commentsListRunner),
    post: lazyCommand(commentsPostDefinition, commentsPostRunner),
    edit: lazyCommand(commentsEditDefinition, commentsEditRunner),
    resolve: lazyCommand(commentsResolveDefinition, commentsResolveRunner),
    reopen: lazyCommand(commentsReopenDefinition, commentsReopenRunner),
    delete: lazyCommand(commentsDeleteDefinition, commentsDeleteRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare comments list <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body "<text>" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments edit <artifact-id-or-url> --message-id <message-id> --body "<text>" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments resolve <artifact-id-or-url> --thread-id <thread-id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments delete <artifact-id-or-url> --thread-id <thread-id> --json

Deleting comments cannot be undone.`,
  run: parentCommandRunner('comments'),
})

const profilesListDefinition = define({
  name: 'list',
  description: 'List saved CLI profiles and the default profile.',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare profiles list --json

token_present shows whether a saved credential exists; token values are never printed.`,
})

const profilesUseDefinition = define({
  name: 'use',
  description: 'Switch the default CLI profile.',
  toKebab: true,
  args: {
    ...commonArgs,
    name: {
      type: 'positional',
      description: 'Profile name to make the default',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare profiles use client-a --json

Common failures:
  profile_not_found  Run profiles list to see saved profiles, or login --profile <name>`,
})

const profilesImportTokenDefinition = define({
  name: 'import-token',
  description:
    'Read an API token or bot token from standard input and save it to a CLI profile.',
  toKebab: true,
  args: {
    json: commonArgs.json,
    baseUrl: commonArgs.baseUrl,
    profile: commonArgs.profile,
    allowPlaintextTokenStore: commonArgs.allowPlaintextTokenStore,
    insecureLocalhost: commonArgs.insecureLocalhost,
    force: {
      type: 'boolean',
      toKebab: true,
      description:
        'Replace an existing profile credential when importing a bot token (no-op for API tokens)',
    },
  },
  examples: `printf '%s' "$TOKEN" | npm exec --yes --package=@artifactshare/cli -- artifactshare profiles import-token --profile client-a --json

Reads the token from standard input only. Use this in unattended CI or scripts without browser approval after issuing a token at ${DEFAULT_BASE_URL}/settings/tokens.

Bot tokens (asb_ prefix, issued once by a workspace admin) are detected by prefix and imported as rotating refresh credentials; the first refresh consumes the displayed token, so the rotated credential is stored before success is reported. Importing a bot token over an existing profile credential requires --force (--force is a no-op for API tokens). A stored bot credential cannot be re-imported; recovery is an admin reissue.

Common failures:
  validation_failed          Pass --profile and pipe a non-empty token on standard input; bot-token overwrite needs --force
  token_invalid              The token is invalid or expired
  bot_token_invalid          The bot token was revoked, superseded by a reissue, or the bot was stopped; ask an admin to reissue
  auth_account_mismatch      The token belongs to a different account than the saved profile email
  token_store_unavailable    Configure an OS credential store or use the explicit plaintext fallback`,
})

const profilesDeleteDefinition = define({
  name: 'delete',
  description: 'Delete a saved CLI profile and its credential.',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare profiles delete client-a --json

Removes the profile from config.json and clears its saved credential.
If the deleted profile was the default, default_profile becomes null.

Common failures:
  profile_not_found          Run profiles list to see saved profiles
  token_store_unavailable    Credential removal failed; the profile entry is kept`,
})

const configGetDefinition = define({
  name: 'get',
  description:
    'Read where home posts are delivered and other visibility settings.',
  toKebab: true,
  args: {
    ...commonArgs,
    key: {
      type: 'positional',
      required: false,
      description:
        'home_audience (default; keyless JSON returns only this key), default_artifact_visibility (compatibility alias), or default_project_visibility',
    },
    scope: {
      type: 'string',
      toKebab: true,
      description: 'user, repository, or effective',
    },
  },
})

const configSetDefinition = define({
  name: 'set',
  description: 'Set home audience or a default visibility setting.',
  toKebab: true,
  args: {
    ...commonArgs,
    key: { type: 'positional', description: 'Configuration key' },
    value: { type: 'positional', description: 'workspace or private' },
    scope: { type: 'string', toKebab: true, description: 'user or repository' },
  },
})

const configUnsetDefinition = define({
  name: 'unset',
  description: 'Remove a home audience or default visibility setting.',
  toKebab: true,
  args: {
    ...commonArgs,
    key: { type: 'positional', description: 'Configuration key' },
    scope: { type: 'string', toKebab: true, description: 'user or repository' },
  },
})

const configDefinition = define({
  name: 'config',
  description: 'Manage where home posts are delivered and project defaults.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    get: lazyCommand(configGetDefinition, configGetRunner),
    set: lazyCommand(configSetDefinition, configSetRunner),
    unset: lazyCommand(configUnsetDefinition, configUnsetRunner),
  },
  examples: `Posting to a project delivers to that project's audience. Without a destination, share posts to home.
Choose the home audience by purpose:
  Personal safe default (this CLI environment only):
    npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json
  Shared policy agreed by all repository participants:
    npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience workspace --scope repository --json
  One-time audience for a single post: pass --visibility private|workspace.
  Check the resolved audience with:
    npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json

Keys:
  home_audience                  Canonical home-post audience.
  default_artifact_visibility    Compatibility alias for home_audience.
  default_project_visibility     Advanced default for projects create.

Scopes: user stores in the global config; repository stores in the shared .artifactshare/config.json; effective reads the resolved value. Home audience resolution is repository home_audience, repository alias, user home_audience, user alias, then product default workspace. Project defaults resolve repository, user, then workspace. Keyless config get --json returns only home_audience; pass an explicit key to read default_project_visibility or the compatibility alias. Explicit --visibility overrides the destination default for one post.`,
  run: parentCommandRunner('config'),
})

const profilesDefinition = define({
  name: 'profiles',
  description: 'Manage saved CLI profiles.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    list: lazyCommand(profilesListDefinition, profilesListRunner),
    use: lazyCommand(profilesUseDefinition, profilesUseRunner),
    'import-token': lazyCommand(
      profilesImportTokenDefinition,
      profilesImportTokenRunner,
    ),
    delete: lazyCommand(profilesDeleteDefinition, profilesDeleteRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare profiles list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles use client-a --json
printf '%s' "$TOKEN" | npm exec --yes --package=@artifactshare/cli -- artifactshare profiles import-token --profile client-a --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles delete client-a --json`,
  run: parentCommandRunner('profiles'),
})

const projectsListDefinition = define({
  name: 'list',
  description: 'List projects you can share into.',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json

is_default marks the working-directory default project from .artifactshare/config.json.
Use a project id with share --project-id or init --project-id.`,
})

const projectsCreateDefinition = define({
  name: 'create',
  description: 'Create a project you can share into.',
  toKebab: true,
  args: {
    ...commonArgs,
    name: {
      type: 'positional',
      description: 'Project name',
    },
    description: {
      type: 'string',
      toKebab: true,
      description: 'Project description',
    },
    visibility: {
      type: 'string',
      toKebab: true,
      description:
        'workspace or private (default: default_project_visibility, resolved from repository, user, then workspace)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare projects create "Launch review" --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare projects create "Client" --description "Weekly reports" --visibility private --json

Persist the default for project creation in the repository:
  npm exec --yes --package=@artifactshare/cli -- artifactshare config get default_project_visibility --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare config set default_project_visibility private --scope repository --json

The response includes project.id and next_command for share --project-id.

Common failures:
  auth_required          Set ARTIFACTSHARE_TOKEN before projects create
  upload_not_allowed     Publishing is temporarily unavailable; contact Artifact Share support
  project_name_conflict  Choose another name or archive the existing project first
  validation_failed      Pass a non-empty name and valid --visibility`,
})

const projectsEditDefinition = define({
  name: 'edit',
  description: 'Edit project settings and audience.',
  toKebab: true,
  args: {
    ...commonArgs,
    id: {
      type: 'positional',
      description: 'Project id',
    },
    name: {
      type: 'string',
      toKebab: true,
      description: 'New project name',
    },
    description: {
      type: 'string',
      toKebab: true,
      description: 'New project description; pass an empty value to clear it',
    },
    visibility: {
      type: 'string',
      toKebab: true,
      description: 'workspace or private',
    },
    addEmail: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Add an audience email address; repeat for multiple',
    },
    removeEmail: {
      type: 'string',
      multiple: true,
      toKebab: true,
      description: 'Remove an audience email address; repeat for multiple',
    },
    archive: {
      type: 'boolean',
      toKebab: true,
      description: 'Archive the project after other edits',
    },
    unarchive: {
      type: 'boolean',
      toKebab: true,
      description: 'Unarchive the project before other edits',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --name "Launch review" --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --visibility private --add-email viewer@example.com --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --archive --json
  npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --unarchive --description "" --json

Common failures:
  target_not_found       Use a project id from projects list
  forbidden              Only the creator or workspace admin can edit project settings
  project_archived       Retry with --unarchive, or unarchive first
  project_name_conflict  Choose another name or archive the existing project first
  too_many_grants        Remove project audience entries before adding more
  validation_failed      Pass a project id and at least one valid edit option`,
})

const projectsDefinition = define({
  name: 'projects',
  description: 'Create, find, and edit share destinations.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    list: lazyCommand(projectsListDefinition, projectsListRunner),
    create: lazyCommand(projectsCreateDefinition, projectsCreateRunner),
    edit: lazyCommand(projectsEditDefinition, projectsEditRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects create "Launch review" --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --add-email viewer@example.com --json`,
  run: parentCommandRunner('projects'),
})

const skillsToolArgs = {
  tool: {
    type: 'string',
    multiple: true,
    toKebab: true,
    description: 'Agent tool: codex, claude, or cursor; repeat for multiple',
  },
  scope: {
    type: 'string',
    toKebab: true,
    description:
      'Install scope: project or user (default: project for install; user for ensure --tool auto)',
  },
  dryRun: {
    type: 'boolean',
    toKebab: true,
    description: 'Show planned file changes without writing',
  },
} as const

const skillsInstallDefinition = define({
  name: 'install',
  description: 'Install the bundled Artifact Share skill for an agent tool.',
  toKebab: true,
  args: {
    ...commonArgs,
    ...skillsToolArgs,
    force: {
      type: 'boolean',
      toKebab: true,
      description:
        'Overwrite an existing unmanaged file or reinstall the same version',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool codex --scope project --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool claude --tool cursor --dry-run --json

Writes a managed SKILL.md (codex, claude) or Cursor rule (cursor).
Files without the Artifact Share managed marker are never overwritten without --force.

Common failures:
  validation_failed       Pass --tool codex|claude|cursor; cursor supports --scope project only
  skill_update_conflict   An unmanaged file exists at the target path; inspect it or pass --force`,
})

const skillsListDefinition = define({
  name: 'list',
  description: 'Show skill install status for each supported agent tool.',
  toKebab: true,
  args: commonArgs,
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills list --json

Reports each tool and scope with detection, install state, and update availability.
Runs locally; no network or authentication is used.`,
})

const skillsUpdateDefinition = define({
  name: 'update',
  description: 'Update installed Artifact Share skills to the bundled version.',
  toKebab: true,
  args: {
    ...commonArgs,
    ...skillsToolArgs,
    force: {
      type: 'boolean',
      toKebab: true,
      description:
        'Rewrite managed files even when the version already matches',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --tool codex --scope user --json

Only files created by skills install (managed marker present) are updated.

Common failures:
  skill_update_conflict   A managed marker is broken; inspect the file or reinstall with --force`,
})

const skillsEnsureDefinition = define({
  name: 'ensure',
  description: 'Install or update the bundled Artifact Share skill.',
  toKebab: true,
  args: {
    ...commonArgs,
    ...skillsToolArgs,
    dryRun: {
      type: 'boolean',
      toKebab: true,
      description: 'Show planned file changes without writing',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool auto --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool auto --scope user --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool claude --json

Use --tool auto from an agent workspace. It detects .claude, .codex/.agents, or
.cursor in the current directory and installs or updates the matching user-scope
skills. If none are present, it prepares user-scope Codex, Claude Code, and Cursor
skills. Cursor project scope needs skills install --tool cursor --scope project.

Common failures:
  validation_failed       Pass --tool auto|codex|claude|cursor; --tool auto supports --scope user only (omit --scope or pass --scope user). Project scope needs skills install --tool <tool> --scope project
  skill_update_conflict   An unmanaged or broken skill file exists; inspect it before overwriting`,
})

const skillsRemoveDefinition = define({
  name: 'remove',
  description: 'Remove Artifact Share skills installed by this CLI.',
  toKebab: true,
  args: {
    ...commonArgs,
    ...skillsToolArgs,
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills remove --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills remove --tool cursor --json

Only files created by skills install are deleted; unmanaged files are skipped.`,
})

const skillsDefinition = define({
  name: 'skills',
  description: 'Install agent skills for Codex, Claude Code, and Cursor.',
  toKebab: true,
  args: commonArgs,
  subCommands: {
    install: lazyCommand(skillsInstallDefinition, skillsInstallRunner),
    list: lazyCommand(skillsListDefinition, skillsListRunner),
    update: lazyCommand(skillsUpdateDefinition, skillsUpdateRunner),
    ensure: lazyCommand(skillsEnsureDefinition, skillsEnsureRunner),
    remove: lazyCommand(skillsRemoveDefinition, skillsRemoveRunner),
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool codex --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool auto --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills list --json`,
  run: parentCommandRunner('skills'),
})

const initDefinition = define({
  name: 'init',
  description:
    'Set up Artifact Share for this directory, or save its defaults.',
  toKebab: true,
  args: {
    ...commonArgs,
    projectId: {
      type: 'string',
      toKebab: true,
      description: 'Default project for sharing in this directory',
    },
    dryRun: {
      type: 'boolean',
      toKebab: true,
      description:
        'Show the planned skill changes without writing (onboarding)',
    },
  },
  examples: `npm exec --yes --package=@artifactshare/cli -- artifactshare init --json
npm exec --yes --package=@artifactshare/cli -- artifactshare init --dry-run --json
npm exec --yes --package=@artifactshare/cli -- artifactshare init --profile client-a --project-id <id> --json

Without flags, init detects Claude Code, Codex, or Cursor in the working directory,
installs or updates the bundled skill in user scope, and shows the next steps (sign
in, then share). With no agent detected, it prepares user-scope Codex, Claude Code,
and Cursor skills. Cursor project scope is not auto-installed; use skills install
--tool cursor --scope project. Existing project-scope skills are not modified.
data.mode is "onboarding".
With --profile or --project-id, init saves working-directory defaults to
.artifactshare/config.local.json instead (data.mode is "config"); secrets are never written there.

Common failures:
  skill_update_conflict   An unmanaged or broken skill file exists; inspect it before overwriting
  profile_not_found       Run profiles list to see saved profiles, or login --profile <name>`,
})

const whoamiDefinition = define({
  name: 'whoami',
  description: 'Show the authenticated CLI user.',
  toKebab: true,
  args: commonArgs,
})

const doctorDefinition = define({
  name: 'doctor',
  description:
    'Check token storage, authentication, destination, network, and upload access.',
  toKebab: true,
  args: commonArgs,
})

const changelogDefinition = define({
  name: 'changelog',
  description:
    'Show the installed CLI version, recent changes, and the public updates page.',
  toKebab: true,
  args: {
    json: commonArgs.json,
  },
})

const cliArgv = process.argv.slice(2)
let isDirectExecution = false
if (process.argv[1]) {
  try {
    isDirectExecution =
      realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    isDirectExecution = import.meta.url === pathToFileURL(process.argv[1]).href
  }
}
if (isDirectExecution) {
  main(cliArgv).catch((error) => {
    writeFailure(
      'unknown',
      unexpectedError(error),
      outputModeFromArgv(cliArgv),
      1,
    )
  })
}
