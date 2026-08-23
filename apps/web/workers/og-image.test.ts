import { beforeEach, describe, expect, test, vi } from 'vitest'

const renderHomeOgImageMock = vi.hoisted(() => vi.fn())
const renderConnectOgImageMock = vi.hoisted(() => vi.fn())
const renderShareOgImageMock = vi.hoisted(() => vi.fn())
const renderUpdatesEntryOgImageMock = vi.hoisted(() => vi.fn())
const renderPrivateMobileDesignHandoffOgImageMock = vi.hoisted(() => vi.fn())

vi.mock('../app/services/preview-image.server', () => ({
  renderConnectOgImage: renderConnectOgImageMock,
  renderHomeOgImage: renderHomeOgImageMock,
  renderShareOgImage: renderShareOgImageMock,
  renderUpdatesEntryOgImage: renderUpdatesEntryOgImageMock,
  renderPrivateMobileDesignHandoffOgImage:
    renderPrivateMobileDesignHandoffOgImageMock,
}))

import ogImage from './og-image'

const env = {
  SLACK_PREVIEW_FONT_KV: {} as KVNamespace,
  APP_ENV: 'test',
  DEFAULT_LOCALE: 'en' as const,
}

const png = new Uint8Array([137, 80, 78, 71])

beforeEach(() => {
  renderHomeOgImageMock.mockReset()
  renderConnectOgImageMock.mockReset()
  renderShareOgImageMock.mockReset()
  renderUpdatesEntryOgImageMock.mockReset()
  renderPrivateMobileDesignHandoffOgImageMock.mockReset()
  renderHomeOgImageMock.mockResolvedValue(png)
  renderConnectOgImageMock.mockResolvedValue(png)
  renderShareOgImageMock.mockResolvedValue(png)
  renderUpdatesEntryOgImageMock.mockResolvedValue(png)
  renderPrivateMobileDesignHandoffOgImageMock.mockResolvedValue(png)
})

describe('og-image worker', () => {
  test('renders the home card as image/png with the default locale', async () => {
    const response = await ogImage.fetch(
      workerRequest('https://og-image.artifactshare.internal/home'),
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(renderHomeOgImageMock).toHaveBeenCalledWith(
      'en',
      env.SLACK_PREVIEW_FONT_KV,
    )
  })

  test('renders the home card with the requested locale', async () => {
    const response = await ogImage.fetch(
      workerRequest('https://og-image.artifactshare.internal/home?lang=ja'),
      env,
    )

    expect(response.status).toBe(200)
    expect(renderHomeOgImageMock).toHaveBeenCalledWith(
      'ja',
      env.SLACK_PREVIEW_FONT_KV,
    )
  })

  test('renders the connect card with the requested locale', async () => {
    const response = await ogImage.fetch(
      workerRequest('https://og-image.artifactshare.internal/connect?lang=ja'),
      env,
    )

    expect(response.status).toBe(200)
    expect(renderConnectOgImageMock).toHaveBeenCalledWith(
      'ja',
      env.SLACK_PREVIEW_FONT_KV,
    )
  })

  test('renders a share card from query parameters', async () => {
    const response = await ogImage.fetch(
      workerRequest(
        'https://og-image.artifactshare.internal/share?title=Demo&owner=Owner&avatar=https%3A%2F%2Fartifactshare.com%2Fapi%2Favatar%2Fowner123&url=artifactshare.com%2Fa%2Fdemo',
      ),
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(renderShareOgImageMock).toHaveBeenCalledWith({
      title: 'Demo',
      ownerLabel: 'Owner',
      ownerAvatarUrl: 'https://artifactshare.com/api/avatar/owner123',
      urlLabel: 'artifactshare.com/a/demo',
      fontKv: env.SLACK_PREVIEW_FONT_KV,
    })
  })

  test('rejects share cards without a title', async () => {
    const response = await ogImage.fetch(
      workerRequest('https://og-image.artifactshare.internal/share'),
      env,
    )

    expect(response.status).toBe(400)
    expect(renderShareOgImageMock).not.toHaveBeenCalled()
  })

  test('renders an updates entry card from query parameters', async () => {
    const response = await ogImage.fetch(
      workerRequest(
        'https://og-image.artifactshare.internal/updates-entry?title=Demo&url=artifactshare.com%2Fupdates%2Fdemo&lang=ja',
      ),
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(renderUpdatesEntryOgImageMock).toHaveBeenCalledWith({
      title: 'Demo',
      locale: 'ja',
      urlLabel: 'artifactshare.com/updates/demo',
      fontKv: env.SLACK_PREVIEW_FONT_KV,
    })
  })

  test('rejects updates entry cards without a title', async () => {
    const response = await ogImage.fetch(
      workerRequest(
        'https://og-image.artifactshare.internal/updates-entry?url=artifactshare.com%2Fupdates%2Fdemo',
      ),
      env,
    )

    expect(response.status).toBe(400)
    expect(renderUpdatesEntryOgImageMock).not.toHaveBeenCalled()
  })

  test('renders the dedicated handoff card with the requested locale', async () => {
    const response = await ogImage.fetch(
      workerRequest(
        'https://og-image.artifactshare.internal/private-mobile-design-handoff?lang=ja',
      ),
      env,
    )

    expect(response.status).toBe(200)
    expect(renderPrivateMobileDesignHandoffOgImageMock).toHaveBeenCalledWith(
      'ja',
      env.SLACK_PREVIEW_FONT_KV,
    )
  })

  test('returns 404 for an unknown path', async () => {
    const response = await ogImage.fetch(
      workerRequest('https://og-image.artifactshare.internal/nope'),
      env,
    )

    expect(response.status).toBe(404)
  })
})

function workerRequest(input: string, init?: RequestInit) {
  return new Request(input, init) as Request<
    unknown,
    IncomingRequestCfProperties<unknown>
  >
}
