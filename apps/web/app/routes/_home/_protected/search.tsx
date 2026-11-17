import { useT } from '~/hooks/use-t'
import { Button } from '~/components/ui/button'
import { SearchCapacityError } from '~/services/search-index/query'
import { requireUser } from '~/middleware/context'
import { parseSearchQuery } from '~/lib/search-query'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import { search } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import { data, type HeadersFunction } from 'react-router'
import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { SearchResults } from '~/components/app/search-results'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/search'

export const screen = {
  id: 'search',
  route: { en: '/search' },
  auth: 'free-owner',
  loop: 'view',
  metric: 'Find accessible files',
  role: 'Full-text search',
  primaryAction: 'Open a file',
  states: [
    {
      id: 'loading',
      description:
        'Header suggestions pending (deterministic capture: search-loading component scenario)',
      setup: {
        scenario: 'search/results',
        query: '?q=Quarterly',
        interactions: [
          { action: 'click', selector: 'header [data-search-trigger]' },
        ],
      },
    },
    {
      id: 'error',
      description: 'Search request failure',
      setup: { scenario: 'search/error', query: '?q=Quarterly' },
    },
    {
      id: 'continuation-error',
      description: 'Retained rows after a failed continuation',
      setup: {
        scenario: 'search/continuation-error',
        query: '?q=Quarterly',
        // The next page loads when the list end is visible, so the failure
        // appears without a click.
        ready: {
          selector: 'main [role="alert"]',
          description: 'Continuation failure',
        },
      },
    },

    {
      id: 'default',
      description: 'Authorized search results',
      setup: { scenario: 'search/results', query: '?q=Quarterly' },
    },
    {
      id: 'empty',
      description: 'No matching files',
      setup: { scenario: 'search/empty', query: '?q=unfindablekeyword' },
    },
    {
      id: 'any',
      description: 'Any-word fallback',
      setup: {
        scenario: 'search/any',
        query: '?q=Quarterly+unfindablekeyword',
      },
    },
    {
      id: 'capped',
      description: 'Lower-bound count presentation fixture',
      setup: { scenario: 'search/capped', query: '?q=Quarterly' },
    },
    {
      id: 'mobile-search',
      description: 'Header search dialog',
      setup: {
        scenario: 'search/results',
        query: '?q=Quarterly',
        interactions: [
          { action: 'click', selector: 'header [data-search-trigger]' },
        ],
      },
    },
    {
      id: 'filters',
      description:
        'Owner filter menu (desktop) and bottom filter sheet (mobile)',
      setup: {
        scenario: 'search/results',
        query: '?q=Quarterly',
        interactions: [
          {
            action: 'click',
            selector:
              'button[data-search-filters]:visible, button[data-search-menu="owner"]:visible',
          },
        ],
      },
    },
    {
      id: 'group-expanded',
      description: 'Same-title files',
      setup: {
        scenario: 'search/results',
        query: '?q=Archived',
        interactions: [
          { action: 'click', selector: 'button[data-search-group]' },
        ],
      },
    },
  ],
} satisfies ScreenSpec
export const middleware = [searchNoStoreMiddleware]
export async function loader({ url, context, request }: Route.LoaderArgs) {
  const user = requireUser(context),
    input = parseSearchQuery(url.searchParams)
  if ('error' in input) return { result: input, actor: user.id }
  if (isDevScreenStateRequest(request, 'search/error'))
    return {
      result: { error: { code: 'search_capacity_exceeded', hint: '' } },
      actor: user.id,
    }
  const { value: result, serverTiming } = await withSearchTiming(
    'search',
    (db, indexes) => search(db, indexes, user.id, input, 'screen'),
  ).catch((error: unknown) => {
    if (error instanceof SearchCapacityError)
      return {
        value: {
          error: {
            code: 'search_capacity_exceeded',
            hint: 'Narrow the query.',
          },
        },
        serverTiming: undefined,
      }
    throw error
  })
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
      headers: serverTiming ? { 'Server-Timing': serverTiming } : undefined,
    },
  )
}
// Only the search breakdown passes through; parent headers stay as they are.
export const headers: HeadersFunction = ({ parentHeaders, loaderHeaders }) => {
  const responseHeaders = new Headers(parentHeaders)
  const timing = loaderHeaders.get('Server-Timing')
  if (timing) responseHeaders.append('Server-Timing', timing)
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
