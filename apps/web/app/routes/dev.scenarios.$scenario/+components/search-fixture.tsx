import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import {
  SearchResults,
  type SearchResponse,
} from '~/components/app/search-results'
import { Topbar } from '~/routes/_home/+components/topbar'
import { listMainClassName } from '~/components/app/page-shell-styles'

export function SearchFixture({
  state = 'results',
}: {
  state?:
    | 'results'
    | 'empty'
    | 'any'
    | 'capped'
    | 'error'
    | 'continuation-error'
    | 'group-expanded'
}) {
  const [params, setParams] = useSearchParams()
  const query = params.get('q')
  useEffect(() => {
    if (query === null)
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('q', state === 'any' ? 'planning forecast' : 'planning')
          return next
        },
        { replace: true },
      )
  }, [query, setParams, state])
  const result: SearchResponse = {
    items:
      state === 'empty'
        ? []
        : [
            {
              id: 'fixture-report',
              title: 'Quarterly planning report',
              ownerId: 'fixture-owner',
              ownerName: 'Alex Morgan',
              project: { id: 'fixture-project', name: 'Launch review' },
              visibility: 'workspace',
              updatedAt: '2026-09-15T12:00:00.000Z',
              lastViewedAt: '2026-09-16T12:00:00.000Z',
              path: 'index.html',
              excerpt:
                'The planning report collects decisions and follow-up work for the next release.',
              hasBody: true,
              matchedKeywords: ['planning'],
              tier: state === 'any' ? 'any' : 'all',
              rank: 1,
              groupSize: state === 'group-expanded' ? 2 : 1,
              groupSizeRelation: 'eq',
              receipt: 'fixture-receipt',
            },
          ],
    total: {
      value: state === 'empty' ? 0 : state === 'capped' ? 1000 : 1,
      relation: state === 'capped' ? 'gte' : 'eq',
    },
    tier: state === 'any' ? 'any' : 'all',
    relaxations: [],
    nextCursor: state === 'continuation-error' ? 'fixture-next' : null,
    searchLogId: 'fixture-search',
    facets: {
      owners: [
        {
          id: 'fixture-owner',
          name: 'Alex Morgan',
          ...(state === 'capped' ? {} : { count: 1 }),
        },
      ],
      projects: [
        {
          id: 'fixture-project',
          name: 'Launch review',
          ...(state === 'capped' ? {} : { count: 1 }),
        },
      ],
    },
  }
  return (
    <>
      <div data-regression-region="header">
        <Topbar
          searchResults
          workspaceName="Example workspace"
          user={{
            id: 'fixture-user',
            name: 'Taylor',
            email: 'viewer@example.com',
            image: null,
            initial: 'T',
          }}
        />
      </div>
      <main data-regression-region="main" className={listMainClassName}>
        <SearchResults
          result={
            state === 'error'
              ? { error: { code: 'search_capacity_exceeded', hint: '' } }
              : result
          }
          actor="fixture-user"
        />
      </main>
    </>
  )
}
