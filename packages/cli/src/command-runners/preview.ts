import { readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { CliError, OutputMode, ParsedArgs } from '../types.js'
import { cliError, validationError } from '../errors.js'
import { writeFailure, writeSuccess, writeSuccessLine } from '../output.js'
import { openDeviceAuthorizationUrl } from '../process.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  type PreviewAgentNotificationProjection,
  type PreviewDoneItemInput,
  isPreviewDoneItemInput,
} from '../preview/contract.js'
import type { PreviewSessionCredentials } from '../preview/session.js'
import {
  annotationsFilePath,
  previewIdentityPath,
  previewRealpath,
  previewsDir,
  claimSessionStart,
  isConnectionRefused,
  isSessionId,
  probeSession,
  processAlive,
  readSessionFile,
  releaseStaleClaim,
  removeSessionFile,
  resolveLiveSession,
  sessionIdForPath,
  tokenFingerprint,
  updateSessionNotificationRegistration,
  writeSessionFile,
} from '../preview/session.js'
import { createPreviewStore } from '../preview/store.js'
import { startPreviewServer } from '../preview/server.js'
import {
  defaultPreviewNotificationRegistration,
  samePreviewNotificationRegistration,
} from '../preview/notification.js'
import {
  codexNotificationRegistration,
  createCodexQueueAdapter,
} from '../preview/codex-notification.js'
import {
  claudeNotificationRegistration,
  createClaudeChannelAdapter,
} from '../preview/claude-notification.js'
import {
  CURSOR_ACP_NOTIFICATION_TIMEOUT_MS,
  cursorNotificationRegistration,
  createCursorAcpAdapter,
} from '../preview/cursor-notification.js'

function previewNotificationForEnvironment() {
  const codex = codexNotificationRegistration()
  if (codex) {
    return {
      registration: codex,
      adapter:
        codex.capability === 'push' && codex.target !== null
          ? createCodexQueueAdapter(codex.target)
          : undefined,
      timeoutMs: undefined,
    }
  }
  const claude = claudeNotificationRegistration()
  if (claude) {
    return {
      registration: claude,
      adapter:
        claude.capability === 'push' && claude.target !== null
          ? createClaudeChannelAdapter(claude.target)
          : undefined,
      // The Channel bridge waits for Claude to call the acknowledgement tool.
      timeoutMs: claude.capability === 'push' ? 30_000 : undefined,
    }
  }
  const cursor = cursorNotificationRegistration()
  if (cursor) {
    return {
      registration: cursor,
      adapter:
        cursor.capability === 'push' && cursor.target !== null
          ? createCursorAcpAdapter(cursor.target)
          : undefined,
      timeoutMs:
        cursor.capability === 'push'
          ? CURSOR_ACP_NOTIFICATION_TIMEOUT_MS
          : undefined,
    }
  }
  return {
    registration: defaultPreviewNotificationRegistration(),
    adapter: undefined,
    timeoutMs: undefined,
  }
}

function sessionNotFoundError(target: string | null): CliError {
  return cliError({
    code: 'preview_session_not_found',
    message: 'No live preview session was found.',
    why: target
      ? `No running preview serves ${target}.`
      : 'No running preview session matches the request.',
    hint: 'Start one with: npm exec --yes --package=@artifactshare/cli -- artifactshare preview <file>',
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
  })
}

interface ResolvedTarget {
  port: number
  sessionId: string
  realpath: string
}

