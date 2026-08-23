import { beforeEach, describe, expect, test, vi } from 'vitest'

const renderMock = vi.hoisted(() => vi.fn())

vi.mock('takumi-js', () => ({ render: renderMock }))

import { renderShareOgImage } from './preview-image.server'

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
    expect(renderMock.mock.calls[0]?.[0]).toContain(
      'https://artifactshare.com/api/avatar/owner123',
    )
    expect(renderMock.mock.calls[1]?.[0]).not.toContain(
      'https://artifactshare.com/api/avatar/owner123',
    )
    expect(renderMock.mock.calls[1]?.[0]).toContain('>O</span>')
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

    const markup = String(renderMock.mock.calls[0]?.[0])
    expect(markup).toContain(`by ${'長'.repeat(47)}…`)
    expect(markup).not.toContain('長'.repeat(49))
    expect(markup).toContain(
      'min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis',
    )
    expect(markup).toContain(
      'flex-grow:0;flex-shrink:0;white-space:nowrap">· artifactshare.com/a/demo',
    )
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

    const markup = String(renderMock.mock.calls[0]?.[0])
    expect(markup).toContain('font-size:68px')
    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({ lang: 'ja' })
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
