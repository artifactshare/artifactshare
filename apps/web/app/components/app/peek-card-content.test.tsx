import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ProjectContent, ShareableContent } from './peek-card-content'
import type { ProjectData, ShareableData } from './peek-data'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'peek.noExcerpt': 'No excerpt',
        'peek.noFiles': 'No files',
        'peek.noDescription': 'No description',
        'tb.home': 'Home',
      })[key] ?? key,
    tPlural: (_key: string, count: number) => `${count} files`,
  }),
}))
vi.mock('~/components/app/author-avatar', () => ({
  AuthorAvatar: () => <span data-test-avatar />,
}))
vi.mock('~/components/app/file-type-icon', () => ({
  FileTypeIcon: () => <span data-test-file-icon />,
}))
vi.mock('~/lib/datetime', () => ({ formatRelative: () => 'now' }))

const shareable: ShareableData = {
  id: 's1',
  title: 'Title',
  description: null,
  ownerName: 'Owner',
  ownerId: 'u1',
  ownerImage: null,
  viewCount: 0,
  commentCount: 0,
  createdAt: '2026-01-01',
  publishedAt: null,
  versionCount: 0,
  containerName: null,
  containerKind: null,
  excerpt: null,
}
const project: ProjectData = {
  id: 'p1',
  name: 'Project',
  description: null,
  fileCount: 0,
  participantCount: 0,
  updatedAt: '2026-01-01',
  recentFiles: [],
}

describe('peek card content structure', () => {
  test('shareable has title, body and meta order with an excerpt empty state', () => {
    const root = renderToStaticMarkup(<ShareableContent data={shareable} />)
    expect(root.indexOf('data-peek-part="title"')).toBeLessThan(
      root.indexOf('data-peek-part="body"'),
    )
    expect(root.indexOf('data-peek-part="body"')).toBeLessThan(
      root.indexOf('data-peek-part="meta"'),
    )
    expect(root).not.toContain('data-peek-part="activity"')
    expect(root).not.toContain('data-peek-location')
    expect(root).not.toContain('Home')
    expect(root).toContain('Title')
    expect(root).toContain('No excerpt')
  })
  test('project has title, recent files, description and counts order with empty states', () => {
    const root = renderToStaticMarkup(<ProjectContent data={project} />)
    expect(root.indexOf('data-peek-part="title"')).toBeLessThan(
      root.indexOf('data-peek-part="recent-files"'),
    )
    expect(root.indexOf('data-peek-part="recent-files"')).toBeLessThan(
      root.indexOf('data-peek-part="description"'),
    )
    expect(root.indexOf('data-peek-part="description"')).toBeLessThan(
      root.indexOf('data-peek-part="counts"'),
    )
    expect(root).toContain('No files')
    expect(root).toContain('No description')
    expect(root).toContain('Project')
  })
})
