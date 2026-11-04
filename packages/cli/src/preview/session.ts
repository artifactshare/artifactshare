import { pathToFileURL } from 'node:url'
import { validCapability } from './auth.js'
import { createHash, randomUUID } from 'node:crypto'
import {
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
import { isPreviewNotificationRegistration } from './notification.js'

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
  schema_version: 3
  /** Private bearer authority; never included in ready output. */
  auth?: { control: string; shell: string }
  launcher?: string
  /** Runtime-only marker: restart required, including schema 1/2 records. */
  legacy?: true
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
  /** A pre-authentication record must be restarted without HTTP fallback. */
  | { state: 'legacy'; session: PreviewSessionFile }
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
  const payload: PreviewSessionFile = { ...session, schema_version: 3 }
  const temp = join(dir, `.session-${randomUUID()}.tmp`)
  privateWrite(path, JSON.stringify(payload, null, 2), temp)
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
    (record.schema_version !== 1 &&
      record.schema_version !== 2 &&
      record.schema_version !== 3) ||
    typeof record.session_id !== 'string' ||
    record.session_id !== sessionId ||
    typeof record.realpath !== 'string' ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    typeof record.share_port !== 'number' ||
    !Number.isInteger(record.share_port) ||
    record.share_port < 1 ||
    record.share_port > 65535 ||
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.started_at !== 'string' ||
    !isSessionCredentials(record.credentials)
  ) {
    return null
  }
  if (record.schema_version === 1) {
    return {
      schema_version: 3,
      session_id: record.session_id,
      realpath: record.realpath,
      port: record.port,
      share_port: record.share_port,
      pid: record.pid,
      started_at: record.started_at,
      credentials: record.credentials,
      agent_notification: {
        provider: 'generic',
        transport: 'legacy',
        capability: 'manual',
        target: null,
        registered_at: record.started_at,
      },
      legacy: true,
    }
  }
  if (!isPreviewNotificationRegistration(record.agent_notification)) {
    return null
  }
  const auth = record.auth as Record<string, unknown> | undefined
  if (
    record.schema_version !== 3 ||
    !auth ||
    !validCapability(auth.control) ||
    !validCapability(auth.shell) ||
    auth.control === auth.shell ||
    typeof record.launcher !== 'string' ||
    !/^launcher-[a-f0-9-]+\.html$/.test(record.launcher)
  ) {
    return { ...(parsed as PreviewSessionFile), legacy: true }
  }
  return parsed as PreviewSessionFile
}

export function updateSessionNotificationRegistration(
  sessionId: string,
  registration: PreviewAgentNotificationRegistration,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const current = readSessionFile(sessionId, env)
  if (!current || current.pid !== process.pid) return
  writeSessionFile(
    {
      ...current,
      session_id: current.session_id,
      realpath: current.realpath,
      port: current.port,
      share_port: current.share_port,
      pid: current.pid,
      started_at: current.started_at,
      credentials: current.credentials,
      agent_notification: registration,
    },
    env,
  )
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

  if (session.legacy || !session.auth) return { state: 'legacy', session }
  let identity: unknown = null
  // A timeout means the probe was inconclusive, not that the session is dead:
  // a preview busy rendering a large file can miss the deadline while still
  // serving. Only an answer from something that is not this session proves the
  // file is stale, so a timeout leaves the session file alone.
  let answered = false
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${session.port}${PREVIEW_SESSION_ENDPOINT}`,
      {
        signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${session.auth.control}` },
      },
    )
    // Something answered on that port. Whether its body parses says nothing
    // about that, and letting a parse failure re-arm the timeout path would
    // leave a recycled port unverified forever.
    if (response.status === 401 || response.status === 403)
      return { state: 'unverified', session }
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

  // Serialize reclamation with publication. Another probe may have already
  // reclaimed this record and started a replacement while ours was in flight.
  const claim = claimSessionStart(sessionId, env)
  if (!claim.ok) return { state: 'unverified', session }
  try {
    const current = readSessionFile(sessionId, env)
    if (
      current &&
      (current.pid !== session.pid ||
        current.auth?.control !== session.auth.control ||
        current.started_at !== session.started_at)
    ) {
      return { state: 'unverified', session: current }
    }
    removeLauncher(session.launcher, env)
    removeSessionFile(sessionId, env)
    return { state: 'none', reclaimed: true }
  } finally {
    claim.release()
  }
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

/** Publish without ever opening the final directory entry for writing. */
export function privateWrite(
  path: string,
  contents: string,
  temp = join(dirname(path), `.private-${randomUUID()}.tmp`),
): void {
  let owned = false
  try {
    const fd = openSync(temp, 'wx', 0o600)
    owned = true
    try {
      writeFileSync(fd, contents)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } finally {
    if (owned) rmSync(temp, { force: true })
  }
}

export function writeLauncher(
  session: { port: number; auth?: { shell: string }; launcher?: string },
  env: NodeJS.ProcessEnv = process.env,
): { launcher: string; launcher_url: string } {
  if (!session.auth || !validCapability(session.auth.shell))
    throw new Error('Preview restart required')
  const dir = previewsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const launcher = session.launcher ?? `launcher-${randomUUID()}.html`
  if (!/^launcher-[a-f0-9-]+\.html$/.test(launcher))
    throw new Error('Invalid launcher')
  const path = join(dir, launcher)
  privateWrite(
    path,
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open preview</title><form method="post" action="http://127.0.0.1:${session.port}/__preview/launch"><input type="hidden" name="capability" value="${session.auth.shell}"><button>Open preview</button></form><script>document.forms[0].submit()</script>`,
  )
  return { launcher, launcher_url: pathToFileURL(path).href }
}
export function removeLauncher(
  launcher: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (launcher && /^launcher-[a-f0-9-]+\.html$/.test(launcher))
    rmSync(join(previewsDir(env), launcher), { force: true })
}
