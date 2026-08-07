import type { CommandContext } from 'gunshi'
import type { CliCommand } from './types.js'
import { parsedArgsFromContext } from './args.js'
import { CLI_INVOCATION, SUBCOMMANDS } from './constants.js'
import { validationError } from './errors.js'
import {
  dataWithSkillAutoUpdate,
  outputMode,
  skillAutoUpdateHumanOutput,
  writeFailure,
} from './output.js'
import { runOpen } from './command-runners/open.js'
import {
  runArtifactsGet,
  runArtifactsList,
} from './command-runners/artifacts-get.js'
import {
  runCommentsDelete,
  runCommentsEdit,
  runCommentsList,
  runCommentsPost,
  runCommentsReopen,
  runCommentsResolve,
} from './command-runners/comments.js'
import { runDelete } from './command-runners/delete.js'
import { runDoctor } from './command-runners/doctor.js'
import { runChangelog } from './command-runners/changelog.js'
import { runDownload } from './command-runners/download.js'
import { runEdit } from './command-runners/edit.js'
import { runInit } from './command-runners/init.js'
import { runLogin } from './command-runners/login.js'
import { runLogout } from './command-runners/logout.js'
import { runMove } from './command-runners/move.js'
import {
  runProfilesList,
  runProfilesDelete,
  runProfilesImportToken,
  runProfilesUse,
} from './command-runners/profiles.js'
import {
  runProjectsCreate,
  runProjectsEdit,
  runProjectsList,
} from './command-runners/projects.js'
import { runShare } from './command-runners/share.js'
import { runResolve } from './command-runners/resolve.js'
import {
  runSkillsInstall,
  runSkillsEnsure,
  runSkillsList,
  runSkillsRemove,
  runSkillsUpdate,
  autoUpdateUserManagedSkills,
} from './command-runners/skills.js'
import { runUpdate } from './command-runners/update.js'
import { runAppend } from './command-runners/append.js'
import { runWhoami } from './command-runners/whoami.js'
import {
  runConfigGet,
  runConfigSet,
  runConfigUnset,
} from './command-runners/config.js'

export async function shareRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('share', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runShare(parsed, outputMode(parsed.options)),
  )
}

export async function loginRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('login', ctx)
  const mode = outputMode(parsed.options)
  return await runWithSkillAutoUpdate(parsed, () => runLogin(parsed, mode))
}

export async function logoutRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('logout', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runLogout(parsed, outputMode(parsed.options)),
  )
}

export async function updateRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('update', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runUpdate(parsed, outputMode(parsed.options)),
  )
}
export async function appendRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('append', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runAppend(parsed, outputMode(parsed.options)),
  )
}

export async function editRunner(ctx: Readonly<CommandContext>): Promise<void> {
  const parsed = parsedArgsFromContext('edit', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runEdit(parsed, outputMode(parsed.options)),
  )
}

export async function deleteRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('delete', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runDelete(parsed, outputMode(parsed.options)),
  )
}

export async function resolveRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('resolve', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runResolve(parsed, outputMode(parsed.options)),
  )
}

export async function downloadRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('download', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runDownload(parsed, outputMode(parsed.options)),
  )
}

export async function openRunner(ctx: Readonly<CommandContext>): Promise<void> {
  const parsed = parsedArgsFromContext('open', ctx)
  return await runOpen(parsed, outputMode(parsed.options))
}

export async function moveRunner(ctx: Readonly<CommandContext>): Promise<void> {
  const parsed = parsedArgsFromContext('move', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runMove(parsed, outputMode(parsed.options)),
  )
}

export async function artifactsGetRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('artifacts get', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runArtifactsGet(parsed, outputMode(parsed.options)),
  )
}

export async function artifactsListRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('artifacts list', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runArtifactsList(parsed, outputMode(parsed.options)),
  )
}

export async function commentsListRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments list', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsList(parsed, outputMode(parsed.options)),
  )
}

export async function commentsPostRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments post', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsPost(parsed, outputMode(parsed.options)),
  )
}

export async function commentsEditRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments edit', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsEdit(parsed, outputMode(parsed.options)),
  )
}

export async function commentsResolveRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments resolve', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsResolve(parsed, outputMode(parsed.options)),
  )
}

export async function commentsReopenRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments reopen', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsReopen(parsed, outputMode(parsed.options)),
  )
}

export async function commentsDeleteRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('comments delete', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runCommentsDelete(parsed, outputMode(parsed.options)),
  )
}

export async function whoamiRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('whoami', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runWhoami(parsed, outputMode(parsed.options)),
  )
}

export async function profilesListRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('profiles list', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProfilesList(parsed, outputMode(parsed.options)),
  )
}

export async function configGetRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('config get', ctx)
  return await runConfigGet(parsed, outputMode(parsed.options))
}

export async function configSetRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('config set', ctx)
  return await runConfigSet(parsed, outputMode(parsed.options))
}

export async function configUnsetRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('config unset', ctx)
  return await runConfigUnset(parsed, outputMode(parsed.options))
}

export async function profilesUseRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('profiles use', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProfilesUse(parsed, outputMode(parsed.options)),
  )
}

