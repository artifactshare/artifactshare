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
})
