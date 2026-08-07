import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Pager } from './pager'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, number>) =>
      values ? `${key}:${values.from}-${values.to}/${values.total}` : key,
  }),
}))

function markup(page: number, total: number, pageSize = 10) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Pager
        page={page}
        total={total}
        pageSize={pageSize}
        hrefFor={(nextPage) => `/items?page=${nextPage}`}
        labels={{
          range: 'team.inventory.range',
          prev: 'team.inventory.page.prev',
          next: 'team.inventory.page.next',
        }}
      />
    </MemoryRouter>,
  )
}

describe('Pager', () => {
  test('renders interpolated range and no buttons on one page', () => {
    const html = markup(1, 0)
    expect(html).toContain('team.inventory.range:0-0/0')
    expect(html).not.toContain('<button')
  })

  test('disables previous and next at the boundaries', () => {
    expect(markup(1, 25)).toContain('disabled')
    expect(markup(3, 25)).toContain('disabled')
  })

  test('links both directions on a middle page', () => {
    const html = markup(2, 25)
    expect(html).toContain('href="/items?page=1"')
    expect(html).toContain('href="/items?page=3"')
  })
})
