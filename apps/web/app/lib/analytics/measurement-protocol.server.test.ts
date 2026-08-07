import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isMeasurementProtocolConfigured,
  sendFirstArtifactPosted,
} from './measurement-protocol.server'

describe('isMeasurementProtocolConfigured', () => {
  it('is true only when both the measurement id and the api secret are set', () => {
    expect(
      isMeasurementProtocolConfigured({
        GA4_MEASUREMENT_ID: 'G-TEST',
        GA4_MP_API_SECRET: 'secret',
      }),
    ).toBe(true)
    expect(
      isMeasurementProtocolConfigured({ GA4_MEASUREMENT_ID: 'G-TEST' }),
    ).toBe(false)
    expect(
      isMeasurementProtocolConfigured({ GA4_MP_API_SECRET: 'secret' }),
    ).toBe(false)
    expect(isMeasurementProtocolConfigured({})).toBe(false)
  })
})

describe('sendFirstArtifactPosted', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not send when the measurement protocol is not configured (fail-closed)', async () => {
    await sendFirstArtifactPosted({
      env: { GA4_MEASUREMENT_ID: 'G-TEST' },
      userId: 'uid-hash',
      clientId: 'cid-hash',
      channel: 'cli',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the measurement id and api secret as separate query params and the event payload', async () => {
    await sendFirstArtifactPosted({
      env: { GA4_MEASUREMENT_ID: 'G-TEST', GA4_MP_API_SECRET: 'the-secret' },
      userId: 'uid-hash',
      clientId: 'cid-hash',
      channel: 'mcp',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    const requestUrl = new URL(
      url instanceof URL ? url.toString() : String(url),
    )
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      'https://www.google-analytics.com/mp/collect',
    )
    // Both must be present and independently readable — a single '?' separator
    // (instead of '&') would fold the api secret into the measurement id value.
    expect(requestUrl.searchParams.get('measurement_id')).toBe('G-TEST')
    expect(requestUrl.searchParams.get('api_secret')).toBe('the-secret')

    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body.client_id).toBe('cid-hash')
    expect(body.user_id).toBe('uid-hash')
    expect(body.events).toHaveLength(1)
    expect(body.events[0].name).toBe('first_artifact_posted')
    expect(body.events[0].params.channel).toBe('mcp')
  })

  it('sends only the hashed identifiers and channel — no other fields that could carry personal data', async () => {
    await sendFirstArtifactPosted({
      env: { GA4_MEASUREMENT_ID: 'G-TEST', GA4_MP_API_SECRET: 'the-secret' },
      userId: 'uid-hash',
      clientId: 'cid-hash',
      channel: 'web',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(Object.keys(body).sort()).toEqual(['client_id', 'events', 'user_id'])
    expect(Object.keys(body.events[0]).sort()).toEqual(['name', 'params'])
    expect(Object.keys(body.events[0].params).sort()).toEqual([
      'channel',
      'engagement_time_msec',
    ])
  })
})