export async function profilesImportTokenRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('profiles import-token', ctx)
  if (hasOptionToken(ctx, 'token')) parsed.options.token = '<redacted>'
  return await runWithSkillAutoUpdate(parsed, () =>
    runProfilesImportToken(parsed, outputMode(parsed.options)),
  )
}

export async function profilesDeleteRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('profiles delete', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProfilesDelete(parsed, outputMode(parsed.options)),
  )
}

export async function projectsListRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('projects list', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProjectsList(parsed, outputMode(parsed.options)),
  )
}

export async function projectsCreateRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('projects create', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProjectsCreate(parsed, outputMode(parsed.options)),
  )
}

export async function projectsEditRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('projects edit', ctx)
  return await runWithSkillAutoUpdate(parsed, () =>
    runProjectsEdit(parsed, outputMode(parsed.options)),
  )
}

export async function initRunner(ctx: Readonly<CommandContext>): Promise<void> {
  const parsed = parsedArgsFromContext('init', ctx)
  return await runInit(parsed, outputMode(parsed.options))
}

export async function skillsInstallRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('skills install', ctx)
  return await runSkillsInstall(parsed, outputMode(parsed.options))
}

export async function skillsListRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('skills list', ctx)
  return await runSkillsList(parsed, outputMode(parsed.options))
}

export async function skillsUpdateRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('skills update', ctx)
  return await runSkillsUpdate(parsed, outputMode(parsed.options))
}

export async function skillsEnsureRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('skills ensure', ctx)
  return await runSkillsEnsure(parsed, outputMode(parsed.options))
}

export async function skillsRemoveRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('skills remove', ctx)
  return await runSkillsRemove(parsed, outputMode(parsed.options))
}

export async function doctorRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('doctor', ctx)
  return await runDoctor(parsed, outputMode(parsed.options))
}

export async function changelogRunner(
  ctx: Readonly<CommandContext>,
): Promise<void> {
  const parsed = parsedArgsFromContext('changelog', ctx)
  return await runChangelog(parsed, outputMode(parsed.options))
}

async function runWithSkillAutoUpdate(
  parsed: ReturnType<typeof parsedArgsFromContext>,
  runner: () => Promise<void>,
): Promise<void> {
  const mode = outputMode(parsed.options)
  if (!mode.json) {
    const originalExitCode = process.exitCode
    await runner()
    if (process.exitCode !== originalExitCode && process.exitCode !== 0) return
    const autoUpdate = await autoUpdateUserManagedSkills()
    if (autoUpdate && autoUpdate.targets.length > 0) {
      process.stdout.write(
        skillAutoUpdateHumanOutput({ skills: { auto_update: autoUpdate } }),
      )
    }
    return
  }

  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalExitCode = process.exitCode
  let buffered = ''
  process.stdout.write = ((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    buffered += Buffer.isBuffer(chunk)
      ? chunk.toString(
          typeof encoding === 'string'
            ? (encoding as BufferEncoding)
            : undefined,
        )
      : String(chunk)
    if (typeof encoding === 'function') encoding()
    if (typeof cb === 'function') cb()
    return true
  }) as typeof process.stdout.write

  try {
    await runner()
  } catch (error) {
    process.stdout.write = originalWrite as typeof process.stdout.write
    originalWrite(buffered)
    throw error
  }
  process.stdout.write = originalWrite as typeof process.stdout.write

  if (process.exitCode !== originalExitCode && process.exitCode !== 0) {
    originalWrite(buffered)
    return
  }

  const autoUpdate = await autoUpdateUserManagedSkills()
  if (!autoUpdate || autoUpdate.targets.length === 0) {
    originalWrite(buffered)
    return
  }

  if (mode.json) {
    try {
      const payload = JSON.parse(buffered) as { data?: unknown }
      payload.data = dataWithSkillAutoUpdate(payload.data, autoUpdate)
      originalWrite(`${JSON.stringify(payload, null, 2)}\n`)
      return
    } catch {
      originalWrite(buffered)
      return
    }
  }

  originalWrite(buffered)
  originalWrite(
    skillAutoUpdateHumanOutput({ skills: { auto_update: autoUpdate } }),
  )
}

// A bare parent command would otherwise dispatch to a no-op and exit 0 with
// empty output, which a JSON consumer cannot tell apart from success.
export function parentCommandRunner(command: CliCommand) {
  return (ctx: Readonly<CommandContext>): void => {
    const parsed = parsedArgsFromContext(command, ctx)
    const subcommands = (SUBCOMMANDS[command] ?? []).join(' | ')
    writeFailure(
      command,
      validationError(
        'A subcommand is required.',
        `Run ${CLI_INVOCATION} ${command} <${subcommands}>.`,
      ),
      outputMode(parsed.options),
      1,
    )
  }
}

function hasOptionToken(ctx: Readonly<CommandContext>, name: string): boolean {
  for (const token of ctx.tokens) {
    if (token.kind !== 'option') continue
    const rawName = token.name ?? token.rawName?.replace(/^--?/, '')
    if (rawName === name) return true
  }
  return false
}
