import { beforeEach, describe, expect, test, vi } from 'vitest'
import { linkDomainContext } from '~/middleware/context'

const recordLinkReport = vi.hoisted(() => vi.fn())
vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-hmac',
  },
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/link-reports.server', () => ({ recordLinkReport }))

import {
  action,
  loader,
  REPORT_COOLDOWN_CAPACITY,
  ReportCooldownCache,
} from './api.shareables.$id.report'

function request(
  body: unknown,
  origin = 'https://abc123def4.artifactshare.link',
  artifactId = 'abc123def4',
  viewerIp = '203.0.113.10',
) {
  return new Request(`${origin}/api/shareables/${artifactId}/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': viewerIp,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function context(shareableId = 'abc123def4') {
  return new Map([[linkDomainContext, { shareableId }]])
}

describe('link report route', () => {
  beforeEach(() => {
    recordLinkReport.mockReset().mockResolvedValue('recorded')
  })

  test('exports a 405 loader', async () => {
    const response = loader()
    expect(response.status).toBe(405)
    await expect(response.text()).resolves.toBe('Method Not Allowed')
  })

  test('keeps a 4,096-entry least-recently-used cooldown cache', () => {
    expect(REPORT_COOLDOWN_CAPACITY).toBe(4_096)
    const cache = new ReportCooldownCache(2)
    cache.set('oldest', 1)
    cache.set('recent', 2)
    expect(cache.get('oldest')).toBe(1)
    cache.set('new', 3)

    expect(cache.get('recent')).toBeUndefined()
    expect(cache.get('oldest')).toBe(1)
    expect(cache.get('new')).toBe(3)
  })

  test('accepts a reason and trimmed optional note', async () => {
    const response = await action({
      request: request({ reason: 'phishing', note: '  suspicious  ' }),
      params: { id: 'abc123def4' },
      context: context(),
    } as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(recordLinkReport).toHaveBeenCalledWith({}, 'abc123def4', {
      reason: 'phishing',
      note: 'suspicious',
      viewerUrl: 'https://abc123def4.artifactshare.link/',
    })
  })

  test.each([
    ['{', 400],
    [{ reason: 'spam' }, 400],
    [{ reason: 'other', note: 'x'.repeat(501) }, 400],
  ])('rejects invalid report input', async (body, status) => {
    const response = await action({
      request: request(body),
      params: { id: 'abc123def4' },
      context: context(),
    } as never)
    expect(response.status).toBe(status)
    expect(recordLinkReport).not.toHaveBeenCalled()
  })

  test('returns 404 when the artifact is not currently link-shared', async () => {
    recordLinkReport.mockResolvedValue('not-found')
    const artifactId = 'missing123'
    const response = await action({
      request: request(
        { reason: 'other' },
        `https://${artifactId}.artifactshare.link`,
        artifactId,
      ),
      params: { id: artifactId },
      context: context(artifactId),
    } as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not-found' })
  })

  test('rejects a cross-origin request before the database call', async () => {
    const crossOrigin = request({ reason: 'other' })
    crossOrigin.headers.set('Origin', 'https://evil.example')
    const response = await action({
      request: crossOrigin,
      params: { id: 'abc123def4' },
      context: context(),
    } as never)
    expect(response.status).toBe(403)
    expect(recordLinkReport).not.toHaveBeenCalled()
  })

  test('returns 404 on the apex', async () => {
    const response = await action({
      request: request({ reason: 'other' }, 'https://artifactshare.com'),
      params: { id: 'abc123def4' },
      context: new Map(),
    } as never)
    expect(response.status).toBe(404)
    expect(recordLinkReport).not.toHaveBeenCalled()
  })

  test('returns 404 when the link host belongs to a different artifact', async () => {
    const response = await action({
      request: request({ reason: 'other' }),
      params: { id: 'abc123def4' },
      context: context('other12345'),
    } as never)
    expect(response.status).toBe(404)
    expect(recordLinkReport).not.toHaveBeenCalled()
  })

  test('suppresses repeated reports for the same artifact during the cooldown', async () => {
    const artifactId = 'repeat1234'
    const args = {
      params: { id: artifactId },
      context: context(artifactId),
    }
    const first = await action({
      ...args,
      request: request(
        { reason: 'phishing' },
        `https://${artifactId}.artifactshare.link`,
        artifactId,
      ),
    } as never)
    const second = await action({
      ...args,
      request: request(
        { reason: 'malware' },
        `https://${artifactId}.artifactshare.link`,
        artifactId,
      ),
    } as never)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(recordLinkReport).toHaveBeenCalledTimes(1)
  })

  test('does not suppress distinct viewers of the same artifact', async () => {
    const artifactId = 'viewers123'
    const origin = `https://${artifactId}.artifactshare.link`
    const args = {
      params: { id: artifactId },
      context: context(artifactId),
    }
    await action({
      ...args,
      request: request(
        { reason: 'phishing' },
        origin,
        artifactId,
        '203.0.113.20',
      ),
    } as never)
    await action({
      ...args,
      request: request(
        { reason: 'malware' },
        origin,
        artifactId,
        '203.0.113.21',
      ),
    } as never)
    expect(recordLinkReport).toHaveBeenCalledTimes(2)
  })
})
