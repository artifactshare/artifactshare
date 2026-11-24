import { SearchDailyLimitError } from '~/services/search-quota.server'
import { useT } from '~/hooks/use-t'
import { Button } from '~/components/ui/button'
import { SearchCapacityError } from '~/services/search-index/query'
import { requireUser } from '~/middleware/context'
import { parseSearchQuery } from '~/lib/search-query'
import { continueReturnedSearch } from '~/lib/search-view-state'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import { search } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import { data, type HeadersFunction } from 'react-router'
import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { SearchResults } from '~/components/app/search-results'
import type { Route } from './+types/search'

export const middleware = [searchNoStoreMiddleware]
export async function loader({ url, context, request }: Route.LoaderArgs) {
  const user = requireUser(context),
    input = parseSearchQuery(url.searchParams)
  if ('error' in input) return { result: input, actor: user.id }
  if (isDevScreenStateRequest(request, 'search/daily-limit')) {
    const limit = new SearchDailyLimitError('2026-11-20T12:00:00.000Z')
    return data(
      { result: { error: limit.error }, actor: user.id },
      { status: 429, headers: limit.headers },
    )
  }
  if (isDevScreenStateRequest(request, 'search/error'))
    return {
      result: { error: { code: 'search_capacity_exceeded', hint: '' } },
      actor: user.id,
    }
  const { value: result, serverTiming } = await withSearchTiming(
    'search',
    (db, indexes) => search(db, indexes, user.id, input, 'screen'),
    (error) =>
      error instanceof SearchDailyLimitError
        ? { error: error.error }
        : error instanceof SearchCapacityError
          ? {
              error: {
                code: 'search_capacity_exceeded',
                hint: 'Narrow the query.',
              },
            }
          : undefined,
  )
  if (
    !('error' in result) &&
    isDevScreenStateRequest(request, 'search/capped')
  ) {
    return {
      result: {
        ...result,
        total: { value: 1000, relation: 'gte' as const },
        facets: undefined,
      },
      actor: user.id,
    }
  }
  if (
    !('error' in result) &&
    isDevScreenStateRequest(request, 'search/continuation-error')
  )
    return {
      result: { ...result, nextCursor: 'invalid-fixture-cursor' },
      actor: user.id,
    }
  return data(
    { result, actor: user.id },
    {
      status:
        'error' in result && result.error.code === 'search_daily_limit_exceeded'
          ? 429
          : 200,
      headers: {
        ...('error' in result && 'details' in result.error
          ? { 'Retry-After': String(result.error.details.retry_after_seconds) }
          : {}),
        'Cache-Control': 'private, no-store',
        'Server-Timing': serverTiming,
      },
    },
  )
}
/** Going Back to search results continues that search; see continueReturnedSearch. */
export function clientLoader({
  request,
  serverLoader,
}: Route.ClientLoaderArgs) {
  return continueReturnedSearch(request, serverLoader)
}
// Only the search breakdown passes through; parent headers stay as they are.
export const headers: HeadersFunction = ({ parentHeaders, loaderHeaders }) => {
  const responseHeaders = new Headers(parentHeaders)
  const timing = loaderHeaders.get('Server-Timing')
  if (timing) responseHeaders.append('Server-Timing', timing)
  for (const key of ['Cache-Control', 'Retry-After']) {
    const value = loaderHeaders.get(key)
    if (value) responseHeaders.set(key, value)
  }
  return responseHeaders
}
export default function SearchPage({ loaderData }: Route.ComponentProps) {
  return <SearchResults {...loaderData} />
}

export function ErrorBoundary() {
  const { t } = useT()
  return (
    <div role="alert">
      <p>{t('search.failure')}</p>
      <Button onClick={() => window.location.reload()}>
        {t('search.retry')}
      </Button>
    </div>
  )
}
