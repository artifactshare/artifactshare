import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import type {
  PreviewAgentAdapter,
  PreviewAgentAdapterResult,
  PreviewBatchReadyEvent,
} from './notification.js'

const execFileAsync = promisify(execFile)
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i

export interface CodexQueueInvocation {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

export type CodexQueueRunner = (
  invocation: CodexQueueInvocation,
) => Promise<void>

function codexEnvironmentTarget(environment: NodeJS.ProcessEnv): {
  detected: boolean
  target: string | null
} {
  const thread = environment.CODEX_THREAD_ID?.trim() ?? ''
  const session = environment.CODEX_SESSION_ID?.trim() ?? ''
  if (thread === '' && session === '') return { detected: false, target: null }
  const target = UUID_PATTERN.test(thread)
    ? thread
    : UUID_PATTERN.test(session)
      ? session
      : ''
  return {
    detected: true,
    target: UUID_PATTERN.test(target) ? target : null,
  }
}

export function codexNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const detected = codexEnvironmentTarget(environment)
  if (!detected.detected) return null
  return {
    provider: 'codex',
    transport: 'codex_queue',
    capability: detected.target === null ? 'manual' : 'push',
    target: detected.target,
    registered_at: now().toISOString(),
  }
}

export function codexQueueMessage(event: PreviewBatchReadyEvent): string {
  return [
    'Artifact Share preview batch ready.',
    `event=${event.event}`,
    `preview_session_id=${event.preview_session_id}`,
    `batch_id=${event.batch_id}`,
    `Run: npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session ${event.preview_session_id} --json`,
  ].join(' ')
}

async function defaultQueueRunner(invocation: CodexQueueInvocation) {
  await execFileAsync(invocation.command, invocation.args, {
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: 10_000,
  })
}

export function codexQueueInvocation(
  target: string,
  event: PreviewBatchReadyEvent,
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = process.env.ComSpec || 'cmd.exe',
): CodexQueueInvocation | null {
  if (
    !UUID_PATTERN.test(target) ||
    !PREVIEW_SESSION_PATTERN.test(event.preview_session_id) ||
    !BATCH_ID_PATTERN.test(event.batch_id)
  ) {
    return null
  }
  const args = [
    'queue',
    '--thread',
    target,
    '--message',
    codexQueueMessage(event),
  ]
  if (platform !== 'win32') return { command: 'codex', args }
  return {
    command: commandInterpreter,
    windowsVerbatimArguments: true,
    args: [
      '/d',
      '/s',
      '/c',
      `codex queue --thread ${target} --message "${codexQueueMessage(event)}"`,
    ],
  }
}

function queueFailure(error: unknown): PreviewAgentAdapterResult {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  ) {
    return { status: 'failed', code: 'target_unavailable', retryable: false }
  }
  return { status: 'failed', code: 'rejected', retryable: false }
}

export function createCodexQueueAdapter(
  target: string,
  runQueue: CodexQueueRunner = defaultQueueRunner,
  platform: NodeJS.Platform = process.platform,
): PreviewAgentAdapter {
  if (!UUID_PATTERN.test(target)) {
    throw new Error('Codex queue target must be a UUID.')
  }
  return {
    async dispatch(event) {
      const invocation = codexQueueInvocation(target, event, platform)
      if (!invocation) {
        return {
          status: 'failed',
          code: 'invalid_response',
          retryable: false,
        }
      }
      try {
        await runQueue(invocation)
        return { status: 'accepted' }
      } catch (error) {
        return queueFailure(error)
      }
    },
  }
}
