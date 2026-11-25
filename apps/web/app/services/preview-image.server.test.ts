// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest'

const renderMock = vi.hoisted(() => vi.fn())

vi.mock('takumi-js', () => ({ render: renderMock }))

import { renderShareOgImage } from './preview-image.server'

function cardMarkup(call = 0) {
  const markup = String(renderMock.mock.calls[call]?.[0])
  return new DOMParser().parseFromString(markup, 'text/html')
}

/** The element's inline style as declarations, so their order is free. */
function declarations(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  return Object.fromEntries(
    (element!.getAttribute('style') ?? '')
      .split(';')
      .filter(Boolean)
      .map((declaration) => {
        const [property, ...value] = declaration.split(':')
        return [property!.trim(), value.join(':').trim()]
      }),
  )
}

const spanStartingWith = (page: Document, prefix: string) =>
  [...page.querySelectorAll('footer span')].find(
    (span) =>
      span.children.length === 0 && span.textContent?.startsWith(prefix),
  )

describe('renderShareOgImage', () => {
  beforeEach(() => renderMock.mockReset())

  test('falls back to the owner initial when the avatar cannot be fetched', async () => {
    const png = new Uint8Array([1, 2, 3])
    renderMock
      .mockRejectedValueOnce(new Error('avatar fetch failed'))
      .mockResolvedValueOnce(png)

    await expect(
      renderShareOgImage({
        title: 'Demo Report',
        ownerLabel: 'Owner',
        ownerAvatarUrl: 'https://artifactshare.com/api/avatar/owner123',
        urlLabel: 'artifactshare.com/a/demo',
        fontKv: undefined,
      }),
    ).resolves.toEqual(png)

    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(cardMarkup(0).querySelector('footer img')?.getAttribute('src')).toBe(
      'https://artifactshare.com/api/avatar/owner123',
    )
    const fallback = cardMarkup(1)
    expect(fallback.querySelector('footer img')).toBeNull()
    expect(spanStartingWith(fallback, 'O')?.textContent).toBe('O')
  })

  test('bounds a long owner label inside the fixed-height footer', async () => {
    renderMock.mockResolvedValueOnce(new Uint8Array([1]))

    await renderShareOgImage({
      title: 'Demo Report',
      ownerLabel: '長'.repeat(60),
      ownerAvatarUrl: null,
      urlLabel: 'artifactshare.com/a/demo',
      fontKv: undefined,
    })

    const page = cardMarkup()
    const owner = spanStartingWith(page, 'by ')
    expect(owner?.textContent).toBe(`by ${'長'.repeat(47)}…`)
    expect(declarations(owner)).toMatchObject({
      'min-width': '0',
      overflow: 'hidden',
      'white-space': 'nowrap',
      'text-overflow': 'ellipsis',
    })
    const url = spanStartingWith(page, '·')
    expect(url?.textContent).toBe('· artifactshare.com/a/demo')
    expect(declarations(url)).toMatchObject({
      'flex-grow': '0',
      'flex-shrink': '0',
      'white-space': 'nowrap',
    })
  })

  test('shrinks three-line titles to fit the fixed content area', async () => {
    renderMock.mockResolvedValueOnce(new Uint8Array([1]))

    await renderShareOgImage({
      title: '成果物をチームに届けて、同じURLで改善を続けるための記事',
      ownerLabel: null,
      ownerAvatarUrl: null,
      urlLabel: 'artifactshare.com/a/demo',
      fontKv: undefined,
    })

    const page = cardMarkup()
    expect(declarations(page.querySelector('h1'))['font-size']).toBe('68px')
    expect(page.querySelectorAll('h1 span').length).toBeGreaterThan(1)
    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({ lang: 'ja' })
  })

  test('uses one smaller type size when it keeps a short title on one line', async () => {
    renderMock.mockResolvedValueOnce(new Uint8Array([1]))

    await renderShareOgImage({
      title: 'ソフトウェアファクトリー 2026',
      ownerLabel: null,
      ownerAvatarUrl: null,
      urlLabel: 'artifactshare.com/a/demo',
      fontKv: undefined,
    })

    const page = cardMarkup()
    expect(declarations(page.querySelector('h1'))['font-size']).toBe('68px')
    const lines = page.querySelectorAll('h1 span')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toBe('ソフトウェアファクトリー 2026')
    expect(declarations(lines[0])).toMatchObject({ 'white-space': 'nowrap' })
  })

  test('uses English line-breaking rules for English cards', async () => {
    renderMock.mockResolvedValueOnce(new Uint8Array([1]))

    await renderShareOgImage({
      title: 'A clear English title',
      ownerLabel: null,
      ownerAvatarUrl: null,
      urlLabel: 'artifactshare.com/a/demo',
      fontKv: undefined,
    })

    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({ lang: 'en' })
  })
})
