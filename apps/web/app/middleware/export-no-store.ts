import type { MiddlewareFunction } from 'react-router'

/** Runs outside the export auth guard so even a rejected session is not cached. */
export const exportNoStoreMiddleware: MiddlewareFunction = async (
  _args,
  next,
) => {
  try {
    const response = await next()
    if (response instanceof Response)
      response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) {
    if (error instanceof Response)
      error.headers.set('cache-control', 'no-store')
    throw error
  }
}
