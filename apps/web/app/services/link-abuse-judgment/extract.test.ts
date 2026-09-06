import { describe, expect, test } from 'vitest'
import {
  extractLinkAbuseContent,
  LINK_ABUSE_ENTRYPOINT_LIMIT,
  LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT,
  LINK_ABUSE_TEXT_LIMIT,
} from './extract'

describe('link abuse HTML extraction', () => {
  test('strips scripts and styles and extracts unique external domains', () => {
    const extracted = extractLinkAbuseContent(`
      <style>.secret { content: "style-secret" }</style>
      <script>window.secret = "script-secret"</script>
      <h1>Visible heading</h1>
      <a href="https://one.example.test/path?token=secret">one</a>
      <img src="//two.example.test/image.png">
      <form action="https://one.example.test/submit"></form>
      <a href="/internal">internal</a>
      <a href="https://artifactshare.com/a/abc123def4">platform</a>
      <meta http-equiv="refresh" content="0; url=https://three.example.test/fix">
    `)
    expect(extracted.text).toContain('Visible heading')
    expect(extracted.text).not.toMatch(/script-secret|style-secret/u)
    expect(extracted.externalDomains).toEqual([
      'one.example.test',
      'two.example.test',
      'three.example.test',
    ])
  })

  test('caps text and domains', () => {
    const links = Array.from(
      { length: LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT + 10 },
      (_, index) => `<a href="https://host-${index}.example.test/">link</a>`,
    ).join('')
    const extracted = extractLinkAbuseContent(
      `<p>${'x'.repeat(LINK_ABUSE_TEXT_LIMIT + 1_000)}</p>${links}`,
    )
    expect(extracted.text).toHaveLength(LINK_ABUSE_TEXT_LIMIT)
    expect(extracted.externalDomains).toHaveLength(
      LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT,
    )
  })

  test('leaves invalid numeric entities inert instead of throwing', () => {
    expect(extractLinkAbuseContent('<p>&#1114112; ok</p>').text).toBe(
      '&#1114112; ok',
    )
  })

  test('extracts external domains from Markdown links, autolinks, and bare URLs', () => {
    expect(
      extractLinkAbuseContent(`
        [documentation](https://docs.example.test/path)
        <https://status.example.test/current>
        Visit https://download.example.test/file now.
      `).externalDomains,
    ).toEqual([
      'docs.example.test',
      'status.example.test',
      'download.example.test',
    ])
  })

  test('does not treat custom elements as inactive content', () => {
    const extracted = extractLinkAbuseContent(
      '<script-content>Script label</script-content><style-panel>Style label</style-panel>',
    )
    expect(extracted.text).toBe('Script label Style label')
  })

  test('bounds scanning to the first and last 128 KB', () => {
    const halfLimit = LINK_ABUSE_ENTRYPOINT_LIMIT / 2
    const source = `<h1>Head payload</h1>${'x'.repeat(halfLimit)}<a href="https://middle.example.test">Middle payload</a>${'y'.repeat(halfLimit)}<a href="https://tail.example.test">Tail payload</a>`
    const extracted = extractLinkAbuseContent(source)
    expect(extracted.text).toContain('Head payload')
    expect(extracted.text).not.toContain('Middle payload')
    expect(extracted.externalDomains).toContain('tail.example.test')
    expect(extracted.externalDomains).not.toContain('middle.example.test')
    expect(source.length).toBeGreaterThan(LINK_ABUSE_ENTRYPOINT_LIMIT)
  })

  test('does not re-fuse an inactive tag split across the head and tail boundary', () => {
    const halfLimit = LINK_ABUSE_ENTRYPOINT_LIMIT / 2
    const tailPrefix =
      'ipt><a href="https://tail.example.test/path">Tail</a></script>'
    const source =
      'x'.repeat(halfLimit - 4) +
      '<scr' +
      'z' +
      tailPrefix +
      'y'.repeat(halfLimit - tailPrefix.length)

    // The tail window starts inside the split script, so its leading source
    // (including the link) is inactive content and nothing is re-fused.
    const extracted = extractLinkAbuseContent(source)
    expect(extracted.externalDomains).toEqual([])
    expect(extracted.text).not.toContain('scr')
  })

  test('handles 50,000 unclosed script openers', () => {
    expect(extractLinkAbuseContent('<script>'.repeat(50_000))).toEqual({
      text: '',
      externalDomains: [],
    })
  })

  test('stays linear when many openers are followed by non-matching closers', () => {
    const html = '<script></x>'.repeat(50_000) + '<p>tail</p>'
    const extracted = extractLinkAbuseContent(html)
    // Every opener is unclosed, so each window drops its remainder; only a
    // split-token fragment at the tail window's start can survive.
    expect(extracted.text).not.toContain('tail')
    expect(extracted.externalDomains).toEqual([])
  })

  test('stops a bare URL at a closing parenthesis', () => {
    const extracted = extractLinkAbuseContent(
      '<p>see (https://paren.example/path)</p>',
    )
    expect(extracted.externalDomains).toEqual(['paren.example'])
  })

  test('drops the rest of a window after an unclosed inactive opener', () => {
    const extracted = extractLinkAbuseContent(
      '<h1>Before</h1><script>var u = "https://leak.example/"',
    )
    expect(extracted.text).toBe('Before')
    expect(extracted.externalDomains).toEqual([])
  })

  test('treats a custom-element closing tag as ordinary content', () => {
    const extracted = extractLinkAbuseContent(
      '<p>Shown</p><script-content>Fake update</script-content>',
    )
    expect(extracted.text).toBe('Shown Fake update')
  })

  test('mines the tail window even when a head script straddles the boundary', () => {
    const head = '<p>head</p><script>' + 'x'.repeat(200 * 1_024)
    const tail =
      'y'.repeat(200 * 1_024) +
      '</script><p>tail</p><a href="https://tail.example/">t</a>'
    const extracted = extractLinkAbuseContent(head + tail)
    expect(extracted.text.startsWith('head')).toBe(true)
    expect(extracted.text).toContain('tail')
    expect(extracted.externalDomains).toEqual(['tail.example'])
  })

  test('gives each window its own text and domain budget', () => {
    const headLinks = Array.from(
      { length: 60 },
      (_, i) => `<a href="https://h${i}.example/">h</a>`,
    ).join('')
    const head = headLinks + 'h'.repeat(140 * 1_024)
    const tail =
      't'.repeat(140 * 1_024) + '<a href="https://tail.example/">t</a>'
    const extracted = extractLinkAbuseContent(head + tail)
    expect(extracted.externalDomains).toContain('tail.example')
    expect(extracted.externalDomains.length).toBeLessThanOrEqual(50)
  })

  test('does not read script-like assignments as attributes', () => {
    const extracted = extractLinkAbuseContent(
      '<p>el.src = "https://assign.example/x"</p><img src="https://img.example/a.png">',
    )
    expect(extracted.externalDomains).toEqual(['img.example', 'assign.example'])
  })
})
