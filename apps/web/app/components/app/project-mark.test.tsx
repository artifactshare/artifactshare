import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ProjectMark } from './project-mark'
import { avatarSlotFor } from '~/lib/user'

describe('ProjectMark', () => {
  test('renders the first code point and deterministic avatar background', () => {
    const html = renderToStaticMarkup(
      <ProjectMark id="project-1" name="  東京 project" />,
    )
    expect(html).toContain('>東</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain(
      `background:var(--avatar-${avatarSlotFor('project-1')})`,
    )
  })
})
