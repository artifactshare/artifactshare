import { beforeEach, describe, expect, test, vi } from 'vitest'

const limitMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const suggestRecipientsMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { RECIPIENT_SUGGESTIONS_RATELIMIT: { limit: limitMock } },
}))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/middleware/context', () => ({ requireUser: requireUserMock }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/recipient-suggestions.server', () => ({
  suggestRecipients: suggestRecipientsMock,
}))

import { action } from './api.share-recipient-candidates'

describe('/api/share-recipient-candidates', () => {
  beforeEach(() => {
    limitMock.mockReset().mockResolvedValue({ success: true })
    requireUserMock.mockReset().mockReturnValue({ id: 'owner' })
    suggestRecipientsMock.mockReset().mockResolvedValue({
      kind: 'ok',
      candidates: [],
    })
  })

  test('rejects malformed and oversized bodies', async () => {
    const response = await call({
      query: 'a'.repeat(101),
      pendingEmails: [],
      context: { kind: 'upload' },
    })
    expect(response.status).toBe(400)
    expect(limitMock).not.toHaveBeenCalled()
  })

  test('returns no candidates below the threshold without querying the database', async () => {
    const response = await call({
      query: 'a',
      pendingEmails: [],
      context: { kind: 'upload' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ candidates: [] })
    expect(suggestRecipientsMock).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  test('enforces the per-user rate limit', async () => {
    limitMock.mockResolvedValue({ success: false })
    const response = await call({
      query: 'am',
      pendingEmails: [],
      context: { kind: 'shareable', id: 'shareable-1' },
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(suggestRecipientsMock).not.toHaveBeenCalled()
  })

  test('fails closed when the rate limiter is unavailable', async () => {
    limitMock.mockRejectedValue(new Error('binding unavailable'))
    const response = await call({
      query: 'am',
      pendingEmails: [],
      context: { kind: 'shareable', id: 'shareable-1' },
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(suggestRecipientsMock).not.toHaveBeenCalled()
  })

  test('does not reveal a forbidden context', async () => {
    suggestRecipientsMock.mockResolvedValue({ kind: 'forbidden' })
    const response = await call({
      query: 'am',
      pendingEmails: [],
      context: { kind: 'shareable', id: 'shareable-1' },
    })
    expect(response.status).toBe(403)
  })
})

function call(body: unknown) {
  return action({
    request: new Request(
      'https://artifactshare.test/api/share-recipient-candidates',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    context: new Map(),
  } as never)
}
