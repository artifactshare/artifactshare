import { WriteBoundary, WriteBoundaryError } from '../write-boundary.js'
import { dirname } from 'node:path'
import type {
  InitConfigData,
  InitNextStep,
  InitOnboardingData,
  OutputMode,
  ParsedArgs,
} from '../types.js'
import {
  configString,
  PROJECT_CONFIG_LOCAL_PATH,
  projectConfigLocalPath,
  resolveProjectConfig,
} from '../destination.js'
import { CLI_INVOCATION } from '../constants.js'
import { resolveCredential } from '../credentials.js'
import { ensureGitExclude } from '../git-exclude.js'
import {
  configHomeUnavailableError,
  profileNotFoundError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { configHome, nonEmpty, readGlobalConfig } from '../token-store.js'
import { ensureSkills } from './skills.js'

export function runInit(parsed: ParsedArgs, mode: OutputMode): Promise<void> {
  const profile = nonEmpty(parsed.options.profile)
  const projectId = nonEmpty(parsed.options.projectId)

  // No config flags: set up this directory by installing the agent skill and
  // showing the next steps. With --profile/--project-id, save the working
  // directory defaults instead (the older behavior).
  if (!profile && !projectId) {
    return runInitOnboarding(parsed, mode)
  }
  return runInitConfig(parsed, mode, profile, projectId)
}

async function runInitOnboarding(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'init'
  // Reuse the `skills ensure --tool auto` user-scope path so detection,
  // the fallback pair, and conflict handling stay identical to skills ensure.
  const skills = await ensureSkills(
    {
      ...parsed,
      options: { ...parsed.options, tool: 'auto' },
    },
    mode,
    {
      command,
      autoUpdateUserManaged: true,
      skipBrokenUserSkills: true,
    },
  )
  // ensureSkills writes the failure JSON itself (with command: "init").
  if (!skills) return

  const project = await resolveProjectConfig()
  const credential = await resolveCredential(parsed.options, project)
  const signedIn = credential.ok

  const data: InitOnboardingData = {
    mode: 'onboarding',
    skills,
    signed_in: signedIn,
    next_steps: onboardingNextSteps(signedIn),
  }
  return writeSuccess(command, data, mode)
}

function onboardingNextSteps(signedIn: boolean): InitNextStep[] {
  return [
    {
      id: 'login',
      title: signedIn
        ? 'Already signed in.'
        : 'Sign in so you can share files.',
      command: `${CLI_INVOCATION} login --json`,
      ...(!signedIn
        ? {
            requires_browser_approval: true,
            awaits_user_action: true,
          }
        : {}),
      done: signedIn,
    },
    {
      id: 'share',
      title: 'Share a file or folder to get a link.',
      command: `${CLI_INVOCATION} share <path> --json`,
    },
  ]
}

async function runInitConfig(
  parsed: ParsedArgs,
  mode: OutputMode,
  profile: string | undefined,
  projectId: string | undefined,
): Promise<void> {
  const command = 'init'

  // --dry-run only previews the onboarding skill install; rejecting it here
  // keeps it from silently writing config.local.json on the save path.
  if (parsed.options.dryRun === true) {
    return writeFailure(
      command,
      validationError(
        '--dry-run is only supported without --profile or --project-id.',
        'Run init --dry-run by itself to preview the skill install, or drop --dry-run to save the defaults.',
      ),
      mode,
      1,
    )
  }

  const boundary = new WriteBoundary()
  const path = projectConfigLocalPath()
  try {
    await boundary.outputParent(process.cwd())
    await boundary.record(dirname(path), true)
    const localText = await boundary.read(path)
    if (profile) {
      if (!configHome()) {
        return writeFailure(
          command,
          configHomeUnavailableError(profile),
          mode,
          1,
        )
      }
      const globalConfig = await readGlobalConfig()
      // Object.hasOwn keeps inherited keys ("constructor" etc.) from passing
      // as saved profile names.
      if (!Object.hasOwn(globalConfig?.profiles ?? {}, profile)) {
        return writeFailure(command, profileNotFoundError(profile), mode, 1)
      }
    }

    let existing: Record<string, unknown> = {}
    if (localText !== null) {
      try {
        const raw: unknown = JSON.parse(localText)
        if (raw && typeof raw === 'object' && !Array.isArray(raw))
          existing = raw as Record<string, unknown>
      } catch {
        /* Preserve the existing malformed-config fallback. */
      }
    }
    const next = {
      ...existing,
      ...(profile ? { default_profile: profile } : {}),
      ...(projectId ? { default_project_id: projectId } : {}),
    }
    await boundary.directory(dirname(path))
    await boundary.atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
    boundary.keep(path)
    const gitExclude = await ensureGitExclude(process.cwd())
    const data = configData(next)
    delete data.read_path
    if (gitExclude.warning) {
      data.git_exclude_warning = gitExclude.warning
    }
    if (gitExclude.applied) {
      data.git_exclude_applied = true
    }
    await boundary.cleanup()
    return writeSuccess(command, data, mode)
  } catch (error) {
    let cleanupFailed = false
    try {
      await boundary.cleanup()
    } catch {
      cleanupFailed = true
    }
    const failure =
      error instanceof WriteBoundaryError
        ? error.error
        : validationError(
            `Could not save config at ${path}.`,
            'Check directory permissions and retry.',
          )
    if (cleanupFailed)
      failure.hint += ` Inspect temporary files in ${dirname(path)} before manual cleanup.`
    return writeFailure(command, failure, mode, 1)
  }
}

function configData(config: Record<string, unknown>): InitConfigData {
  return {
    mode: 'config',
    path: PROJECT_CONFIG_LOCAL_PATH,
    written: true,
    config: {
      default_profile: configString(config.default_profile),
      default_project_id: configString(config.default_project_id),
    },
  }
}
