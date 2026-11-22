import {
  data,
  isRouteErrorResponse,
  type MiddlewareFunction,
} from 'react-router'

export async function confirmationResult<T>(
  intent: string,
  submit: () => Promise<T>,
) {
  try {
    return await submit()
  } catch (error) {
    const retryable = isRouteErrorResponse(error)
      ? [502, 503, 504].includes(error.status)
      : error instanceof TypeError ||
        (error instanceof Error &&
          error.message === 'Unable to decode turbo-stream response' &&
          'cause' in error)
    if (!retryable) throw error
    return data(
      { ok: false as const, code: 'submission-interrupted' as const, intent },
      { status: 409 },
    )
  }
}

// Single Fetch reconstructs a development exception by name in the browser.
// Keep server TypeErrors distinguishable from a rejected browser fetch.
export async function runConfirmedMutation<T>(mutate: () => Promise<T> | T) {
  try {
    return await mutate()
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(error.message, { cause: error })
    throw error
  }
}

export type ServerMiddleware<T> = (
  ...args: Parameters<MiddlewareFunction<Response>>
) => T | Promise<T>

// Middleware runs before a route action can normalize its own error.
export function settingsSubmissionMiddleware<T>(
  middleware: ServerMiddleware<T>,
): ServerMiddleware<T> {
  return (args, next) => {
    const { request, url } = args
    // Every spelling the router accepts for a Settings page, including a
    // trailing slash and its Single Fetch data URL.
    if (
      request.method !== 'POST' ||
      !/^\/settings(?:[/.]|$)/.test(url.pathname)
    )
      return middleware(args, next)
    return runConfirmedMutation<T>(() => middleware(args, next))
  }
}
