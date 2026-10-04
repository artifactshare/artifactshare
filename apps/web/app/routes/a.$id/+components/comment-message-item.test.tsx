import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { CommentMessageItem } from './comment-message-item'
import type { CommentMessageView } from '~/lib/comments'

vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))

const message: CommentMessageView = {
  id: 'message-1',
  body: 'Review this file',
  agent: null,
  createdAt: '2026-07-29T00:00:00Z',
  updatedAt: '2026-07-30T00:00:00Z',
  author: { id: 'u1', name: 'Owner', email: 'owner@example.com', image: null },
  canEdit: false,
  canDelete: false,
}

function render(agent: string | null) {
  return renderToStaticMarkup(
    <CommentMessageItem
      message={{ ...message, agent }}
      locale="en"
      pending={false}
      onUpdate={async () => true}
      onDelete={async () => true}
    />,
  )
}

describe('comment agent badge', () => {
  test.each([
    'Research assistant with a very long original agent name',
    'Codex',
  ])('keeps full title and text for %s', (agent) => {
    const html = render(agent)
    expect(html).toContain(`title="${agent}"`)
    expect(html).toContain(
      `<span class="block min-w-0 truncate">${agent}</span>`,
    )
    expect(html).toContain('Review this file')
    expect(html).toContain('Owner')
    expect(html).toContain('comments.edited')
  })
  test('omits absent agents and escapes supplied names', () => {
    expect(render(null)).not.toContain('max-w-badge-max')
    const html = render('<script>"agent" & name</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain(
      'title="&lt;script&gt;&quot;agent&quot; &amp; name&lt;/script&gt;"',
    )
  })
})
