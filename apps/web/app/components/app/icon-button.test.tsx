import { renderToStaticMarkup } from 'react-dom/server'
import { IconCopy as Copy, IconX as X } from '@tabler/icons-react'
import { describe, expect, test } from 'vitest'

import { IconButton } from './icon-button'

describe('IconButton', () => {
  test.each([
    { size: 'sm' as const, buttonClass: 'size-7', iconSize: '14' },
    { size: 'md' as const, buttonClass: 'size-7.5', iconSize: '15' },
  ])('renders the $size variant', ({ size, buttonClass, iconSize }) => {
    const html = renderToStaticMarkup(
      <IconButton
        type="button"
        icon={size === 'sm' ? Copy : X}
        size={size}
        aria-label="Action"
      />,
    )

    expect(html).toContain(buttonClass)
    expect(html).toContain(`width="${iconSize}"`)
    expect(html).toContain(`height="${iconSize}"`)
    expect(html).toContain('class="tabler-icon')
    expect(html).toContain('size-auto')
    expect(html).toContain('aria-label="Action"')
    expect(html).toContain('aria-hidden="true"')
  })
})
