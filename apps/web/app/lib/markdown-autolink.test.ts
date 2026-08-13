import { renderHtml } from '@tanstack/markdown/html'
import { describe, expect, test } from 'vitest'

import { httpAutolinkExtension } from './markdown-autolink'

function render(source: string) {
  return renderHtml(source, { extensions: [httpAutolinkExtension] })
}

describe('HTTP autolinks', () => {
  test('links bare HTTP and HTTPS URLs', () => {
    expect(
      render('Read https://example.com/docs and http://example.test/status'),
    ).toBe(
      '<p>Read <a href="https://example.com/docs">https://example.com/docs</a> and <a href="http://example.test/status">http://example.test/status</a></p>',
    )
  })

  test('keeps query strings while escaping rendered attributes', () => {
    expect(render('https://example.com/search?a=1&b=two')).toBe(
      '<p><a href="https://example.com/search?a=1&amp;b=two">https://example.com/search?a=1&amp;b=two</a></p>',
    )
  })

  test('stops before adjacent Japanese prose', () => {
    expect(render('詳細はhttps://example.comをご覧ください。')).toContain(
      '<a href="https://example.com">https://example.com</a>をご覧ください。',
    )
  })

  test('links percent-encoded non-ASCII URL paths', () => {
    const url = 'https://example.com/%E5%88%9D%E9%9F%B3%E3%83%9F%E3%82%AF'
    expect(render(url)).toContain(`<a href="${url}">${url}</a>`)
  })

  test.each([
    ['https://example.com/docs.', 'https://example.com/docs', '.'],
    ['https://example.com/docs。', 'https://example.com/docs', '。'],
    ['(https://example.com/docs)', 'https://example.com/docs', ')'],
    [
      'https://example.com/function_(one)',
      'https://example.com/function_(one)',
      '',
    ],
    ['https://example.com[^1]', 'https://example.com', '[^1]'],
    ['https://example.com(見る', 'https://example.com', '(見る'],
  ])('trims prose punctuation from %s', (source, url, suffix) => {
    const html = render(source)
    expect(html).toContain(`<a href="${url}">${url}</a>${suffix}`)
  })

  test('links URLs nested in emphasis without nesting existing links', () => {
    const html = render(
      '*https://example.com/emphasized* [https://example.com/labeled](https://example.com/target)',
    )
    expect(html).toContain(
      '<em><a href="https://example.com/emphasized">https://example.com/emphasized</a></em>',
    )
    expect(html).toContain(
      '<a href="https://example.com/target">https://example.com/labeled</a>',
    )
    expect(html).not.toContain('<a href="https://example.com/target"><a')
  })

  test('does not link code spans or unsupported schemes', () => {
    expect(render('`https://example.com/code` javascript:alert(1)')).toBe(
      '<p><code>https://example.com/code</code> javascript:alert(1)</p>',
    )
  })

  test('does not nest links inside raw HTML anchors', () => {
    expect(
      renderHtml('Text <a href="/x">https://example.com</a> end', {
        allowHtml: true,
        extensions: [httpAutolinkExtension],
      }),
    ).toBe('<p>Text <a href="/x">https://example.com</a> end</p>')
  })

  test('does not nest formatted links inside raw HTML anchors', () => {
    expect(
      renderHtml('Text <a href="/x">**https://example.com**</a> end', {
        allowHtml: true,
        extensions: [httpAutolinkExtension],
      }),
    ).toBe(
      '<p>Text <a href="/x"><strong>https://example.com</strong></a> end</p>',
    )
  })

  test('does not autolink across malformed raw anchor formatting boundaries', () => {
    const html = renderHtml(
      '**<a href="/x">label** more https://example.com</a>',
      {
        allowHtml: true,
        extensions: [httpAutolinkExtension],
      },
    )
    expect(html).not.toContain('<a href="https://example.com">')
  })

  test('does not link an HTTP scheme without a host', () => {
    expect(render('https://...')).toBe('<p>https://...</p>')
  })
})
