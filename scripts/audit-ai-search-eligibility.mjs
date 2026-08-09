#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'https://artifactshare.com'
const DEFAULT_TIMEOUT_MS = 10_000
const SEARCH_BOT_USER_AGENT = 'OAI-SearchBot'

function normalizeBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Base URL must use http or https: ${value}`)
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function usage() {
  return `Usage: node scripts/audit-ai-search-eligibility.mjs [base-url]

Options:
  --base-url <url>  Target origin. Default: ${DEFAULT_BASE_URL}
  --timeout-ms <n>  Per-request timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}
  -h, --help       Show this help.`
}

function parseTimeoutMs(value) {
  const timeoutMs = Number(value)
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      `--timeout-ms must be a positive integer: ${value}\n\n${usage()}`,
    )
  }
  return timeoutMs
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let positionalBaseUrl

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') {
      return { help: true, baseUrl, timeoutMs }
    }
    if (arg === '--base-url') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --base-url\n\n${usage()}`)
      }
      baseUrl = value
      index += 1
      continue
    }
    if (arg === '--timeout-ms') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --timeout-ms\n\n${usage()}`)
      }
      timeoutMs = parseTimeoutMs(value)
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    }
    if (positionalBaseUrl) {
      throw new Error(`Unexpected argument: ${arg}\n\n${usage()}`)
    }
    positionalBaseUrl = arg
  }

  return { baseUrl: positionalBaseUrl ?? baseUrl, timeoutMs }
}

function decodeXml(value) {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, entity) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity],
  )
}

function parseAttributes(value) {
  const attributes = {}
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g
  for (const match of value.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeXml(match[3])
  }
  return attributes
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, `${baseUrl}/`).toString()
  } catch {
    return value
  }
}

function urlOnBaseOrigin(value, baseUrl) {
  try {
    const source = new URL(value)
    const targetBase = new URL(baseUrl)
    const target = new URL(source.pathname, targetBase.origin)
    target.search = source.search
    return target.toString()
  } catch {
    return value
  }
}

function sitemapUrlValue(value) {
  const decoded = decodeXml(value.trim())
  try {
    const url = new URL(decoded)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : decoded
  } catch {
    return decoded
  }
}

function parseSitemap(body) {
  const entries = []
  const urlPattern = /<url\b[^>]*>([\s\S]*?)<\/url>/gi
  const locPattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i
  const alternatePattern = /<xhtml:link\b([^>]*?)\/?\s*>/gi

  for (const urlMatch of body.matchAll(urlPattern)) {
    const content = urlMatch[1]
    const locMatch = locPattern.exec(content)
    const loc = locMatch ? sitemapUrlValue(locMatch[1]) : null
    const alternates = {}
    for (const linkMatch of content.matchAll(alternatePattern)) {
      const attributes = parseAttributes(linkMatch[1])
      const language = attributes.hreflang?.toLowerCase()
      if (attributes.rel?.toLowerCase() !== 'alternate' || !language) continue
      alternates[language] = sitemapUrlValue(attributes.href)
    }
    entries.push({ loc, alternates })
  }

  return entries
}

function parseHtmlMetadata(body, baseUrl) {
  let canonical = null
  const alternates = {}
  const noindexSources = []

  for (const match of body.matchAll(/<link\b([^>]*?)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    const rel = attributes.rel?.toLowerCase().split(/\s+/) ?? []
    if (rel.includes('canonical')) {
      canonical = absoluteUrl(attributes.href ?? '', baseUrl)
    }
    if (rel.includes('alternate') && attributes.hreflang) {
      alternates[attributes.hreflang.toLowerCase()] = absoluteUrl(
        attributes.href ?? '',
        baseUrl,
      )
    }
  }

  for (const match of body.matchAll(/<meta\b([^>]*?)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (
      attributes.name?.toLowerCase() === 'robots' &&
      hasNoindexDirective(attributes.content ?? '')
    ) {
      noindexSources.push(`meta robots: ${attributes.content}`)
    }
  }

  return { canonical, alternates, noindexSources }
}

function hasNoindexDirective(value) {
  return value.split(/[\s,]+/u).some((directive) => {
    const normalized = directive.toLowerCase()
    return normalized === 'noindex' || normalized === 'none'
  })
}

function headerNoindex(response) {
  const value = response.headers.get('x-robots-tag')
  return value && hasNoindexDirective(value) ? [`X-Robots-Tag: ${value}`] : []
}

function compareAlternates(expected, actual) {
  const mismatches = []
  const languages = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const language of [...languages].sort()) {
    if (!(language in expected)) {
      mismatches.push(`unexpected ${language} alternate ${actual[language]}`)
    } else if (!(language in actual)) {
      mismatches.push(
        `missing ${language} alternate (expected ${expected[language]})`,
      )
    } else if (expected[language] !== actual[language]) {
      mismatches.push(
        `${language} alternate is ${actual[language]}, expected ${expected[language]}`,
      )
    }
  }
  return mismatches
}

function compareLanguageSets(entries) {
  const mismatches = []
  const sitemapLocs = new Set(entries.map((entry) => entry.loc).filter(Boolean))
  const entriesByLoc = new Map()
  const enToJa = new Map()
  const jaToEn = new Map()
  const requiredLanguages = ['en', 'ja', 'x-default']

  for (const entry of entries) {
    if (!entry.loc) {
      mismatches.push('sitemap entry is missing <loc>')
      continue
    }
    entriesByLoc.set(entry.loc, entry)
    let pathname
    try {
      pathname = new URL(entry.loc).pathname
    } catch {
      mismatches.push(`${entry.loc}: invalid sitemap URL`)
      continue
    }
    if (pathname === '/') {
      for (const language of Object.keys(entry.alternates)) {
        mismatches.push(
          `${entry.loc}: standalone entry has unexpected ${language} alternate`,
        )
      }
      continue
    }
    const { en, ja, 'x-default': xDefault } = entry.alternates
    for (const language of requiredLanguages) {
      if (!entry.alternates[language]) {
        mismatches.push(`${entry.loc}: missing ${language} sitemap alternate`)
      }
    }
    if (!en || !ja || !xDefault) continue
    if (xDefault !== en) {
      mismatches.push(
        `${entry.loc}: x-default alternate must equal en alternate`,
      )
    }
    if (entry.loc === en) enToJa.set(en, ja)
    if (entry.loc === ja) jaToEn.set(ja, en)
    if (entry.loc !== en && entry.loc !== ja) {
      mismatches.push(`${entry.loc}: loc is not its en or ja alternate`)
    }
    if (!sitemapLocs.has(en)) {
      mismatches.push(`${entry.loc}: en alternate is not a sitemap loc (${en})`)
    }
    if (!sitemapLocs.has(ja)) {
      mismatches.push(`${entry.loc}: ja alternate is not a sitemap loc (${ja})`)
    }
  }

  const enKeys = new Set(enToJa.keys())
  const jaKeys = new Set(jaToEn.keys())
  for (const en of [...enKeys].sort()) {
    const ja = enToJa.get(en)
    if (!jaKeys.has(ja)) {
      mismatches.push(
        `English sitemap entry has no matching Japanese entry: ${en}`,
      )
    } else if (entriesByLoc.get(ja)?.alternates.en !== en) {
      mismatches.push(
        `English sitemap entry has non-reciprocal Japanese alternate: ${en} -> ${ja}`,
      )
    }
  }
  for (const ja of [...jaKeys].sort()) {
    const en = jaToEn.get(ja)
    if (!enKeys.has(en)) {
      mismatches.push(
        `Japanese sitemap entry has no matching English entry: ${ja}`,
      )
    } else if (entriesByLoc.get(en)?.alternates.ja !== ja) {
      mismatches.push(
        `Japanese sitemap entry has non-reciprocal English alternate: ${ja} -> ${en}`,
      )
    }
  }

  return mismatches
}

async function fetchBodyWithBot(fetchImpl, url, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html, application/xml;q=0.9, */*;q=0.8',
        'User-Agent': SEARCH_BOT_USER_AGENT,
      },
      redirect: 'manual',
      signal: controller.signal,
    })
    const body = await response.text()
    return { response, body }
  } finally {
    clearTimeout(timeout)
  }
}

export async function auditAiSearchEligibility({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive integer: ${timeoutMs}`)
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const sitemapUrl = new URL('/sitemap.xml', `${normalizedBaseUrl}/`).toString()
  const mismatches = []
  let sitemapResponse
  let sitemapBody = ''

  try {
    const result = await fetchBodyWithBot(fetchImpl, sitemapUrl, timeoutMs)
    sitemapResponse = result.response
    sitemapBody = result.body
    if (sitemapResponse.status < 200 || sitemapResponse.status >= 300) {
      mismatches.push(
        `${sitemapUrl}: expected HTTP 2xx, got ${sitemapResponse.status}`,
      )
    }
  } catch (error) {
    mismatches.push(`${sitemapUrl}: fetch failed: ${errorMessage(error)}`)
    return { baseUrl: normalizedBaseUrl, sitemapUrl, entries: [], mismatches }
  }

  const entries = parseSitemap(sitemapBody)
  if (entries.length === 0)
    mismatches.push(`${sitemapUrl}: no sitemap URLs found`)
  mismatches.push(...compareLanguageSets(entries))

  for (const entry of entries) {
    if (!entry.loc) continue
    let response
    let body = ''
    try {
      const result = await fetchBodyWithBot(
        fetchImpl,
        urlOnBaseOrigin(entry.loc, normalizedBaseUrl),
        timeoutMs,
      )
      response = result.response
      body = result.body
    } catch (error) {
      mismatches.push(`${entry.loc}: fetch failed: ${errorMessage(error)}`)
      continue
    }

    if (response.status < 200 || response.status >= 300) {
      mismatches.push(`${entry.loc}: expected HTTP 2xx, got ${response.status}`)
    }

    const metadata = parseHtmlMetadata(body, normalizedBaseUrl)
    const noindexSources = [
      ...headerNoindex(response),
      ...metadata.noindexSources,
    ]
    for (const source of noindexSources) {
      mismatches.push(`${entry.loc}: noindex present (${source})`)
    }
    if (!metadata.canonical) {
      mismatches.push(`${entry.loc}: missing self canonical`)
    } else if (metadata.canonical !== entry.loc) {
      mismatches.push(
        `${entry.loc}: canonical is ${metadata.canonical}, expected ${entry.loc}`,
      )
    }
    mismatches.push(
      ...compareAlternates(entry.alternates, metadata.alternates).map(
        (mismatch) => `${entry.loc}: ${mismatch}`,
      ),
    )
  }

  return { baseUrl: normalizedBaseUrl, sitemapUrl, entries, mismatches }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function printAudit(result) {
  console.log(
    `Audited ${result.entries.length} sitemap URLs from ${result.sitemapUrl}`,
  )
  if (result.mismatches.length === 0) {
    console.log('AI search eligibility audit passed')
    return
  }
  console.error(
    `AI search eligibility audit found ${result.mismatches.length} mismatch(es):`,
  )
  for (const mismatch of result.mismatches) console.error(`- ${mismatch}`)
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  const result = await auditAiSearchEligibility({
    baseUrl: options.baseUrl,
    fetchImpl: dependencies.fetchImpl ?? fetch,
    timeoutMs: dependencies.timeoutMs ?? options.timeoutMs,
  })
  printAudit(result)
  return result.mismatches.length === 0 ? 0 : 1
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectExecution) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      console.error(errorMessage(error))
      process.exitCode = 1
    })
}

export {
  compareAlternates,
  compareLanguageSets,
  normalizeBaseUrl,
  parseTimeoutMs,
  parseArgs,
  parseHtmlMetadata,
  parseSitemap,
}
