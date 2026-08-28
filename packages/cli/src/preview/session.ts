import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  PREVIEW_SESSION_ENDPOINT,
  isPreviewSessionIdentity,
} from './contract.js'

export interface PreviewSessionFile {
  schema_version: 1
  session_id: string
  realpath: string
  port: number
  share_port: number
  pid: number
  started_at: string
}

export type PreviewRealpathResult =
  | { ok: true; realpath: string }
  | { ok: false; reason: 'not_found' }

export type LiveSessionResult =
  | { state: 'live'; session: PreviewSessionFile }
  | { state: 'none'; reclaimed?: boolean }

export function previewsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ARTIFACTSHARE_CONFIG_HOME
  const base =
    override !== undefined && override !== ''
      ? override
      : join(homedir(), '.artifactshare')
  return join(base, 'previews')
}

export function sessionIdForPath(realpath: string): string {
  return createHash('sha256').update(realpath).digest('hex').slice(0, 16)
}

export function sessionFilePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(previewsDir(env), `${sessionId}.json`)
}

export function annotationsFilePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(previewsDir(env), `annotations-${sessionId}.json`)
}

export function previewRealpath(input: string): PreviewRealpathResult {
  try {
    return { ok: true, realpath: realpathSync(input) }
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}

export function writeSessionFile(
  session: Omit<PreviewSessionFile, 'schema_version'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = previewsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = sessionFilePath(session.session_id, env)
  const payload: PreviewSessionFile = { schema_version: 1, ...session }
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return path
}

export function readSessionFile(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): PreviewSessionFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sessionFilePath(sessionId, env), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (
    record.schema_version !== 1 ||
    typeof record.session_id !== 'string' ||
    typeof record.realpath !== 'string' ||
    typeof record.port !== 'number' ||
    typeof record.share_port !== 'number' ||
    typeof record.pid !== 'number' ||
    typeof record.started_at !== 'string'
  ) {
    return null
  }
  return parsed as PreviewSessionFile
}

export function removeSessionFile(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  rmSync(sessionFilePath(sessionId, env), { force: true })
}

export async function resolveLiveSession(
  filePath: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveSessionResult> {
  const resolved = previewRealpath(filePath)
  if (!resolved.ok) return { state: 'none' }
  const sessionId = sessionIdForPath(resolved.realpath)
  const session = readSessionFile(sessionId, env)
  if (!session) return { state: 'none' }

  let identity: unknown = null
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${session.port}${PREVIEW_SESSION_ENDPOINT}`,
      { signal: AbortSignal.timeout(1000) },
    )
    if (response.ok) identity = await response.json()
  } catch {
    identity = null
  }

  if (
    isPreviewSessionIdentity(identity) &&
    identity.session_id === session.session_id &&
    identity.realpath === session.realpath &&
    identity.share_port === session.share_port
  ) {
    return { state: 'live', session }
  }

  // Stale: reclaim the session file, keep the annotations file for later.
  removeSessionFile(sessionId, env)
  return { state: 'none', reclaimed: true }
}