async function resolveTarget(
  parsed: ParsedArgs,
  allowLegacy = false,
): Promise<{ target: ResolvedTarget } | { error: CliError }> {
  const explicitSession =
    typeof parsed.options.session === 'string' ? parsed.options.session : null
  const positional = parsed.positionals[0]
  if (explicitSession !== null && positional !== undefined) {
    // The two selectors can name different previews, and silently preferring
    // one would let a stale session id redirect next, done, reply, or stop.
    return {
      error: validationError(
        'Pass a file or --session, not both.',
        'Drop one selector so the target is unambiguous.',
      ),
    }
  }
  if (explicitSession) {
    if (!isSessionId(explicitSession)) {
      return {
        error: validationError(
          'A session id is 16 hexadecimal characters.',
          'Copy the session value from the preview ready JSON.',
        ),
      }
    }
    const session = readSessionFile(explicitSession)
    if (!session) return { error: sessionNotFoundError(explicitSession) }
    const live = await probeSession(session)
    if (live.state === 'legacy') {
      if (allowLegacy) {
        return {
          target: {
            port: live.session.port,
            sessionId: live.session.session_id,
            realpath: live.session.realpath,
          },
        }
      }
      return {
        error: sessionUnverifiedError(live.session.realpath, true),
      }
    }
    if (live.state === 'unverified') {
      return {
        error: sessionUnverifiedError(
          live.session.realpath,
          live.session.legacy === true,
        ),
      }
    }
    if (live.state !== 'live') {
      return { error: sessionNotFoundError(explicitSession) }
    }
    return {
      target: {
        port: live.session.port,
        sessionId: live.session.session_id,
        realpath: live.session.realpath,
      },
    }
  }
  if (positional) {
    // The recorded path is the session's identity. A source deleted or renamed
    // while its server runs must still resolve, or stop and next can never
    // reach it again.
    const path = previewIdentityPath(positional)
    const live = await resolveLiveSession(path)
    if (live.state === 'legacy') {
      if (allowLegacy) {
        return {
          target: {
            port: live.session.port,
            sessionId: live.session.session_id,
            realpath: live.session.realpath,
          },
        }
      }
      return { error: sessionUnverifiedError(path, true) }
    }
    if (live.state === 'unverified') {
      return {
        error: sessionUnverifiedError(path, live.session.legacy === true),
      }
    }
    if (live.state !== 'live')
      return { error: sessionNotFoundError(positional) }
    return {
      target: {
        port: live.session.port,
        sessionId: live.session.session_id,
        realpath: live.session.realpath,
      },
    }
  }
  const dir = previewsDir()
  let candidates: string[] = []
  try {
    candidates = readdirSync(dir).filter(
      (name) => name.endsWith('.json') && !name.startsWith('annotations-'),
    )
  } catch {
    candidates = []
  }
  const liveSessions: ResolvedTarget[] = []
  const unverified: Array<{ realpath: string; legacy: boolean }> = []
  for (const name of candidates) {
    const session = readSessionFile(name.replace(/\.json$/, ''))
    if (!session) continue
    const live = await probeSession(session)
    if (live.state === 'live' || (live.state === 'legacy' && allowLegacy)) {
      liveSessions.push({
        port: live.session.port,
        sessionId: live.session.session_id,
        realpath: live.session.realpath,
      })
    } else if (live.state === 'legacy' || live.state === 'unverified') {
      unverified.push({
        realpath: live.session.realpath,
        legacy: live.session.legacy === true,
      })
    }
  }
  const only = liveSessions[0]
  if (liveSessions.length === 1 && only && unverified.length === 0) {
    return { target: only }
  }
  if (liveSessions.length === 1 && unverified.length > 0) {
    // A timed-out probe is inconclusive, so "the only live session" is not
    // established and picking it could route to the wrong preview.
    return {
      error: validationError(
        'A preview session could not be verified, so the target is ambiguous.',
        'Pass the file path or --session <id> to pick one.',
      ),
    }
  }
  if (unverified.length > 1) {
    return {
      error: validationError(
        'Multiple preview sessions could not be verified.',
        'Pass the file path or --session <id> to pick one.',
      ),
    }
  }
  if (liveSessions.length === 0) {
    // A probe that timed out proves nothing; reporting "no session" would send
    // the agent to a human when retrying is the correct next step.
    const wedged = unverified[0]
    if (unverified.length === 1 && wedged !== undefined) {
      return { error: sessionUnverifiedError(wedged.realpath, wedged.legacy) }
    }
    return { error: sessionNotFoundError(null) }
  }
  return {
    error: validationError(
      'Multiple preview sessions are live.',
      'Pass the file path or --session <id> to pick one.',
    ),
  }
}

/** Everything that decides which account a share uploads under: the flags, the
 * environment, and the directory whose config is discovered. */
