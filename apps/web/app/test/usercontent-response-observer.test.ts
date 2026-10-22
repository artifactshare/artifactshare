import { afterEach, expect, test, vi } from 'vitest'
import { createUsercontentResponseObserver } from './usercontent-response-observer'

const origin = 'https://a-abc123def4--v-7631.usercontent.example'
afterEach(() => vi.useRealTimers())

test('captures the cookie-blocked 403 document without automation response events', async () => {
  const observer = createUsercontentResponseObserver()
  const expected = {
    url: new URL(`${origin}/?__as_cookie_check=1`),
    status: 403,
    body: '<h1>Private static-site preview unavailable</h1>',
  }
  const response = await observer.during(
    ({ url }) =>
      url.origin === origin &&
      url.searchParams.get('__as_cookie_check') === '1',
    async () => {
      observer.record({
        url: new URL(`${origin}/?t=fixture`),
        status: 302,
        body: '',
      })
      observer.record({
        ...expected,
        url: new URL('https://other.usercontent.example/?__as_cookie_check=1'),
      })
      observer.record(expected)
      await Promise.resolve()
    },
  )
  expect(response).toBe(expected)
  expect(response.status).toBe(403)
  expect(response.body).toContain('Private static-site preview unavailable')
})

test('observes revocation for the exact requested authority and exposes unexpected success', async () => {
  const observer = createUsercontentResponseObserver()
  const url = new URL(`${origin}/?t=renewed-fixture`)
  for (const status of [401, 200]) {
    const expected = {
      url,
      status,
      body: status === 401 ? 'Invalid token' : '<h1>Unexpected content</h1>',
    }
    const response = await observer.during(
      (candidate) => candidate.url.href === url.href,
      async () => {
        observer.record({
          ...expected,
          url: new URL(`${origin}/?t=other-fixture`),
        })
        observer.record(expected)
        await Promise.resolve()
      },
    )
    // Do not filter by status: the caller must fail if revocation allows content.
    expect(response).toBe(expected)
    expect(response.status).toBe(status)
  }
})

test('requires navigation readiness even when the proxy already captured the response', async () => {
  const observer = createUsercontentResponseObserver()
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  let completed = false
  const pending = observer
    .during(
      () => true,
      () => readiness,
    )
    .then(() => {
      completed = true
    })
  observer.record({ url: new URL(origin), status: 403, body: 'blocked' })
  await Promise.resolve()
  expect(completed).toBe(false)
  ready()
  await pending
  expect(completed).toBe(true)
})

test('navigation failure removes the observer and its timeout', async () => {
  vi.useFakeTimers()
  const observer = createUsercontentResponseObserver()
  const match = vi.fn(() => true)
  await expect(
    observer.during(match, () =>
      Promise.reject(new Error('Navigation failed')),
    ),
  ).rejects.toThrow('Navigation failed')
  observer.record({ url: new URL(origin), status: 401, body: '' })
  expect(match).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('missing response fails within the existing timeout and releases the observer', async () => {
  vi.useFakeTimers()
  const observer = createUsercontentResponseObserver()
  const match = vi.fn(() => true)
  const failed = expect(
    observer.during(match, () => Promise.resolve()),
  ).rejects.toThrow('within 30000ms')
  await vi.advanceTimersByTimeAsync(30_000)
  await failed
  observer.record({ url: new URL(origin), status: 401, body: '' })
  expect(match).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
