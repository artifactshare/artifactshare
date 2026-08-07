import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AuthorAvatar } from './author-avatar'

describe('AuthorAvatar', () => {
  test.each([
    { size: 'xs' as const, className: 'size-3.5', width: '14' },
    { size: 'sm' as const, className: 'size-5', width: '20' },
    { size: 'menu' as const, className: 'size-6.5', width: '26' },
  ])(
    'renders $size with matching class and image dimensions',
    ({ size, className, width }) => {
      const html = renderToStaticMarkup(
        <AuthorAvatar
          id="user-1"
          image="https://example.com/avatar.png"
          initial="A"
          size={size}
        />,
      )
      expect(html).toContain(className)
      expect(html).toContain(`width="${width}"`)
      expect(html).toContain(`height="${width}"`)
    },
  )
})
