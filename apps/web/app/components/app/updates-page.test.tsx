import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { UpdatesDetailPage, UpdatesListPage } from './updates-page'

const currentLocale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode
    to: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/updates', search: '', hash: '' }),
  useFetcher: () => ({ formData: undefined, submit: vi.fn() }),
  useRouteLoaderData: () => ({ appTheme: 'system' }),
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: currentLocale.value,
    t: (key: string) => {
      if (key === 'updates.details') {
        return currentLocale.value === 'ja' ? '詳細を見る' : 'View details'
      }
      return key
    },
  }),
}))

const baseEntry = {
  slug: 'structured-details',
  title: 'Structured details',
  date: '2026-07-13',
  products: ['cli'] as const,
  kind: 'new' as const,
  summaryHtml: '<p>Summary</p>',
  hasMore: false,
}

describe('Updates details links', () => {
  beforeEach(() => {
    currentLocale.value = 'en'
  })

  test('renders the resolved link in the list and omits it when absent', () => {
    const html = renderToStaticMarkup(
      <UpdatesListPage
        locale="en"
        entries={[
          {
            ...baseEntry,
            products: [...baseEntry.products],
            detailsHref: '/guides/cli',
          },
          {
            ...baseEntry,
            slug: 'without-details',
            products: [...baseEntry.products],
          },
        ]}
      />,
    )

    expect(html).toContain('href="/guides/cli"')
    expect(html).toContain('data-slot="public-footer"')
    expect(html.match(/View details/g)).toHaveLength(1)
  })

  test('renders the Japanese resolved link on the detail page', () => {
    currentLocale.value = 'ja'
    const html = renderToStaticMarkup(
      <UpdatesDetailPage
        locale="ja"
        entry={{
          ...baseEntry,
          products: [...baseEntry.products],
          bodyHtml: '<p>本文</p>',
          detailsHref: '/ja/guides/cli',
        }}
      />,
    )

    expect(html).toContain('href="/ja/guides/cli"')
    expect(html).toContain('data-slot="public-footer"')
    expect(html).toContain('詳細を見る')
  })
})
