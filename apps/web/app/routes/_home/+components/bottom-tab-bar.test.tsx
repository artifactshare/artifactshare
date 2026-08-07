import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { BottomTabBar } from './bottom-tab-bar'

vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))

function renderAt(pathname: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <BottomTabBar />
    </MemoryRouter>,
  )
}

describe('BottomTabBar primary navigation', () => {
  test('uses the agreed primary order', () => {
    const html = renderAt('/')
    const home = html.indexOf('href="/"')
    const recent = html.indexOf('href="/recent"')
    const files = html.indexOf('href="/files"')
    const projects = html.indexOf('href="/projects"')
    expect(home).toBeGreaterThanOrEqual(0)
    expect(home).toBeLessThan(recent)
    expect(recent).toBeLessThan(files)
    expect(files).toBeLessThan(projects)
  })

  test.each([
    ['/', 'tb.home'],
    ['/recent', 'tb.recent'],
    ['/files', 'home.myFiles'],
    ['/projects', 'tb.projects'],
    ['/projects/p1', 'tb.projects'],
    ['/projects/p1/files', 'tb.projects'],
    ['/projects/p1/activity', 'tb.projects'],
  ])('%s marks only %s current', (pathname, label) => {
    const html = renderAt(pathname)
    expect(html).toMatch(
      new RegExp(
        `aria-label="${label.replace('.', '\\.')}"[^>]*aria-current="page"`,
      ),
    )
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  test('settings keeps all items without a false current section', () => {
    const html = renderAt('/settings/general')
    expect(html).toContain('href="/recent"')
    expect(html).toContain('href="/files"')
    expect(html).toContain('href="/projects"')
    expect(html).not.toContain('aria-current="page"')
  })
})