function requestedCredentials(
  options: ParsedArgs['options'],
): PreviewSessionCredentials {
  const flag = (name: 'token' | 'profile' | 'baseUrl'): string | null =>
    typeof options[name] === 'string' ? options[name] : null
  const env = (name: string): string | null => {
    const value = process.env[name]
    return value !== undefined && value !== '' ? value : null
  }
  const token = flag('token') ?? env('ARTIFACTSHARE_TOKEN')
  return {
    profile: flag('profile'),
    base_url: flag('baseUrl') ?? env('ARTIFACTSHARE_BASE_URL'),
    token_fingerprint: token === null ? null : tokenFingerprint(token),
    cwd: process.cwd(),
  }
}

function sameCredentials(
  a: PreviewSessionCredentials,
  b: PreviewSessionCredentials,
): boolean {
  return (
    a.profile === b.profile &&
    a.base_url === b.base_url &&
    a.token_fingerprint === b.token_fingerprint &&
    a.cwd === b.cwd
  )
}

async function readAgentProjection(
  port: number,
  fallback: PreviewAgentNotificationProjection,
): Promise<PreviewAgentNotificationProjection> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/annotations`, {
      signal: AbortSignal.timeout(2000),
    })
    const body = (await response.json()) as Record<string, unknown>
    const agent = body.agent as Record<string, unknown> | undefined
    if (
      response.ok &&
      agent &&
      typeof agent.provider === 'string' &&
      typeof agent.transport === 'string' &&
      (agent.capability === 'push' ||
        agent.capability === 'wait' ||
        agent.capability === 'manual') &&
      [
        'waiting',
        'queued',
        'processing',
        'completed',
        'failed',
        'manual_required',
      ].includes(String(agent.state))
    ) {
      return agent as unknown as PreviewAgentNotificationProjection
    }
  } catch {
    // Reuse already verified the session identity. A transient projection read
    // must not turn a healthy preview into a duplicate server.
  }
  return fallback
}

function sessionIdOfPath(input: string): string {
  return sessionIdForPath(previewIdentityPath(input))
}

/** A start already in flight, reported wherever a second one would otherwise
 * end up sharing the first's annotation store. */
function startInProgressError(target: string): CliError {
  return cliError({
    code: 'preview_session_unverified',
    message: 'Another preview for this file is starting.',
    why: `A start is already in progress for ${target}.`,
    hint: 'Retry in a moment, or clear it with: npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop <file> --force',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

/** The session answered neither success nor refusal. Retrying is correct;
 * escalating to a human is not. */
function previewUnreachableError(target: string): CliError {
  return cliError({
    code: 'preview_session_unverified',
    message: 'The preview session did not respond.',
    why: `The request to the preview for ${target} timed out or was interrupted.`,
    hint: 'Retry in a moment. If it stays stuck, ask the user to stop that preview process, then clear the record with: npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop <file> --force',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

function sessionUnverifiedError(target: string, legacy = false): CliError {
  if (legacy) {
    return cliError({
      code: 'preview_session_unverified',
      message: 'This preview session must be restarted.',
      why: `The preview serving ${target} was started by a CLI without the current notification contract.`,
      hint: 'Stop that preview process, then start the preview again with the current CLI.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
    })
  }
  return cliError({
    code: 'preview_session_unverified',
    message: 'A preview session for this file could not be verified.',
    why: `A session is recorded for ${target} but it did not answer.`,
    hint: 'Retry in a moment. If it stays stuck, ask the user to stop that preview process, then clear the record with: npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop <file> --force',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

function previewRequestError(reason: unknown, target: string): CliError {
  const detail = typeof reason === 'string' ? reason : 'request_failed'
  if (detail === 'active_wait_conflict') {
    return cliError({
      code: 'preview_wait_conflict',
      message: 'Another preview wait already reserves this session.',
      why: `The preview serving ${target} accepts only one active long poll.`,
      hint: 'Use the existing wait, or retry after it returns or is cancelled.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
    })
  }
  return cliError({
    code: 'preview_request_failed',
    message: 'The preview server rejected the request.',
    why: `The preview serving ${target} answered with ${detail}.`,
    hint: 'Check the annotation payload, then retry against the same session.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
  })
}

async function agentApi(
  target: ResolvedTarget,
  path: string,
  payload: unknown,
  waitSeconds = 0,
): Promise<{ body: Record<string, unknown> } | { error: CliError }> {
  const request = await previewFetch(waitSeconds > 0)
  let response: Response
  try {
    response = await request(`http://127.0.0.1:${target.port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
      },
      body: JSON.stringify(payload ?? {}),
      // A wedged server must not hang the agent forever; long polls get the
      // requested wait plus slack, everything else a short ceiling.
      signal: AbortSignal.timeout(
        waitSeconds > 0 ? (waitSeconds + 30) * 1000 : 30_000,
      ),
    })
  } catch (error) {
    // A refused connection proves the server is gone; a timeout or reset only
    // proves this attempt failed, and telling the agent to escalate would end
    // a session that is still serving.
    if (isConnectionRefused(error)) {
      return { error: sessionNotFoundError(target.realpath) }
    }
    return { error: previewUnreachableError(target.realpath) }
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (response.status === 404 || response.status === 503) {
    return { error: sessionNotFoundError(target.realpath) }
  }
  if (!response.ok) {
    return {
      error: previewRequestError(body?.reason ?? body?.error, target.realpath),
    }
  }
  if (body === null) {
    return { error: sessionNotFoundError(target.realpath) }
  }
  return { body }
}

