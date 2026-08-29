import type {
  PreviewAgentFailureCode,
  PreviewAgentNotificationProjection,
  PreviewAgentNotificationRegistration,
} from './contract.js'
import type { PreviewStore } from './store.js'

export interface PreviewBatchReadyEvent {
  event: 'preview.batch_ready'
  preview_session_id: string
  batch_id: string
}

export type PreviewAgentAdapterResult =
  | { status: 'accepted' }
  | {
      status: 'failed'
      code: PreviewAgentFailureCode
      retryable: boolean
    }

export interface PreviewAgentAdapter {
  dispatch(event: PreviewBatchReadyEvent): Promise<PreviewAgentAdapterResult>
}

export interface PreviewNotificationCoordinator {
  readonly registration: PreviewAgentNotificationRegistration
  projection(): PreviewAgentNotificationProjection
  setWaitConnected(connected: boolean): void
  notifyBatch(batchId: string): Promise<PreviewAgentAdapterResult | null>
}

const FAILURE_CODES = new Set<PreviewAgentFailureCode>([
  'target_unavailable',
  'rejected',
  'timeout',
  'invalid_response',
  'adapter_error',
])

export function defaultPreviewNotificationRegistration(): PreviewAgentNotificationRegistration {
  return {
    provider: 'generic',
    transport: 'long_poll',
    capability: 'wait',
    target: null,
    registered_at: new Date().toISOString(),
  }
}

export function samePreviewNotificationRegistration(
  left: PreviewAgentNotificationRegistration,
  right: PreviewAgentNotificationRegistration,
): boolean {
  return (
    left.provider === right.provider &&
    left.transport === right.transport &&
    left.capability === right.capability &&
    left.target === right.target
  )
}

export function isPreviewNotificationRegistration(
  value: unknown,
): value is PreviewAgentNotificationRegistration {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.provider === 'string' &&
    typeof record.transport === 'string' &&
    (record.capability === 'push' ||
      record.capability === 'wait' ||
      record.capability === 'manual') &&
    (record.target === null || typeof record.target === 'string') &&
    typeof record.registered_at === 'string'
  )
}

function normalizeResult(value: unknown): PreviewAgentAdapterResult {
  if (typeof value !== 'object' || value === null) {
    return { status: 'failed', code: 'invalid_response', retryable: false }
  }
  const record = value as Record<string, unknown>
  if (record.status === 'accepted') return { status: 'accepted' }
  if (
    record.status === 'failed' &&
    typeof record.code === 'string' &&
    FAILURE_CODES.has(record.code as PreviewAgentFailureCode) &&
    typeof record.retryable === 'boolean'
  ) {
    return {
      status: 'failed',
      code: record.code as PreviewAgentFailureCode,
      retryable: record.retryable,
    }
  }
  return { status: 'failed', code: 'invalid_response', retryable: false }
}

export function createPreviewNotificationCoordinator(options: {
  sessionId: string
  registration: PreviewAgentNotificationRegistration
  store: PreviewStore
  adapter?: PreviewAgentAdapter
  timeoutMs?: number
}): PreviewNotificationCoordinator {
  const { sessionId, registration, store } = options
  const timeoutMs = options.timeoutMs ?? 10_000
  let waitConnected = false
  const dispatches = new Map<
    string,
    Promise<PreviewAgentAdapterResult> | PreviewAgentAdapterResult
  >()

  store.recoverInterruptedBatch()

  function projection(): PreviewAgentNotificationProjection {
    const active = store.activeBatch()
    const latest = store.latestBatch()
    const state = active
      ? active.state
      : latest
        ? latest.state
        : registration.capability === 'push' ||
            (registration.capability === 'wait' && waitConnected)
          ? 'waiting'
          : 'manual_required'
    return {
      provider: registration.provider,
      transport: registration.transport,
      capability: registration.capability,
      state,
      ...(active?.failure_code ? { failure_code: active.failure_code } : {}),
    }
  }

  async function runDispatch(
    batchId: string,
  ): Promise<PreviewAgentAdapterResult> {
    store.markDispatchStarted(batchId)
    if (!options.adapter) {
      const result: PreviewAgentAdapterResult = {
        status: 'failed',
        code: 'target_unavailable',
        retryable: true,
      }
      store.markDispatchFailed(batchId, result.code, result.retryable)
      return result
    }
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<PreviewAgentAdapterResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'failed', code: 'timeout', retryable: true }),
          timeoutMs,
        )
      })
      const result = normalizeResult(
        await Promise.race([
          options.adapter.dispatch({
            event: 'preview.batch_ready',
            preview_session_id: sessionId,
            batch_id: batchId,
          }),
          timeout,
        ]),
      )
      if (result.status === 'accepted') store.markDispatchAccepted(batchId)
      else store.markDispatchFailed(batchId, result.code, result.retryable)
      return result
    } catch {
      const result: PreviewAgentAdapterResult = {
        status: 'failed',
        code: 'adapter_error',
        retryable: true,
      }
      store.markDispatchFailed(batchId, result.code, result.retryable)
      return result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    registration,
    projection,
    setWaitConnected(connected) {
      waitConnected = connected
    },
    async notifyBatch(batchId) {
      if (registration.capability !== 'push') {
        if (registration.capability === 'manual' || !waitConnected) {
          store.markManualRequired(batchId)
        }
        return null
      }
      const key = `${sessionId}:${batchId}`
      const existing = dispatches.get(key)
      if (existing) return await existing
      const pending = runDispatch(batchId)
      dispatches.set(key, pending)
      const result = await pending
      dispatches.set(key, result)
      return result
    },
  }
}
