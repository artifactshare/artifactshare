import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  PREVIEW_SESSION_ENDPOINT,
  isPreviewSessionIdentity,
} from './contract.js'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import {
  defaultPreviewNotificationRegistration,
  isPreviewNotificationRegistration,
} from './notification.js'

/** What the running server will share under. A reuse that changed any of
 * these would publish from the wrong account or origin, so the values are
 * recorded rather than guessed from the new invocation's flags. The token is
 * kept only as a fingerprint; the session file never holds the secret. */
export interface PreviewSessionCredentials {
  profile: string | null
  base_url: string | null
  token_fingerprint: string | null
  /** Credentials also come from the working directory's config, so two starts
   * from different directories are different contexts even with equal flags. */
  cwd: string
}

export interface PreviewSessionFile {
  schema_version: 2
  session_id: string
  realpath: string
  port: number
  share_port: number
  pid: number
  started_at: string
  credentials: PreviewSessionCredentials
  agent_notification: PreviewAgentNotificationRegistration
}

export type PreviewRealpathResult =
  | { ok: true; realpath: string }
  | { ok: false; reason: 'not_found' }

export type LiveSessionResult =
  | { state: 'live'; session: PreviewSessionFile }
  /** The recorded session neither answered nor refused; it may still serve. */
  | { state: 'unverified'; session: PreviewSessionFile }
  | { state: 'none'; reclaimed?: boolean }

export function previewsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ARTIFACTSHARE_CONFIG_HOME
  const base =
    override !== undefined && override !== ''
      ? override
      : join(homedir(), '.artifactshare')
  return join(base, 'previews')
}

/** A recorded pid that still exists means the process is alive, even when its
 * port is not answering probes. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM'
  }
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export function sessionIdForPath(realpath: string): string {
  return createHash('sha256').update(realpath).digest('hex').slice(0, 16)
}

/** Session ids are the 16-hex prefix of a sha256; anything else could escape
 * the previews directory when interpolated into a path. */
export function isSessionId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value)
}

export function sessionFilePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isSessionId(sessionId)) {
    throw new Error('invalid preview session id')
  }
  return join(previewsDir(env), `${sessionId}.json`)
}

export function annotationsFilePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isSessionId(sessionId)) {
    throw new Error('invalid preview session id')
  }
  return join(previewsDir(env), `annotations-${sessionId}.json`)
}

export function previewRealpath(input: string): PreviewRealpathResult {
  try {
    return { ok: true, realpath: realpathSync(input) }
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}

/** A source deleted or renamed while its server runs has no realpath of its
 * own, but its directory usually still does, and the recorded identity was
 * built from the resolved path. */
export function previewIdentityPath(input: string): string {
  const real = previewRealpath(input)
  if (real.ok) return real.realpath
  const absolute = resolve(input)
  const parent = previewRealpath(dirname(absolute))
  return parent.ok ? join(parent.realpath, basename(absolute)) : absolute
}

export function writeSessionFile(
  session: Omit<PreviewSessionFile, 'schema_version'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = previewsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = sessionFilePath(session.session_id, env)
  const payload: PreviewSessionFile = { schema_version: 2, ...session }
  const temp = join(dir, `.session-${randomUUID()}.tmp`)
  writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
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
    (record.schema_version !== 1 && record.schema_version !== 2) ||
    typeof record.session_id !== 'string' ||
    typeof record.realpath !== 'string' ||
    typeof record.port !== 'number' ||
    typeof record.share_port !== 'number' ||
    typeof record.pid !== 'number' ||
    typeof record.started_at !== 'string' ||
    !isSessionCredentials(record.credentials)
  ) {
    return null
  }
  if (record.schema_version === 1) {
    return {
      schema_version: 2,
      session_id: record.session_id,
      realpath: record.realpath,
      port: record.port,
      share_port: record.share_port,
      pid: record.pid,
      started_at: record.started_at,
      credentials: record.credentials,
      agent_notification: {
        ...defaultPreviewNotificationRegistration(),
        registered_at: record.started_at,
      },
    }
  }
  if (!isPreviewNotificationRegistration(record.agent_notification)) {
    return null
  }
  return parsed as PreviewSessionFile
}

