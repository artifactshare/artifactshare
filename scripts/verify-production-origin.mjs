#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const defaultBaseUrl = 'https://artifactshare.com'
const defaultTimeoutMs = 10_000
const defaultRetryDelayMs = 15_000

const defaultChecks = [
  { name: 'home', path: '/', status: 200, contentType: 'text/html' },
  {
    name: 'robots',
    path: '/robots.txt',
    status: 200,
    contentType: 'text/plain',
    includes: 'User-agent',
  },
  {
    name: 'sitemap',
    path: '/sitemap.xml',
    status: 200,
    contentType: 'application/xml',
    includes: '<urlset',
  },
  {
    name: 'agent-json',
    path: '/.well-known/agent.json',
    status: 200,
    contentType: 'application/json',
  },
  {
    name: 'openapi-json',
    path: '/openapi.json',
    status: 200,
    contentType: 'application/json',
  },
  { name: 'llms', path: '/llms.txt', status: 200, contentType: 'text/plain' },
  {
    name: 'pricing',
    path: '/pricing.md',
    status: 200,
    contentType: 'text/markdown',
  },
  {
    name: 'favicon',
    path: '/favicon.svg',
    status: 200,
    contentType: 'image/svg+xml',
    includes: '<svg',
  },
]

function usage() {
  return `Usage: node scripts/verify-production-origin.mjs [options]

Options:
  --base-url <url>      Target origin. Default: ${defaultBaseUrl}
  --timeout-ms <ms>     Per-request timeout. Default: ${defaultTimeoutMs}
  --retries <count>     Retry failed check sets. Default: 0
  --retry-delay-ms <ms> Delay between retries. Default: ${defaultRetryDelayMs}
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    baseUrl: defaultBaseUrl,
    retries: 0,
    retryDelayMs: defaultRetryDelayMs,
    timeoutMs: defaultTimeoutMs,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (
      !['--base-url', '--timeout-ms', '--retries', '--retry-delay-ms'].includes(
        arg,
      )
    )
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    index += 1
    if (arg === '--base-url') options.baseUrl = value
    if (arg === '--retries') options.retries = Number(value)
    if (arg === '--retry-delay-ms') options.retryDelayMs = Number(value)
    if (arg === '--timeout-ms') options.timeoutMs = Number(value)
  }
  if (!Number.isInteger(options.retries) || options.retries < 0)
    throw new Error('Invalid --retries. Use a non-negative integer.')
  if (!Number.isInteger(options.retryDelayMs) || options.retryDelayMs <= 0)
    throw new Error('Invalid --retry-delay-ms. Use a positive integer.')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('Invalid --timeout-ms. Use a positive integer.')
  return options
}

function normalizeBaseUrl(value) {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/u, '')
}

function checkResponse({ check, response, contentType, body }) {
  const failures = []
  if (response.status !== check.status)
    failures.push(`expected status ${check.status}, got ${response.status}`)
  if (check.contentType && !contentType.includes(check.contentType))
    failures.push(`expected content-type including ${check.contentType}`)
  if (check.includes && !body.includes(check.includes))
    failures.push(`expected body to include ${check.includes}`)
  return failures
}

async function runChecks({
  baseUrl,
  checks = defaultChecks,
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const results = []
  for (const check of checks) {
    const url = new URL(check.path, `${normalizedBaseUrl}/`)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = performance.now()
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: '*/*', 'User-Agent': 'artifactshare-smoke/1.0' },
        redirect: 'follow',
        signal: controller.signal,
      })
      const body = await response.text()
      const failures = checkResponse({
        check,
        response,
        contentType: response.headers.get('content-type') ?? '',
        body,
      })
      results.push({
        name: check.name,
        url: url.toString(),
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        ok: failures.length === 0,
        failures,
      })
    } catch (error) {
      results.push({
        name: check.name,
        url: url.toString(),
        status: null,
        durationMs: Math.round(performance.now() - startedAt),
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      clearTimeout(timeout)
    }
  }
  return results
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runChecksWithRetries({
  retries = 0,
  retryDelayMs = defaultRetryDelayMs,
  waitImpl = delay,
  ...options
}) {
  let results = []
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    results = await runChecks(options)
    if (results.every((result) => result.ok))
      return { attempt: attempt + 1, results }
    if (attempt < retries) await waitImpl(retryDelayMs)
  }
  return { attempt: retries + 1, results }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return console.log(usage())
  const { attempt, results } = await runChecksWithRetries(options)
  if (options.retries > 0)
    console.log(`attempt ${attempt}/${options.retries + 1}`)
  for (const result of results) {
    console.log(
      `${result.ok ? 'ok' : 'fail'} ${result.name} ${result.status ?? 'error'} ${result.durationMs}ms`,
    )
    for (const failure of result.failures) console.log(`  ${failure}`)
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })

export {
  defaultChecks,
  normalizeBaseUrl,
  parseArgs,
  runChecks,
  runChecksWithRetries,
}
