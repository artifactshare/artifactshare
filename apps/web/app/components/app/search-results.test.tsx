import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test } from 'vitest'
import { SearchResults, type SearchResponse } from './search-results'

const result: Exclude<SearchResponse, { error: unknown }> = {
  items: [],
  total: { value: 0, relation: 'eq' },
  tier: 'all',
  relaxations: [],
  nextCursor: null,
  searchLogId: 'search',
  facets: { owners: [], projects: [] },
}

test('exact, capped and incomplete totals never turn lower bounds into exact zero or exhaustion', () => {
  for (const [total, cap, zero] of [
    [{ value: 0, relation: 'eq' }, false, true],
    [{ value: 0, relation: 'gte' }, false, false],
    [{ value: 1000, relation: 'eq' }, false, false],
    [{ value: 1000, relation: 'gte' }, true, false],
  ] as const) {
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <SearchResults result={{ ...result, total }} actor="viewer" />
          ),
        },
      ],
      { initialEntries: ['/search?q=alpha'] },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)
    expect(html.includes('Up to 1,000 results')).toBe(cap)
    expect(html.includes('No matches for')).toBe(zero)
    if (total.relation === 'gte')
      expect(html).toContain(`${total.value.toLocaleString('en')}+`)
  }
})

test('owner-only results name the owner, default to newest and omit excerpts', () => {
  const ownerResult: Exclude<SearchResponse, { error: unknown }> = {
    ...result,
    total: { value: 1, relation: 'eq' },
    facets: { owners: [{ id: 'owner', name: 'Alex', count: 1 }], projects: [] },
    items: [
      {
        id: 'file',
        title: 'Planning',
        ownerId: 'owner',
        ownerName: 'Alex',
        project: null,
        visibility: 'private',
        updatedAt: '2026-09-15T00:00:00Z',
        lastViewedAt: null,
        path: 'index.html',
        excerpt: 'Excerpt must not render for an owner-only search',
        artifactKind: 'html_page',
        hasBody: true,
        matchedKeywords: [],
        tier: 'all',
        rank: 1,
        groupSize: 1,
        groupSizeRelation: 'eq',
        receipt: 'receipt',
      },
    ],
  }
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: <SearchResults result={ownerResult} actor="viewer" />,
      },
    ],
    { initialEntries: ['/search?owner=owner'] },
  )
  const html = renderToStaticMarkup(<RouterProvider router={router} />)
  expect(html).toContain('Files owned by Alex')
  expect(html).toContain('Newest')
  expect(html).not.toContain('<select')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('name="q"')
  expect(html).not.toContain('Excerpt must not render')
})

test('zero results describe selected owners, project and period with neutral unresolved names', () => {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <SearchResults
            result={{
              ...result,
              selectedScope: {
                owners: [{ id: 'alex', name: 'Alex' }],
                projects: [{ id: 'launch', name: 'Launch review' }],
              },
            }}
            actor="viewer"
          />
        ),
      },
    ],
    {
      initialEntries: [
        '/search?q=budget&owner=alex&owner=unavailable&project=launch&period=7&dateField=viewed',
      ],
    },
  )
  const html = renderToStaticMarkup(<RouterProvider router={router} />)
  expect(html).toContain('budget')
  expect(html).toContain('Owner: Alex, Unavailable selection')
  expect(html).toContain('Project: Launch review')
  expect(html).toContain('Last viewed by me: Past 7 days')
})

test.each([
  ['alpha', 'No files contained all keywords in &quot;alpha&quot;.'],
  [
    'alpha+beta',
    'No files contained all keywords in &quot;alpha&quot;, &quot;beta&quot;.',
  ],
])(
  'any-word explanation uses plain English quotes for %s',
  (query, explanation) => {
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <SearchResults result={{ ...result, tier: 'any' }} actor="viewer" />
          ),
        },
      ],
      { initialEntries: [`/search?q=${query}`] },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)
    expect(html).toContain(`<p>${explanation}</p>`)
  },
)

test.each([
  ['en', '', 'No matches for &quot;planning&quot;.'],
  ['ja', '', '『planning』は見つかりませんでした。'],
  [
    'en',
    '&period=7',
    'No matches for &quot;planning&quot; with these filters.',
  ],
  ['ja', '&period=7', 'この条件では『planning』は見つかりませんでした。'],
  [
    'en',
    '&includeArchived=false&sort=newest',
    'No matches for &quot;planning&quot;.',
  ],
] as const)(
  'empty search copy and recovery layout for %s %s',
  (locale, filters, title) => {
    const router = createMemoryRouter(
      [
        {
          id: 'root',
          path: '*',
          loader: () => ({ locale }),
          element: (
            <SearchResults
              result={{
                ...result,
                relaxations: filters.includes('period')
                  ? [{ filter: 'date', total: { value: 2, relation: 'eq' } }]
                  : [],
              }}
              actor="viewer"
            />
          ),
        },
      ],
      {
        initialEntries: [`/search?q=planning${filters}`],
        hydrationData: { loaderData: { root: { locale } } },
      },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)
    expect(html).toContain(title)
    expect(html).toMatch(/data-slot="empty-title"[^>]*>[^<]+<\/div>/)
    expect(html).toMatch(/data-slot="empty-icon" data-variant="icon"/)
    expect(html).toContain(
      locale === 'ja'
        ? '閲覧できるファイルのタイトルと本文を検索しました。'
        : 'We searched titles and contents of files you can access.',
    )
    const content = html.match(/data-slot="empty-content".*?<\/div>/)?.[0]
    expect(content).toContain(
      locale === 'ja'
        ? '別のキーワードで検索'
        : 'Search with different keywords',
    )
    if (filters.includes('period'))
      expect(content).toContain(
        locale === 'ja'
          ? '>期間の絞り込みを解除(すべて含むファイルが 2件あります)</button>'
          : '>Remove Period filter (2 results contain all keywords)</button>',
      )
  },
)
