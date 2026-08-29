import type { PreviewAgentNotificationRegistration } from './contract.js'
import type { PreviewAgentAdapter } from './notification.js'
import { processAlive } from './session.js'

const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export const CURSOR_ACP_ACK_TIMEOUT_MS = 60_000
export const CURSOR_ACP_FETCH_TIMEOUT_MS = 65_000
export const CURSOR_ACP_NOTIFICATION_TIMEOUT_MS = 70_000

export interface CursorAcpTarget {
  schema_version: 1
  endpoint: string
  token: string
  pid: number
  session_id: string
  cwd: string
}

export function isCursorAcpTarget(value: unknown): value is CursorAcpTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  if (
    target.schema_version !== 1 ||
    typeof target.endpoint !== 'string' ||
    typeof target.token !== 'string' ||
    !TOKEN_PATTERN.test(target.token) ||
    typeof target.pid !== 'number' ||
    !Number.isSafeInteger(target.pid) ||
    typeof target.session_id !== 'string' ||
    target.session_id.length === 0 ||
    typeof target.cwd !== 'string' ||
    target.cwd.length === 0
  )
    return false
  try {
    const url = new URL(target.endpoint)
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

function manual(now: () => Date): PreviewAgentNotificationRegistration {
  return {
    provider: 'cursor',
    transport: 'manual',
    capability: 'manual',
    target: null,
    registered_at: now().toISOString(),
  }
}

export function cursorNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const encoded = environment.ARTIFACTSHARE_CURSOR_ACP_TARGET?.trim()
  if (encoded) {
    try {
      const target: unknown = JSON.parse(encoded)
      if (isCursorAcpTarget(target) && processAlive(target.pid)) {
        return {
          provider: 'cursor',
          transport: 'acp_managed',
          capability: 'push',
          target: encoded,
          registered_at: now().toISOString(),
        }
      }
    } catch {
      /* malformed trusted-local context becomes manual */
    }
    return manual(now)
  }
  if (!environment.CURSOR_AGENT) return null
  if (environment.ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT === '1') {
    return {
      provider: 'cursor',
      transport: 'foreground_wait',
      capability: 'wait',
      target: null,
      registered_at: now().toISOString(),
    }
  }
  return manual(now)
}

export function createCursorAcpAdapter(
  encoded: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): PreviewAgentAdapter {
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error('Cursor ACP target must be valid JSON.')
  }
  if (!isCursorAcpTarget(value))
    throw new Error('Cursor ACP target must be valid.')
  const target = value
  return {
    fallbackIfUnavailable() {
      return processAlive(target.pid) ? null : manual(() => new Date())
    },
    async dispatch(event) {
      if (
        !PREVIEW_SESSION_PATTERN.test(event.preview_session_id) ||
        !BATCH_ID_PATTERN.test(event.batch_id)
      ) {
        return { status: 'failed', code: 'invalid_response', retryable: false }
      }
      try {
        const response = await fetchImpl(target.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${target.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(event),
          // The bridge always ends or tears down the ACP prompt before this
          // request can time out, so a failed dispatch cannot keep running in
          // Cursor while the UI recommends manual recovery.
          signal: AbortSignal.timeout(CURSOR_ACP_FETCH_TIMEOUT_MS),
        })
        if (response.status === 202) return { status: 'accepted' }
        if (response.status === 409)
          return { status: 'failed', code: 'rejected', retryable: true }
        return {
          status: 'failed',
          code:
            response.status === 404 || response.status === 503
              ? 'target_unavailable'
              : 'rejected',
          retryable: true,
        }
      } catch (error) {
        const timeout =
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        return {
          status: 'failed',
          code: timeout ? 'timeout' : 'target_unavailable',
          retryable: true,
        }
      }
    },
  }
}
