import type { ViewerRateLimiter } from './viewer-rate-limit.server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  handleSandboxBlockReport,
  prepareSandboxBlockReport,
  reportSourceKey,
} from './sandbox-block-report.server'

const query = vi.hoisted(() => vi.fn(async () => ({ id: 'abc123def4' })))
const createDb = vi.hoisted(() =>
  vi.fn(() => {
    const chain = {
      selectFrom: () => chain,
      select: () => chain,
      where: () => chain,
      executeTakeFirst: query,
    }
    return chain
  }),
)
vi.mock('~/services/db.server', () => ({ createDb }))
const marker = {
  artifactId: 'abc123def4',
  failureType: 'forbidden',
  confirmedAt: '2026-07-04T00:00:00.000Z',
}
const json = JSON.stringify(marker)
const encoder = new TextEncoder()
// Keep IPv6 segments distinct from class-like numeric breakpoint literals.
const compressedIpv6 = ['2001', 'db8', '', '1'].join(':')
const expandedIpv6 = ['2001', '0db8', '0', '0', '0', '0', '0', '1'].join(':')
function request(
  body: BodyInit | null = json,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(
    'https://example.test/api/shareables/abc123def4/sandbox-block-report',
    {
      method: 'POST',
      headers: {
        Origin: 'https://example.test',
        'CF-Connecting-IP': '203.0.113.10',
        ...headers,
      },
      body,
      signal,
      duplex: 'half',
    } as RequestInit,
  )
}
function limiter(success = true) {
  return { limit: vi.fn(async () => ({ success })) }
}
function run(req: Request, binding: ViewerRateLimiter = limiter()) {
  return handleSandboxBlockReport(req, marker.artifactId, binding)
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('bounded report preparation', () => {
  test.each([undefined, '1', 'invalid', '-1'])(
    'counts actual bytes with length %s',
    async (length) => {
      const headers: Record<string, string> =
        length === undefined ? {} : { 'Content-Length': length }
      const parse = vi.spyOn(JSON, 'parse')
      const response = await run(request(json.padEnd(1025), headers))
      expect(response.status).toBe(413)
      expect(parse).not.toHaveBeenCalledWith(json.padEnd(1025))
      expect(createDb).not.toHaveBeenCalled()
    },
  )
  test('accepts exactly 1024 bytes after EOF and queries once', async () => {
    const binding = limiter()
    const response = await run(request(json.padEnd(1024)), binding)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: true })
    expect(binding.limit).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
  })
  test('cancels a declared oversized body without reading', async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    expect(
      (await run(request(body, { 'Content-Length': '1025' }))).status,
    ).toBe(413)
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
  test.each(['hang', 'reject', 'throw'])(
    'oversize cancellation may %s',
    async (mode) => {
      const cancel = vi.fn(() => {
        if (mode === 'throw') throw Error('cancel')
        if (mode === 'reject') return Promise.reject(Error('cancel'))
        return new Promise<void>(() => {})
      })
      const body = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(json.padEnd(1025)))
        },
        cancel,
      })
      expect((await run(request(body))).status).toBe(413)
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
      expect(createDb).not.toHaveBeenCalled()
    },
  )
  test('counts split UTF-8 bytes, not characters', async () => {
    const bytes = encoder.encode(
      json.slice(0, -1) + ',"extra":"' + 'é'.repeat(500) + '"}',
    )
    let offset = 0
    const cancel = vi.fn()
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(bytes.slice(offset, (offset += 31)))
      },
      cancel,
    })
    expect((await run(request(body))).status).toBe(413)
    expect(cancel).toHaveBeenCalledOnce()
    expect(createDb).not.toHaveBeenCalled()
  })
  test.each([
    '',
    '{',
    json + '!',
    json.slice(0, -1),
    '{"extra":"é"}',
    new Uint8Array([255]),
  ])('rejects complete malformed input %s', async (body) => {
    expect((await run(request(body))).status).toBe(400)
    expect(createDb).not.toHaveBeenCalled()
  })
  test('accepts chunk boundaries through the complete document', async () => {
    const bytes = encoder.encode(json)
    let offset = 0
    const body = new ReadableStream({
      pull(c) {
        if (offset === bytes.length) c.close()
        else c.enqueue(bytes.slice(offset, ++offset))
      },
    })
    expect((await run(request(body))).status).toBe(200)
    expect(body.locked).toBe(false)
  })
  test('times out an unfinished valid prefix and does not await cancellation', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(json))
      },
      cancel,
    })
    const result = run(request(body))
    await vi.advanceTimersByTimeAsync(2001)
    expect((await result).status).toBe(408)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(createDb).not.toHaveBeenCalled()
  })
  test.each(['before', 'during'])(
    'abort %s body read terminates',
    async (when) => {
      const controller = new AbortController()
      const cancel = vi.fn()
      let pulled!: () => void
      const started = new Promise<void>((resolve) => {
        pulled = resolve
      })
      const body = new ReadableStream(
        {
          pull() {
            pulled()
            return new Promise(() => {})
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      if (when === 'before') controller.abort()
      const result = run(request(body, {}, controller.signal))
      if (when === 'during') {
        await started
        controller.abort()
      }
      expect((await result).status).toBe(400)
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
      expect(createDb).not.toHaveBeenCalled()
    },
  )
  test.each([2, 3])(
    'observes abort between admission and body read at microtask depth %s',
    async (depth) => {
      const controller = new AbortController()
      const pull = vi.fn()
      const cancel = vi.fn()
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
      const req = request(body, {}, controller.signal)
      const binding = {
        limit: vi.fn(() => {
          const abortAfterMicrotasks = (remaining: number) => {
            if (remaining === 0) controller.abort()
            else queueMicrotask(() => abortAfterMicrotasks(remaining - 1))
          }
          abortAfterMicrotasks(depth)
          return Promise.resolve({ success: true })
        }),
      }
      const parse = vi.spyOn(JSON, 'parse')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const response = await run(req, binding)
      expect(response.status).toBe(400)
      expect(binding.limit).toHaveBeenCalledOnce()
      expect(pull).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
      expect(parse).not.toHaveBeenCalledWith('')
      expect(createDb).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      // Cross a native task boundary so Vitest observes unhandled rejections
      // from a deadline rejected before its first race is attached.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(await response.json()).toEqual({ error: 'invalid-payload' })
    },
  )
  test('read failure rejects without querying', async () => {
    const body = new ReadableStream({
      pull() {
        throw Error('read')
      },
    })
    expect((await run(request(body))).status).toBe(400)
    expect(body.locked).toBe(false)
    expect(createDb).not.toHaveBeenCalled()
  })
  test.each([
    undefined,
    {},
    { limit: () => ({}) },
    {
      limit: () => {
        throw Error('limit')
      },
    },
    { limit: () => Promise.reject(Error('limit')) },
  ])('fails closed for unavailable binding %s', async (binding) => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    const result = await prepareSandboxBlockReport(
      request(body),
      marker.artifactId,
      binding as never,
    )
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(503)
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(createDb).not.toHaveBeenCalled()
  })
  test('admission timeout observes late rejection', async () => {
    vi.useFakeTimers()
    let reject!: (reason: Error) => void
    const binding = {
      limit: () =>
        new Promise<{ success: boolean }>((_, r) => {
          reject = r
        }),
    }
    const result = run(request(), binding)
    await vi.advanceTimersByTimeAsync(1001)
    expect((await result).status).toBe(503)
    reject(Error('late'))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    expect(createDb).not.toHaveBeenCalled()
  })
  test('exhaustion precedes body parsing and returns private retry response', async () => {
    const binding = limiter(false)
    const response = await run(request('{'), binding)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(createDb).not.toHaveBeenCalled()
  })
  test.each([
    '',
    '203.0.113.10:80',
    '203.0.113.10, 203.0.113.11',
    'unknown',
    `[${compressedIpv6}]`,
    'fe80::1%lo',
  ])('rejects invalid ingress identity %s', async (ip) => {
    const binding = limiter()
    expect(
      (
        await run(
          request(json, {
            'CF-Connecting-IP': ip,
            'X-Forwarded-For': '203.0.113.10',
          }),
          binding,
        )
      ).status,
    ).toBe(503)
    expect(binding.limit).not.toHaveBeenCalled()
  })
  test('canonicalizes equivalent IPv6 and keys independently of artifact', async () => {
    expect(
      reportSourceKey(request(json, { 'CF-Connecting-IP': expandedIpv6 })),
    ).toBe(`[${compressedIpv6}]`)
    expect(
      reportSourceKey(request(json, { 'CF-Connecting-IP': compressedIpv6 })),
    ).toBe(`[${compressedIpv6}]`)
    const binding = limiter(false)
    await prepareSandboxBlockReport(request(), 'abc123def4', binding)
    await prepareSandboxBlockReport(request(), 'link123abc', binding)
    expect(binding.limit.mock.calls).toEqual([
      [{ key: '203.0.113.10' }],
      [{ key: '203.0.113.10' }],
    ])
  })
})

