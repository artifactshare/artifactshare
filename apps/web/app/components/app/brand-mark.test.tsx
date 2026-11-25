import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { BrandMark } from './brand-mark'

describe('BrandMark', () => {
  test.each([
    { size: 16 as const, className: 'size-4' },
    { size: 20 as const, className: 'size-5' },
    { size: 24 as const, className: 'size-6' },
    { size: 32 as const, className: 'size-8' },
  ])('renders size $size with $className', ({ size, className }) => {
    const html = renderToStaticMarkup(
      <BrandMark size={size} aria-hidden="true" />,
    )
    expect(html).toContain(className)
    expect(html).toContain('bg-[url(/favicon.svg)]')
    expect(html).toContain('aria-hidden="true"')
  })
})
