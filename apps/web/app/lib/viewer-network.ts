import type { CommentSyncAssignment } from './comment-sync'

export type CommentNetworkDiagnostic = {
  assignment: CommentSyncAssignment
  operation:
    | 'summary'
    | 'page'
    | 'selected'
    | 'recovery'
    | 'create-thread'
    | 'reply'
    | 'resolve'
    | 'reopen'
    | 'update-message'
    | 'delete-message'
    | 'delete-thread'
    | 'socket'
}

export const VIEWER_FETCH_TIMEOUT_MS = 15_000

class ViewerFetchTimeoutError extends Error {
  constructor() {
    super('Viewer fetch timed out')
    this.name = 'ViewerFetchTimeoutError'
  }
}

class ViewerFetchAbortError extends Error {
  constructor() {
    super('Viewer fetch was aborted')
    this.name = 'ViewerFetchAbortError'
  }
}

class ViewerFetchInvalidJsonError extends Error {
  constructor() {
    super('Viewer fetch returned invalid JSON')
    this.name = 'ViewerFetchInvalidJsonError'
  }
}

export async function fetchJsonWithViewerTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: {
    requireJson?: boolean
    parseErrorJson?: boolean
    commentDiagnostic?: CommentNetworkDiagnostic
  } = {},
): Promise<{ response: Response; body: T | null }> {
  let result: CommentNetworkResult = 'abort'
  let status: number | undefined
  const timeoutController = new AbortController()
  const callerSignal = init.signal
  let timedOut = false

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, VIEWER_FETCH_TIMEOUT_MS)

  const abortFromCaller = () => timeoutController.abort()
  if (callerSignal) {
    if (callerSignal.aborted) {
      globalThis.clearTimeout(timeoutId)
      throw new ViewerFetchAbortError()
    }
    callerSignal.addEventListener('abort', abortFromCaller, { once: true })
  }

  const finishDiagnostic = options.commentDiagnostic
    ? startCommentNetworkOperation(options.commentDiagnostic)
    : undefined
  try {
    const response = await fetch(input, {
      ...init,
      signal: timeoutController.signal,
    })
    let body: T | null = null
    if (response.ok || options.parseErrorJson) {
      try {
        body = (await response.json()) as T
      } catch (error) {
        if (timedOut) throw new ViewerFetchTimeoutError()
        if (callerSignal?.aborted) throw new ViewerFetchAbortError()
        if (response.ok && options.requireJson)
          throw new ViewerFetchInvalidJsonError()
        body = null
      }
    }
    status = response.status
    result = callerSignal?.aborted
      ? 'abort'
      : response.ok
        ? body === null
          ? 'invalid-json'
          : 'success'
        : 'http-error'
    return { response, body }
  } catch (error) {
    result = timedOut
      ? 'timeout'
      : callerSignal?.aborted
        ? 'abort'
        : viewerFetchFailureReason(error)
    if (timedOut) throw new ViewerFetchTimeoutError()
    if (callerSignal?.aborted) throw new ViewerFetchAbortError()
    throw error
  } finally {
    finishDiagnostic?.(result, status)
    globalThis.clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

export function isViewerFetchAbort(error: unknown): boolean {
  return error instanceof ViewerFetchAbortError
}

export function isViewerFetchTimeout(error: unknown): boolean {
  return error instanceof ViewerFetchTimeoutError
}

export function viewerFetchFailureReason(error: unknown): CommentNetworkResult {
  if (error instanceof ViewerFetchTimeoutError) return 'timeout'
  if (error instanceof ViewerFetchAbortError) return 'abort'
  if (error instanceof ViewerFetchInvalidJsonError) return 'invalid-json'
  return 'network-error'
}

export function logViewerNetworkEvent(
  event: Record<string, string | number | boolean | null | undefined>,
): void {
  console.info('artifactshare_viewer_network', stripUndefined(event))
}

export function cfRayFrom(response: Response): string | null {
  return response.headers.get('cf-ray')
}

function stripUndefined(
  event: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(event).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] !== undefined,
    ),
  )
}

export type CommentNetworkResult =
  | 'success'
  | 'http-error'
  | 'timeout'
  | 'abort'
  | 'invalid-json'
  | 'network-error'

/** One start and one terminal event per attempt, without URLs, IDs or content.
 * The caller captures the committed owner's assignment before beginning work. */
export function startCommentNetworkOperation(
  diagnostic: CommentNetworkDiagnostic,
) {
  const started = performance.now()
  const fields = {
    channel: 'comment-sync',
    mode: diagnostic.assignment.mode,
    build: diagnostic.assignment.build,
    operation: diagnostic.operation,
  }
  logViewerNetworkEvent({
    ...fields,
    state: 'started',
    result: 'pending',
    elapsedMs: 0,
    fetchCount: diagnostic.operation === 'socket' ? 0 : 1,
    socketCount: diagnostic.operation === 'socket' ? 1 : 0,
  })
  let completed = false
  return (result: CommentNetworkResult, status?: number) => {
    if (completed) return
    completed = true
    logViewerNetworkEvent({
      ...fields,
      state: 'completed',
      result,
      status,
      elapsedMs: Math.round(performance.now() - started),
      fetchCount: 0,
      socketCount: 0,
    })
  }
}
