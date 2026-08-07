import { describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  env: {} as { OPENAI_APPS_CHALLENGE_TOKEN?: string },
}))

vi.mock('cloudflare:workers', () => ({ env: h.env }))

import { loader } from './[.]well-known.openai-apps-challenge'

describe('/.well-known/openai-apps-challenge route', () => {
  test('returns the token as plain text without caching', async () => {
    h.env.OPENAI_APPS_CHALLENGE_TOKEN = 'challenge-token'

    const response = loader()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('challenge-token')
    expect(response.headers.get('Content-Type')).toBe(
      'text/plain; charset=utf-8',
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  test('returns 404 when the token is not configured', () => {
    delete h.env.OPENAI_APPS_CHALLENGE_TOKEN

    expect(loader().status).toBe(404)
  })

  test('trims surrounding whitespace from the configured token', async () => {
    h.env.OPENAI_APPS_CHALLENGE_TOKEN = ' challenge-token\n'

    expect(await loader().text()).toBe('challenge-token')
  })

  test('returns 404 when the token is whitespace only', () => {
    h.env.OPENAI_APPS_CHALLENGE_TOKEN = ' \n'

    expect(loader().status).toBe(404)
  })

  test('returns 404 when the token is empty', () => {
    h.env.OPENAI_APPS_CHALLENGE_TOKEN = ''

    expect(loader().status).toBe(404)
  })
})