type PreviewFetch = (
  url: string,
  init: Record<string, unknown>,
) => Promise<Response>

let longPollRequest: PreviewFetch | null = null

/** `next --wait` can hold a response open for an hour, well past undici's 300s
 * default header timeout. undici's own fetch is used so that its Agent is
 * accepted; if the package cannot be loaded the global fetch still works, just
 * with the default deadline. */
async function previewFetch(longPoll: boolean): Promise<PreviewFetch> {
  if (!longPoll) return (url, init) => fetch(url, init as RequestInit)
  if (longPollRequest) return longPollRequest
  try {
    const undici = await import('undici')
    const dispatcher = new undici.Agent({ headersTimeout: 0, bodyTimeout: 0 })
    longPollRequest = (url, init) =>
      undici.fetch(url, { ...init, dispatcher } as Parameters<
        typeof undici.fetch
      >[1]) as unknown as Promise<Response>
  } catch {
    longPollRequest = (url, init) => fetch(url, init as RequestInit)
  }
  return longPollRequest
}

export async function runPreview(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'preview'
  const positional = parsed.positionals[0]
  if (!positional) {
    return writeFailure(
      command,
      validationError('Path is required.', 'Pass a .md or .html file.'),
      mode,
      1,
    )
  }
  const real = previewRealpath(positional)
  if (!real.ok) {
    return writeFailure(
      command,
      validationError(
        'Path was not found.',
        `Check the path and retry: ${positional}`,
      ),
      mode,
      1,
    )
  }
  if (!statSync(real.realpath, { throwIfNoEntry: false })?.isFile()) {
    return writeFailure(
      command,
      validationError(
        'Only a regular file can be previewed.',
        `Pass a single .md or .html file, not a directory: ${positional}`,
      ),
      mode,
      1,
    )
  }
  const lower = real.realpath.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.html')) {
    return writeFailure(
      command,
      validationError(
        'Only .md and .html files can be previewed.',
        'Pass a single Markdown or HTML file.',
      ),
      mode,
      1,
    )
  }
  const existing = await resolveLiveSession(real.realpath)
  const requestedNotification = previewNotificationForEnvironment()
  if (existing.state === 'legacy' || existing.state === 'unverified') {
    // Starting a second server here would give two processes the same
    // annotations file, and each save would discard the other's work.
    return writeFailure(
      command,
      sessionUnverifiedError(real.realpath, existing.session.legacy === true),
      mode,
      1,
    )
  }
  if (existing.state === 'live') {
    // The running server still holds the options it started with, so reusing
    // it under different credentials would share from the wrong account.
    // Repeating the same flags is the normal case and must still reuse.
    if (
      !sameCredentials(
        existing.session.credentials,
        requestedCredentials(parsed.options),
      )
    ) {
      return writeFailure(
        command,
        validationError(
          'The live preview was started with different credentials.',
          `Stop it first: npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop ${positional}`,
        ),
        mode,
        1,
      )
    }
    if (
      !samePreviewNotificationRegistration(
        existing.session.agent_notification,
        requestedNotification.registration,
      )
    ) {
      return writeFailure(
        command,
        validationError(
          'The live preview belongs to a different agent session.',
          `Stop it first: npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop ${positional}`,
        ),
        mode,
        1,
      )
    }
    const reusedUrl = `http://127.0.0.1:${existing.session.port}/`
    const reusedAgent = await readAgentProjection(existing.session.port, {
      provider: existing.session.agent_notification.provider,
      transport: existing.session.agent_notification.transport,
      capability: existing.session.agent_notification.capability,
      state: 'manual_required',
    })
    writeSuccessLine(
      command,
      {
        url: reusedUrl,
        session: existing.session.session_id,
        share_origin: `http://127.0.0.1:${existing.session.share_port}`,
        reused: true,
        agent: reusedAgent,
      },
      mode,
    )
    // Reusing a session is still a request to look at it, so the browser opens
    // unless the caller suppressed it — the same rule as a fresh start.
    if (parsed.options.noOpen !== true) {
      await openDeviceAuthorizationUrl(reusedUrl).catch(() => undefined)
    }
    return
  }
  const sessionId = sessionIdForPath(real.realpath)
  const claim = claimSessionStart(sessionId)
  if (!claim.ok) {
    // Another `preview` for this file is mid-start. Two servers would share
    // one annotation store and overwrite each other's saves.
    return writeFailure(command, startInProgressError(real.realpath), mode, 1)
  }
  let server: Awaited<ReturnType<typeof startPreviewServer>>
  let store: ReturnType<typeof createPreviewStore>
  let started: Awaited<ReturnType<typeof startPreviewServer>> | null = null
  try {
    store = createPreviewStore(annotationsFilePath(sessionId))
    server = await startPreviewServer({
      filePath: real.realpath,
      store,
      sessionId,
      notificationRegistration: requestedNotification.registration,
      ...(requestedNotification.adapter
        ? { notificationAdapter: requestedNotification.adapter }
        : {}),
      ...(requestedNotification.timeoutMs !== undefined
        ? { notificationTimeoutMs: requestedNotification.timeoutMs }
        : {}),
      onNotificationRegistrationChange(registration) {
        updateSessionNotificationRegistration(sessionId, registration)
      },
      cliOptions: parsed.options,
    })
    started = server
    writeSessionFile({
      session_id: sessionId,
      realpath: real.realpath,
      port: server.port,
      share_port: server.sharePort,
      pid: process.pid,
      started_at: new Date().toISOString(),
      credentials: requestedCredentials(parsed.options),
      agent_notification: server.notificationRegistration,
    })
  } catch (error) {
    // A failed start must leave nothing behind: neither the claim (every later
    // preview would report a start in progress) nor a bound server nobody can
    // reach, because no session file records it.
    claim.release()
    await started?.close().catch(() => undefined)
    throw error
  }
  claim.release()
  const url = `http://127.0.0.1:${server.port}/`
  writeSuccessLine(
    command,
    {
      url,
      session: sessionId,
      share_origin: `http://127.0.0.1:${server.sharePort}`,
      reused: false,
      agent: server.agent,
      ...(store.quarantinedPath ? { quarantined: true } : {}),
    },
    mode,
  )
  if (parsed.options.noOpen !== true) {
    await openDeviceAuthorizationUrl(url).catch(() => undefined)
  }
  // The serving process owns its record. Removing it on exit — including on
  // Ctrl-C — keeps recovery from depending on a recycled port refusing
  // connections, but only when the record is still this process's own.
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = (): void => {
      // Handling the signal suppresses Node's default exit, so the
      // cancellation has to be reported: automation must not read Ctrl-C as
      // success. The CLI contract allows 0, 1, and 130 only, so both signals
      // report the same cancellation.
      process.exitCode = 130
      void server.close().catch(() => undefined)
    }
    process.once(signal, handler)
    return [signal, handler] as const
  })
  try {
    await server.closed
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
    if (readSessionFile(sessionId)?.pid === process.pid) {
      removeSessionFile(sessionId)
    }
  }
}

