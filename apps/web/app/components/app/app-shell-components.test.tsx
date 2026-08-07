import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

describe('app shell component contracts', () => {
  test('AppPageHeader owns the shared title, description, meta, and action layout', () => {
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

    expect(html).toContain('text-xl')
    expect(html).toContain('leading-tight')
    expect(html).toContain('font-semibold')
    expect(html).toContain('mb-4.5')
    expect(html).toContain('mark')
    expect(html).toContain('badge')
    expect(html).toContain('meta')
    expect(html).toContain('description')
    expect(html).toContain('action')
  })

  test('AppSectionHeader preserves the requested heading level and styles metadata', () => {
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
    expect(html).toContain('text-sm')
    expect(html).toContain('font-semibold')
    expect(html).toContain('text-faint')
    expect(html).toContain('Newest')
  })

  test('AppSectionHeader keeps date groups visually subordinate', () => {
    const html = render(
      <AppSectionHeader as="h3" title="Jul 29" variant="group" />,
    )

    expect(html).toContain('<h3')
    expect(html).toContain('text-xs')
    expect(html).toContain('font-medium')
    expect(html).toContain('text-faint')
    expect(html).toContain('mb-1')
  })

  test('AppDividerList keeps the caller list element without an extra wrapper', () => {
    const html = render(
      <AppDividerList as="ul">
        <li>row</li>
      </AppDividerList>,
    )

    expect(html.startsWith('<ul')).toBe(true)
    expect(html).toContain('flex')
    expect(html).toContain('gap-1')
    expect(html).toContain('border-t')
    expect(html).toContain('border-divider')
  })

  test('AppMoreLink supports links and buttons with the same visual contract', () => {
    const link = render(<AppMoreLink to="/projects">projects</AppMoreLink>)
    const button = render(<AppMoreLink as="button">expand</AppMoreLink>)

    for (const html of [link, button]) {
      expect(html).toContain('text-link')
      expect(html).toContain('text-sm')
      expect(html).toContain('hover:underline')
    }
    expect(link).toContain('href="/projects"')
    expect(button).toContain('<button type="button"')
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
  })

  test('all current page surfaces consume the shared page header', () => {
    const componentDir = new URL('../../', import.meta.url)
    const routes = [
      'routes/_home/index.tsx',
      'routes/_home/_protected/files.tsx',
      'routes/_home/+components/recent-content.tsx',
      'routes/_home/_protected/projects.tsx',
      'routes/_protected/projects.$id.tsx',
      'routes/_protected/projects.$id.files.tsx',
      'routes/_protected/projects.$id.activity.tsx',
    ]

    for (const route of routes) {
      const source = readFileSync(
        fileURLToPath(new URL(route, componentDir)),
        'utf8',
      )
      expect(source, route).toContain('AppPageHeader')
    }
  })

  test('legacy headers stay separated while redesign-only header constants are removed', () => {
    const appDir = new URL('../../', import.meta.url)
    const homeStyles = readFileSync(
      fileURLToPath(
        new URL('routes/_home/+components/file-list-styles.ts', appDir),
      ),
      'utf8',
    )
    const projectStyles = readFileSync(
      fileURLToPath(
        new URL(
          'routes/_protected/+components/project-redesign-styles.ts',
          appDir,
        ),
      ),
      'utf8',
    )

    expect(homeStyles).toContain('font-emphasis')
    expect(homeStyles).toContain('seeAllClassName')
    expect(projectStyles).toContain('redesignSectionClassName')
    expect(projectStyles).not.toMatch(
      /redesignSection(?:Head|Title|HeadMeta|Meta)ClassName/,
    )
  })
})
