import { SearchDailyLimitError } from './search-quota.server'
import { SearchCapacityError } from './search-index/query'
import type { MiddlewareFunction } from 'react-router'

/** Also cover errors thrown by cookie authentication before the loader runs. */
export const searchNoStoreMiddleware: MiddlewareFunction<Response> = async (
  _args,
  next,
) => {
  try {
    const response = await next()
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    if (error instanceof SearchDailyLimitError)
      return Response.json(
        { error: error.error },
        { status: 429, headers: error.headers },
      )
    if (error instanceof SearchCapacityError)
      return Response.json(
        { error: { code: 'search_capacity_exceeded' } },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
      )
    if (error instanceof Response)
      error.headers.set('Cache-Control', 'private, no-store')
    throw error
  }
}
