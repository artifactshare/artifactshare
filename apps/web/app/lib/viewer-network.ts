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
  options: { requireJson?: boolean } = {},
): Promise<{ response: Response; body: T | null }> {
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

  try {
    const response = await fetch(input, {
      ...init,
      signal: timeoutController.signal,
    })
    let body: T | null = null
    if (response.ok) {
      try {
        body = (await response.json()) as T
      } catch (error) {
        if (timedOut) throw new ViewerFetchTimeoutError()
        if (callerSignal?.aborted) throw new ViewerFetchAbortError()
        if (options.requireJson) throw new ViewerFetchInvalidJsonError()
        body = null
      }
    }
    return { response, body }
  } catch (error) {
    if (timedOut) throw new ViewerFetchTimeoutError()
    if (callerSignal?.aborted) throw new ViewerFetchAbortError()
    throw error
  } finally {
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

export function viewerFetchFailureReason(error: unknown): string {
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
