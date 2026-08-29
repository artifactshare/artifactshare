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

export interface CodexQueueInvocation {
  command: string
  args: string[]
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
  if (thread !== '' && session !== '' && thread !== session) {
    return { detected: true, target: null }
  }
  const target = thread || session
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
    `Run: npx --yes @artifactshare/cli preview next --session ${event.preview_session_id} --json`,
  ].join('\n')
}

async function defaultQueueRunner(
  invocation: CodexQueueInvocation,
): Promise<void> {
  await execFileAsync(invocation.command, invocation.args, {
    windowsHide: true,
    timeout: 10_000,
  })
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
): PreviewAgentAdapter {
  if (!UUID_PATTERN.test(target)) {
    throw new Error('Codex queue target must be a UUID.')
  }
  return {
    async dispatch(event) {
      try {
        await runQueue({
          command: 'codex',
          args: [
            'queue',
            '--thread',
            target,
            '--message',
            codexQueueMessage(event),
          ],
        })
        return { status: 'accepted' }
      } catch (error) {
        return queueFailure(error)
      }
    },
  }
}
