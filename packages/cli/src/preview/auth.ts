import {
  PREVIEW_AGENT_STATE_ENDPOINT,
  PREVIEW_SESSION_ENDPOINT,
} from './contract.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface PreviewAuth {
  control: string
  shell: string
  document: string
}
export function capability(): string {
  return randomBytes(32).toString('hex')
}
export function createPreviewAuth(): PreviewAuth {
  return { control: capability(), shell: capability(), document: capability() }
}
export function validCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
export function sameCapability(value: unknown, expected: string): boolean {
  return (
    validCapability(value) &&
    validCapability(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  )
}
export function bearer(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && /^Bearer [a-f0-9]{64}$/.test(value)
    ? value.slice(7)
    : null
}
export function authorizePreview(
  auth: PreviewAuth,
  credential: unknown,
  method: string,
  path: string,
): boolean {
  if (sameCapability(credential, auth.document))
    return method === 'GET' && path === '/artifact'
  if (sameCapability(credential, auth.control)) {
    return (
      (method === 'GET' &&
        [PREVIEW_SESSION_ENDPOINT, PREVIEW_AGENT_STATE_ENDPOINT].includes(
          path,
        )) ||
      (method === 'POST' &&
        [
          '/api/agent/next',
          '/api/agent/done',
          '/api/agent/reply',
          '/api/agent/stop',
        ].includes(path))
    )
  }
  if (!sameCapability(credential, auth.shell)) return false
  return (
    (method === 'GET' &&
      ['/', '/__preview/session', '/events', '/api/annotations'].includes(
        path,
      )) ||
    (method === 'POST' &&
      [
        '/api/agent/stop',
        '/api/popup',
        '/api/popup/revoke',
        '/api/popup/finish',
        '/api/annotations',
        '/api/annotations/submit',
        '/api/annotations/discard-drafts',
        '/api/annotations/anchor-state',
        '/api/annotations/orphan-discard',
      ].includes(path)) ||
    (method === 'POST' && /^\/api\/annotations\/[^/]+\/reopen$/.test(path)) ||
    (method === 'DELETE' && /^\/api\/annotations\/[^/]+$/.test(path))
  )
}
