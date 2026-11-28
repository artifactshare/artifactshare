import { SearchDailyLimitError } from '~/services/search-quota.server'
import { useT } from '~/hooks/use-t'
import { Button } from '~/components/ui/button'
import { SearchCapacityError } from '~/services/search-index/query'
import { requireUser } from '~/middleware/context'
import { parseSearchQuery } from '~/lib/search-query'
import { continueReturnedSearch } from '~/lib/search-view-state'
import { search } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import { data, type HeadersFunction } from 'react-router'
import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { SearchResults } from '~/components/app/search-results'
import type { Route } from './+types/search'

export const middleware = [searchNoStoreMiddleware]
export async function loader({ url, context }: Route.LoaderArgs) {
  const user = requireUser(context),
    input = parseSearchQuery(url.searchParams)
  if ('error' in input) return { result: input, actor: user.id }
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
export function clientLoader({
  request,
  serverLoader,
}: Route.ClientLoaderArgs) {
  return continueReturnedSearch(request, serverLoader)
}
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