function isSessionCredentials(
  value: unknown,
): value is PreviewSessionCredentials {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const optional = (name: string): boolean =>
    record[name] === null || typeof record[name] === 'string'
  return (
    optional('profile') &&
    optional('base_url') &&
    optional('token_fingerprint') &&
    typeof record.cwd === 'string'
  )
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
  // The recorded path is the identity, not the file on disk: deleting or
  // renaming the source must not strand a running server that stop and next
  // still need to reach.
  const sessionId = sessionIdForPath(previewIdentityPath(filePath))
  const session = readSessionFile(sessionId, env)
  if (!session) return { state: 'none' }
  return await probeSession(session, fetchImpl, env)
}

/** Probe a record the caller already holds. `--session <id>` names one exactly,
 * and re-deriving its id from the recorded path would follow a symlink that has
 * since been repointed and miss the record the caller asked for. */
export async function probeSession(
  session: PreviewSessionFile,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveSessionResult> {
  const sessionId = session.session_id

  let identity: unknown = null
  // A timeout means the probe was inconclusive, not that the session is dead:
  // a preview busy rendering a large file can miss the deadline while still
  // serving. Only an answer from something that is not this session proves the
  // file is stale, so a timeout leaves the session file alone.
  let answered = false
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${session.port}${PREVIEW_SESSION_ENDPOINT}`,
      { signal: AbortSignal.timeout(2000) },
    )
    // Something answered on that port. Whether its body parses says nothing
    // about that, and letting a parse failure re-arm the timeout path would
    // leave a recycled port unverified forever.
    answered = true
    if (response.ok) identity = await response.json().catch(() => null)
  } catch (error) {
    identity = null
    answered = isConnectionRefused(error)
  }

  if (
    isPreviewSessionIdentity(identity) &&
    identity.session_id === session.session_id &&
    identity.realpath === session.realpath &&
    identity.share_port === session.share_port
  ) {
    return { state: 'live', session }
  }

  if (!answered) return { state: 'unverified', session }

  // Stale: reclaim the session file, keep the annotations file for later.
  removeSessionFile(sessionId, env)
  return { state: 'none', reclaimed: true }
}

/** A refused connection proves nothing listens on the recorded port. */
export function isConnectionRefused(error: unknown): boolean {
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause
    ?.code
  const code = (error as { code?: unknown } | null)?.code
  return causeCode === 'ECONNREFUSED' || code === 'ECONNREFUSED'
}

/** Claim the right to start a session for this path. The lock file is created
 * exclusively, so two `preview <same file>` invocations racing before either
 * writes its session file cannot both win and end up sharing one annotation
 * store. */
export function claimSessionStart(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; release: () => void } | { ok: false } {
  const dir = previewsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lockPath = join(dir, `${sessionId}.lock`)
  try {
    const handle = openSync(lockPath, 'wx', 0o600)
    // The pid lets forced cleanup tell an in-flight start from an abandoned
    // lock, so --force never frees a claim that is still being used.
    writeSync(handle, String(process.pid))
    closeSync(handle)
  } catch {
    return { ok: false }
  }
  return {
    ok: true,
    release: () => {
      rmSync(lockPath, { force: true })
    },
  }
}

/** Clears an abandoned claim and reports whether none remains. A live
 * claimant means a start is still in flight: freeing its lock would let a
 * second server open the same annotation store. */
export function releaseStaleClaim(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const lockPath = join(previewsDir(env), `${sessionId}.lock`)
  let recorded: string
  try {
    recorded = readFileSync(lockPath, 'utf8').trim()
  } catch {
    return true
  }
  const pid = Number.parseInt(recorded, 10)
  if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return false
  rmSync(lockPath, { force: true })
  return true
}
