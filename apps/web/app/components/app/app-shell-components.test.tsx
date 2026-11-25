import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test } from 'vitest'
import { AppDividerList } from './app-divider-list'
import { AppEmptyState } from './app-empty-state'
import { AppMoreLink } from './app-more-link'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderDescription,
  AppPageHeaderMain,
  AppPageHeaderMeta,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from './app-page-header'
import { AppSectionHeader } from './app-section-header'

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)

// What a reader depends on here is the element each slot renders and the
// content reaching it. Styling is checked by the visual suite.
describe('app shell component contracts', () => {
  test('AppPageHeader renders every slot it is given', () => {
    const html = render(
      <AppPageHeader>
        <AppPageHeaderMain>
          <AppPageHeaderTitleRow>
            <span>mark</span>
            <AppPageHeaderTitle>Files</AppPageHeaderTitle>
            <span>badge</span>
          </AppPageHeaderTitleRow>
          <AppPageHeaderMeta>meta</AppPageHeaderMeta>
          <AppPageHeaderDescription>description</AppPageHeaderDescription>
        </AppPageHeaderMain>
        <AppPageHeaderActions>
          <button type="button">action</button>
        </AppPageHeaderActions>
      </AppPageHeader>,
    )

    for (const content of [
      'mark',
      'Files',
      'badge',
      'meta',
      'description',
      'action',
    ])
      expect(html).toContain(content)
  })

  test('AppSectionHeader preserves the requested heading level and its metadata', () => {
    const html = render(
      <AppSectionHeader
        as="h3"
        titleId="recent-heading"
        title="Recent"
        count="3"
        meta="Newest"
        actions={<button type="button">more</button>}
      />,
    )

    expect(html).toContain('<h3')
    expect(html).toContain('id="recent-heading"')
    for (const content of ['Recent', '3', 'Newest', 'more'])
      expect(html).toContain(content)
  })

  test('AppSectionHeader renders a date group differently from a section', () => {
    const group = render(
      <AppSectionHeader as="h3" title="Jul 29" variant="group" />,
    )

    expect(group).toContain('<h3')
    expect(group).toContain('Jul 29')
    expect(group).not.toBe(render(<AppSectionHeader as="h3" title="Jul 29" />))
  })

  test('AppDividerList keeps the caller list element without an extra wrapper', () => {
    const html = render(
      <AppDividerList as="ul">
        <li>row</li>
      </AppDividerList>,
    )

    expect(html.startsWith('<ul')).toBe(true)
    expect(html).toContain('<li>row</li>')
  })

  test('AppMoreLink renders a link or a button as asked', () => {
    const link = render(<AppMoreLink to="/projects">projects</AppMoreLink>)
    const button = render(<AppMoreLink as="button">expand</AppMoreLink>)

    expect(link).toContain('href="/projects"')
    expect(link).toContain('projects')
    expect(button).toContain('<button type="button"')
    expect(button).toContain('expand')
    expect(button).not.toContain('href')
  })

  test('AppEmptyState keeps optional content in the shared semantic slots', () => {
    const html = render(
      <AppEmptyState
        icon={<span>icon</span>}
        title="Nothing here"
        body="Try another view"
        action={<button type="button">create</button>}
      />,
    )

    expect(html).toContain('data-slot="empty"')
    expect(html).toContain('data-slot="empty-title"')
    expect(html).toContain('data-slot="empty-description"')
    expect(html).toContain('data-slot="empty-content"')
    expect(html).toContain('Nothing here')
    expect(html).toContain('Try another view')
  })
})