export async function runPreviewNext(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'preview next'
  const resolved = await resolveTarget(parsed)
  if ('error' in resolved) {
    return writeFailure(command, resolved.error, mode, 1)
  }
  const waitRaw =
    typeof parsed.options.wait === 'string' ? parsed.options.wait : '0'
  // parseInt would accept "3600oops" and block the agent for an hour.
  const wait = /^\d+$/.test(waitRaw) ? Number(waitRaw) : Number.NaN
  if (!Number.isInteger(wait) || wait < 0 || wait > 3600) {
    return writeFailure(
      command,
      validationError(
        '--wait must be between 0 and 3600 seconds.',
        'Pass --wait <seconds> within range.',
      ),
      mode,
      1,
    )
  }
  const result = await agentApi(
    resolved.target,
    '/api/agent/next',
    { wait },
    wait,
  )
  if ('error' in result) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.body, mode)
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function runPreviewDone(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'preview done'
  const resolved = await resolveTarget(parsed)
  if ('error' in resolved) {
    return writeFailure(command, resolved.error, mode, 1)
  }
  if (parsed.options.stdin !== true) {
    return writeFailure(
      command,
      validationError(
        'Pass --stdin with a JSON body.',
        'Pipe {"items":[{"thread":"...","generation":1,"outcome":"fixed","note":"..."}]} to preview done --stdin.',
      ),
      mode,
      1,
    )
  }
  const payload = await readStdinJson()
  const items =
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as Record<string, unknown>).items)
      ? ((payload as Record<string, unknown>).items as unknown[])
      : null
  if (!items || items.length === 0 || !items.every(isPreviewDoneItemInput)) {
    return writeFailure(
      command,
      validationError(
        'Standard input must be {"items": [...]} with thread, generation, and outcome.',
        'Each item needs thread (string), generation (integer), outcome (fixed|skipped), and optional note.',
      ),
      mode,
      1,
    )
  }
  const result = await agentApi(resolved.target, '/api/agent/done', {
    items: items as PreviewDoneItemInput[],
  })
  if ('error' in result) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.body, mode)
}

