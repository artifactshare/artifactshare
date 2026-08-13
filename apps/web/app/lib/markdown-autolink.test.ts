import { renderHtml } from '@tanstack/markdown/html'
import { describe, expect, test } from 'vitest'

import { httpAutolinkExtension } from './markdown-autolink'

function render(source: string) {
  return renderHtml(source, { extensions: [httpAutolinkExtension] })
}

describe('HTTP autolinks', () => {
  test('links bare HTTP and HTTPS URLs', () => {
    expect(
      render('Read HTTPS://example.com/docs and http://example.test/status'),
    ).toContain(
      '<a href="HTTPS://example.com/docs">HTTPS://example.com/docs</a>',
    )
  })

  test('keeps query strings and trims trailing prose punctuation', () => {
    expect(render('https://example.com/search?a=1&b=two.')).toBe(
      '<p><a href="https://example.com/search?a=1&amp;b=two">https://example.com/search?a=1&amp;b=two</a>.</p>',
    )
  })

  test('stops before adjacent Japanese prose', () => {
    expect(render('詳細はhttps://example.comをご覧ください。')).toContain(
      '<a href="https://example.com">https://example.com</a>をご覧ください。',
    )
  })

  test('does not nest existing links or link code spans', () => {
    const html = render(
      '[https://example.com/labeled](https://example.com/target) `https://example.com/code`',
    )
    expect(html).toContain(
      '<a href="https://example.com/target">https://example.com/labeled</a>',
    )
    expect(html).toContain('<code>https://example.com/code</code>')
    expect(html).not.toContain('<a href="https://example.com/target"><a')
  })
})
