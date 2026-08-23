import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(
  resolve(import.meta.dirname, '../../packages/cli/package.json'),
)
const { Agent, fetch: undiciFetch } = require('undici')

export const COOKIE_NAMES = [
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
]

const SESSION_DATA_COOKIE_NAMES = [
  '__Secure-better-auth.session_data',
  'better-auth.session_data',
]

export function cookiesFromHeaders(headers) {
  const cookies = []
  for (const value of headers.getSetCookie?.() ?? []) {
    const pair = value.split(';')[0]?.trim() ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index)
    if (
      COOKIE_NAMES.includes(name) ||
      SESSION_DATA_COOKIE_NAMES.some(
        (dataName) => name === dataName || name.startsWith(`${dataName}.`),
      )
    )
      cookies.push({ name, value: pair.slice(index + 1) })
  }
  return cookies
}

export function cookieFromHeaders(headers) {
  return cookiesFromHeaders(headers).find((cookie) =>
    COOKIE_NAMES.includes(cookie.name),
  )
}

export function cookieHeader(cookies) {
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
}

const createDispatcher = () =>
  new Agent({ connect: { rejectUnauthorized: false } })

let dispatcher = createDispatcher()

export function appFetch(baseUrl, path, options = {}) {
  return undiciFetch(new URL(path, baseUrl), { dispatcher, ...options })
}

export async function closeAppFetch() {
  const closing = dispatcher
  dispatcher = createDispatcher()
  await closing.close()
}
