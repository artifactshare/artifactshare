// @vitest-environment happy-dom
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

function controls(page: number, total: number) {
  const doc = new DOMParser().parseFromString(markup(page, total), 'text/html')
  const control = (label: string) => {
    const element = [...doc.querySelectorAll('a, button')].find(
      (candidate) => candidate.textContent === label,
    )!
    return {
      href: element.getAttribute('href'),
      disabled: element.hasAttribute('disabled'),
    }
  }
  return {
    prev: control('team.inventory.page.prev'),
    next: control('team.inventory.page.next'),
  }
}

const disabled = { href: null, disabled: true }

describe('Pager', () => {
  test('renders interpolated range and no buttons on one page', () => {
    const html = markup(1, 0)
    expect(html).toContain('team.inventory.range:0-0/0')
    expect(html).not.toContain('<button')
  })

  test('disables previous on the first page and next on the last page', () => {
    expect(controls(1, 25)).toEqual({
      prev: disabled,
      next: { href: '/items?page=2', disabled: false },
    })
    expect(controls(3, 25)).toEqual({
      prev: { href: '/items?page=2', disabled: false },
      next: disabled,
    })
  })

  test('links both directions on a middle page', () => {
    expect(controls(2, 25)).toEqual({
      prev: { href: '/items?page=1', disabled: false },
      next: { href: '/items?page=3', disabled: false },
    })
  })
})