// Exercise the installed router's path normalization, not just the guard's regex.
import { createRequestHandler, type ServerBuild } from 'react-router'
import { reportArtifactId } from './sandbox-block-report.server'
test.each([
  '/api/shareables/abc123def4/sandbox-block-report',
  '/api/shareables/abc123def4/sandbox-block-report.data',
  '/api/shareables/abc123def4/sandbox-block-report/',
  '/api/shareables/abc123def4/sandbox-block-report/_.data',
  '/API/SHAREABLES/abc123def4/SANDBOX-BLOCK-REPORT',
  '/%61pi/shareables/abc123def4/sandbox-block-report',
])('protects every router-supported alias %s', async (path) => {
  const action = vi.fn(() => new Response('accepted'))
  const handler = createRequestHandler(
    {
      entry: { module: { default: () => new Response('document') } },
      routes: {
        report: {
          id: 'report',
          path: 'api/shareables/:id/sandbox-block-report',
          module: { action },
        },
      },
      assets: { routes: {}, entry: { module: '' }, url: '', version: 'test' },
      publicPath: '/',
      assetsBuildDirectory: 'build/client',
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
    } as unknown as ServerBuild,
    'test',
  )
  await handler(
    new Request(`https://example.test${path}`, { method: 'POST', body: '{}' }),
  )
  expect(action).toHaveBeenCalledOnce()
  expect(reportArtifactId(path)).toBe('abc123def4')
})

