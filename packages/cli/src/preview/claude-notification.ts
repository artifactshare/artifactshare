import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import type {
  PreviewAgentAdapter,
  PreviewAgentAdapterResult,
  PreviewBatchReadyEvent,
} from './notification.js'
import { previewsDir, processAlive } from './session.js'

const CLAUDE_SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export interface ClaudeChannelRecord {
  schema_version: 1
  claude_session_id: string
  endpoint: string
  token: string
  pid: number
  acknowledged_at: string
}

function channelDirectory(env: NodeJS.ProcessEnv): string {
  return join(previewsDir(env), 'claude-channels')
}

function channelKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

export function claudeChannelRecordPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!CLAUDE_SESSION_PATTERN.test(sessionId)) {
    throw new Error('invalid Claude session id')
  }
  return join(channelDirectory(env), `${channelKey(sessionId)}.json`)
}

function isClaudeChannelRecord(value: unknown): value is ClaudeChannelRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (
    record.schema_version !== 1 ||
    typeof record.claude_session_id !== 'string' ||
    !CLAUDE_SESSION_PATTERN.test(record.claude_session_id) ||
    typeof record.endpoint !== 'string' ||
    typeof record.token !== 'string' ||
    !TOKEN_PATTERN.test(record.token) ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.acknowledged_at !== 'string'
  ) {
    return false
  }
  try {
    const url = new URL(record.endpoint)
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/preview-batch' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export function writeClaudeChannelRecord(
  record: ClaudeChannelRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isClaudeChannelRecord(record)) {
    throw new Error('invalid Claude channel record')
  }
  const dir = channelDirectory(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = claudeChannelRecordPath(record.claude_session_id, env)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

export function readClaudeChannelRecord(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeChannelRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      readFileSync(claudeChannelRecordPath(sessionId, env), 'utf8'),
    )
  } catch {
    return null
  }
  if (!isClaudeChannelRecord(parsed)) return null
  if (parsed.claude_session_id !== sessionId || !processAlive(parsed.pid)) {
    removeClaudeChannelRecord(sessionId, env)
    return null
  }
  return parsed
}

export function removeClaudeChannelRecord(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    rmSync(claudeChannelRecordPath(sessionId, env), { force: true })
  } catch {
    // An invalid or concurrently removed local record is already unavailable.
  }
}

function backgroundAvailable(environment: NodeJS.ProcessEnv): boolean {
  const disabled =
    environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS?.trim().toLowerCase()
  return disabled !== '1' && disabled !== 'true'
}

function fallbackRegistration(
  environment: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration {
  const available = backgroundAvailable(environment)
  return {
    provider: 'claude_code',
    transport: available ? 'background_wait' : 'manual',
    capability: available ? 'wait' : 'manual',
    target: null,
    registered_at: now().toISOString(),
  }
}

export function claudeNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const sessionId = environment.CLAUDE_CODE_SESSION_ID?.trim() ?? ''
  if (sessionId === '') return null
  if (!CLAUDE_SESSION_PATTERN.test(sessionId)) {
    return {
      provider: 'claude_code',
      transport: 'manual',
      capability: 'manual',
      target: null,
      registered_at: now().toISOString(),
    }
  }
  const channel = readClaudeChannelRecord(sessionId, environment)
  if (channel) {
    return {
      provider: 'claude_code',
      transport: 'channel',
      capability: 'push',
      target: JSON.stringify(channel),
      registered_at: now().toISOString(),
    }
  }
  return fallbackRegistration(environment, now)
}

function failed(
  code: 'target_unavailable' | 'rejected' | 'timeout',
  retryable: boolean,
  environment: NodeJS.ProcessEnv,
): PreviewAgentAdapterResult {
  return {
    status: 'failed',
    code,
    retryable,
    fallback: fallbackRegistration(environment),
  }
}

export function createClaudeChannelAdapter(
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): PreviewAgentAdapter {
  let channel: unknown
  try {
    channel = JSON.parse(target)
  } catch {
    throw new Error('Claude channel target must be a valid record.')
  }
  if (!isClaudeChannelRecord(channel)) {
    throw new Error('Claude channel target must be a valid record.')
  }
  return {
    fallbackIfUnavailable() {
      const current = readClaudeChannelRecord(
        channel.claude_session_id,
        environment,
      )
      return current &&
        current.pid === channel.pid &&
        current.endpoint === channel.endpoint &&
        current.token === channel.token
        ? null
        : fallbackRegistration(environment)
    },
    async dispatch(event: PreviewBatchReadyEvent) {
      if (
        !PREVIEW_SESSION_PATTERN.test(event.preview_session_id) ||
        !BATCH_ID_PATTERN.test(event.batch_id)
      ) {
        return {
          status: 'failed',
          code: 'invalid_response',
          retryable: false,
        }
      }
      const challenge = randomUUID()
      try {
        const response = await fetchImpl(channel.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${channel.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            event: event.event,
            preview_session_id: event.preview_session_id,
            batch_id: event.batch_id,
            challenge,
          }),
          signal: AbortSignal.timeout(25_000),
        })
        if (!response.ok) {
          removeClaudeChannelRecord(channel.claude_session_id, environment)
          return failed('rejected', true, environment)
        }
        const body = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        if (body?.acknowledged !== true || body.challenge !== challenge) {
          removeClaudeChannelRecord(channel.claude_session_id, environment)
          return failed('rejected', true, environment)
        }
        return { status: 'accepted' }
      } catch (error) {
        removeClaudeChannelRecord(channel.claude_session_id, environment)
        const timeout =
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        return failed(
          timeout ? 'timeout' : 'target_unavailable',
          true,
          environment,
        )
      }
    },
  }
}