export async function runPreviewReply(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'preview reply'
  const resolved = await resolveTarget(parsed)
  if ('error' in resolved) {
    return writeFailure(command, resolved.error, mode, 1)
  }
  const thread =
    typeof parsed.options.thread === 'string' ? parsed.options.thread : ''
  const body =
    typeof parsed.options.body === 'string' ? parsed.options.body : ''
  if (!thread || !body) {
    return writeFailure(
      command,
      validationError(
        '--thread and --body are required.',
        'Pass --thread <id> --body <text>.',
      ),
      mode,
      1,
    )
  }
  const result = await agentApi(resolved.target, '/api/agent/reply', {
    thread,
    body,
  })
  if ('error' in result) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.body, mode)
}

export async function runPreviewStop(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'preview stop'
  const resolved = await resolveTarget(parsed, true)
  if ('error' in resolved) {
    // A session whose port neither answers nor refuses cannot be stopped over
    // HTTP, so --force clears the record instead of leaving the file wedged.
    const explicitSession =
      typeof parsed.options.session === 'string' ? parsed.options.session : null
    if (explicitSession && !isSessionId(explicitSession)) {
      return writeFailure(command, resolved.error, mode, 1)
    }
    const positional = parsed.positionals[0]
    if (parsed.options.force === true && !(explicitSession && positional)) {
      // Clear exactly what the caller named; with both selectors present the
      // request is ambiguous and clearing either one could untrack a healthy
      // server.
      const sessionId = explicitSession
        ? explicitSession
        : positional
          ? sessionIdOfPath(positional)
          : null
      if (sessionId) {
        const record = readSessionFile(sessionId)
        if (record && processAlive(record.pid)) {
          // The recorded process is still running; untracking it would let a
          // second server open the same annotation store.
          return writeFailure(
            command,
            sessionUnverifiedError(record.realpath, record.legacy === true),
            mode,
            1,
          )
        }
        if (!releaseStaleClaim(sessionId)) {
          // A start is mid-flight and holds the claim; clearing it would let a
          // second server open the same annotation store.
          return writeFailure(
            command,
            startInProgressError(record?.realpath ?? positional ?? sessionId),
            mode,
            1,
          )
        }
        // --force means "leave no record behind", so it succeeds whether or
        // not one was still there.
        const cleared = record !== null
        removeSessionFile(sessionId)
        return writeSuccess(
          command,
          { stopped: false, cleared, session: sessionId },
          mode,
        )
      }
    }
    return writeFailure(command, resolved.error, mode, 1)
  }
  const result = await agentApi(resolved.target, '/api/agent/stop', {})
  if ('error' in result) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.body, mode)
}

export function previewFileName(realpath: string): string {
  return basename(realpath)
}
