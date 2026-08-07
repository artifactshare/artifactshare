import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ProjectNewBadge } from './project-new-badge'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      key === 'project.newBadge' ? `${vars?.count} new` : key,
  }),
}))

describe('ProjectNewBadge', () => {
  test.each([
    [0, ''],
    [1, '1 new'],
    [100, '99+ new'],
  ])('renders the expected badge for count %s', (count, label) => {
    const html = renderToStaticMarkup(<ProjectNewBadge count={count} />)

    expect(html).toContain(label)
    if (count > 0) {
      expect(html).toContain(
        'bg-link-soft text-link shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
      )
    } else {
      expect(html).toBe('')
    }
  })
})
