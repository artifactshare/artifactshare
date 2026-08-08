import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultChecks,
  normalizeBaseUrl,
  parseArgs,
  runChecks,
  runChecksWithRetries,
} from './verify-production-origin.mjs'

test('covers the public production surface', () => {
  assert.deepEqual(
    defaultChecks.map(({ path }) => path),
    [
      '/',
      '/robots.txt',
      '/sitemap.xml',
      '/.well-known/agent.json',
      '/openapi.json',
      '/llms.txt',
      '/pricing.md',
      '/favicon.svg',
    ],
  )
})

test('normalizes the target and parses retry options', () => {
  assert.equal(
    normalizeBaseUrl('https://artifactshare.com///?x=1#top'),
    'https://artifactshare.com',
  )
  assert.deepEqual(
    parseArgs([
      '--base-url',
      'https://example.test',
      '--timeout-ms',
      '2500',
      '--retries',
      '2',
      '--retry-delay-ms',
      '1000',
    ]),
    {
      baseUrl: 'https://example.test',
      retries: 2,
      retryDelayMs: 1000,
      timeoutMs: 2500,
    },
  )
})

test('checks status, content type, and body', async () => {
  const [result] = await runChecks({
    baseUrl: 'https://example.test',
    timeoutMs: 100,
    checks: [
      {
        name: 'robots',
        path: '/robots.txt',
        status: 200,
        contentType: 'text/plain',
        includes: 'User-agent',
      },
    ],
    fetchImpl: () =>
      new Response('nope', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      }),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.failures, [
    'expected status 200, got 503',
    'expected content-type including text/plain',
    'expected body to include User-agent',
  ])
})

test('retries the complete check set', async () => {
  const waits = []
  let calls = 0
  const result = await runChecksWithRetries({
    baseUrl: 'https://example.test',
    retries: 2,
    retryDelayMs: 123,
    timeoutMs: 100,
    waitImpl: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    checks: [{ name: 'home', path: '/', status: 200 }],
    fetchImpl: () => {
      calls += 1
      return new Response('ok', { status: calls === 1 ? 503 : 200 })
    },
  })
  assert.equal(result.attempt, 2)
  assert.equal(result.results[0].ok, true)
  assert.deepEqual(waits, [123])
})