test.each(['empty', 'trickle'])(
  'total deadline terminates %s streams',
  async (mode) => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(mode === 'empty' ? new Uint8Array() : encoder.encode(' '))
      },
      cancel,
    })
    const pending = run(request(body))
    expect((await pending).status).toBe(mode === 'empty' ? 408 : 413)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(createDb).not.toHaveBeenCalled()
  },
  10_000,
)

test('abort during admission cancels without waiting for the limiter', async () => {
  const controller = new AbortController()
  const binding = {
    limit: vi.fn(() => {
      controller.abort()
      return new Promise<{ success: boolean }>(() => {})
    }),
  }
  expect(
    (await run(request(json, {}, controller.signal), binding)).status,
  ).toBe(400)
  expect(createDb).not.toHaveBeenCalled()
})

import { finishSandboxBlockReport } from './sandbox-block-report.server'
test('abort between preparation and lookup prevents D1', async () => {
  const controller = new AbortController()
  const req = request(json, {}, controller.signal)
  const prepared = await prepareSandboxBlockReport(
    req,
    marker.artifactId,
    limiter(),
  )
  expect(prepared).not.toBeInstanceOf(Response)
  controller.abort()
  if (prepared instanceof Response) throw Error('Expected prepared report')
  expect((await finishSandboxBlockReport(req, prepared)).status).toBe(400)
  expect(createDb).not.toHaveBeenCalled()
})

test('unknown descendants and internal duplicate separators are not report routes', () => {
  expect(
    reportArtifactId('/api/shareables/abc123def4/sandbox-block-report/extra'),
  ).toBeNull()
  expect(
    reportArtifactId('/api//shareables/abc123def4/sandbox-block-report'),
  ).toBeNull()
})

test('cooldown expires and log suppression stays bounded', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const start = Date.now() + 120_000
  const now = vi.spyOn(Date, 'now').mockReturnValue(start)
  await run(request())
  warn.mockClear()
  await run(request())
  expect(warn).not.toHaveBeenCalled()
  now.mockReturnValue(start + 60_000)
  await run(request())
  expect(warn).toHaveBeenCalledOnce()
  // Fill beyond the existing 512-key bound; the first key must be evicted.
  for (let index = 0; index < 513; index++) {
    const artifactId = index.toString(36).padStart(10, '0')
    const req = request(JSON.stringify({ ...marker, artifactId }))
    await handleSandboxBlockReport(req, artifactId, limiter())
  }
  warn.mockClear()
  await run(request())
  expect(warn).toHaveBeenCalledOnce()
})
