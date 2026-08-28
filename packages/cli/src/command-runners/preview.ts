import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import type { CliError, OutputMode, ParsedArgs } from '../types.js'
import { cliError, validationError } from '../errors.js'
import { writeFailure, writeSuccess, writeSuccessLine } from '../output.js'
import { openDeviceAuthorizationUrl } from '../process.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  type PreviewDoneItemInput,
  isPreviewDoneItemInput,
} from '../preview/contract.js'
import {
  annotationsFilePath,
  previewRealpath,
  previewsDir,
  readSessionFile,
  resolveLiveSession,
  sessionIdForPath,
  writeSessionFile,
} from '../preview/session.js'
import { createPreviewStore } from '../preview/store.js'
import { startPreviewServer } from '../preview/server.js'

function sessionNotFoundError(target: string | null): CliError {
  return cliError({
    code: 'preview_session_not_found',
    message: 'No live preview session was found.',
    why: target
      ? `No running preview serves ${target}.`
      : 'No running preview session matches the request.',
    hint: 'Start one with: npx --yes @artifactshare/cli preview <file>',
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
): Promise<{ target: ResolvedTarget } | { error: CliError }> {
  const explicitSession =
    typeof parsed.options.session === 'string' ? parsed.options.session : null
  const positional = parsed.positionals[0]
  if (explicitSession) {
    const session = readSessionFile(explicitSession)
    if (!session) return { error: sessionNotFoundError(explicitSession) }
    const live = await resolveLiveSession(session.realpath)
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
    const real = previewRealpath(positional)
    if (!real.ok) return { error: sessionNotFoundError(positional) }
    const live = await resolveLiveSession(real.realpath)
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
  for (const name of candidates) {
    const session = readSessionFile(name.replace(/\.json$/, ''))
    if (!session) continue
    const live = await resolveLiveSession(session.realpath)
    if (live.state === 'live') {
      liveSessions.push({
        port: live.session.port,
        sessionId: live.session.session_id,
        realpath: live.session.realpath,
      })
    }
  }
  const only = liveSessions[0]
  if (liveSessions.length === 1 && only) return { target: only }
  if (liveSessions.length === 0) return { error: sessionNotFoundError(null) }
  return {
    error: validationError(
      'Multiple preview sessions are live.',
      'Pass the file path or --session <id> to pick one.',
    ),
  }
}

function previewRequestError(reason: unknown, target: string): CliError {
  const detail = typeof reason === 'string' ? reason : 'request_failed'
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
  } catch {
    return { error: sessionNotFoundError(target.realpath) }
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
  if (existing.state === 'none' && existing.reclaimed !== true) {
    const stale = readSessionFile(sessionIdForPath(real.realpath))
    if (stale) {
      // The recorded session neither answered nor refused, so it may still be
      // serving. Starting a second server here would give two processes the
      // same annotations file and each save would discard the other's work.
      return writeFailure(
        command,
        cliError({
          code: 'preview_session_unverified',
          message: 'A preview session for this file could not be verified.',
          why: `A session is recorded for ${real.realpath} but it did not answer.`,
          hint: 'Retry in a moment, or stop it with: npx --yes @artifactshare/cli preview stop <file>',
          agentRecoverable: true,
          requiresHuman: false,
          recovery: { kind: 'retry_later' },
        }),
        mode,
        1,
      )
    }
  }
  if (existing.state === 'live') {
    const reusedUrl = `http://127.0.0.1:${existing.session.port}/`
    writeSuccessLine(
      command,
      {
        url: reusedUrl,
        session: existing.session.session_id,
        share_origin: `http://127.0.0.1:${existing.session.share_port}`,
        reused: true,
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
  const store = createPreviewStore(annotationsFilePath(sessionId))
  const server = await startPreviewServer({
    filePath: real.realpath,
    store,
    sessionId,
    cliOptions: parsed.options,
  })
  writeSessionFile({
    session_id: sessionId,
    realpath: real.realpath,
    port: server.port,
    share_port: server.sharePort,
    pid: process.pid,
    started_at: new Date().toISOString(),
  })
  const url = `http://127.0.0.1:${server.port}/`
  writeSuccessLine(
    command,
    {
      url,
      session: sessionId,
      share_origin: `http://127.0.0.1:${server.sharePort}`,
      reused: false,
      ...(store.quarantinedPath ? { quarantined: true } : {}),
    },
    mode,
  )
  if (parsed.options.noOpen !== true) {
    await openDeviceAuthorizationUrl(url).catch(() => undefined)
  }
  await server.closed
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
  const wait = Number.parseInt(waitRaw, 10)
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
  const resolved = await resolveTarget(parsed)
  if ('error' in resolved) {
    return writeFailure(command, resolved.error, mode, 1)
  }
  const result = await agentApi(resolved.target, '/api/agent/stop', {})
  if ('error' in result) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.body, mode)
}

export function previewFileName(realpath: string): string {
  return basename(realpath)
}
