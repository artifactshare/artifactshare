import { createShareDialogHandler } from './share-dialog.js'
import type { CliOptions } from '../types.js'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type FSWatcher, readFileSync, watch } from 'node:fs'
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, relative as relativeTo } from 'node:path'
import { injectReadyReporter } from '@artifactshare/viewer-kit/inject'
import { renderMarkdownDocument } from '@artifactshare/viewer-kit/markdown-render'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  PREVIEW_SESSION_ENDPOINT,
  type PreviewAgentNotificationRegistration,
  type PreviewAgentNotificationProjection,
  type PreviewAnchor,
  type PreviewDoneItemInput,
  type PreviewNextResult,
  type PreviewSessionIdentity,
  isPreviewAnchor,
  isPreviewDoneItemInput,
} from './contract.js'
import { PREVIEW_MESSAGES } from './messages.generated.js'
import {
  createPreviewNotificationCoordinator,
  defaultPreviewNotificationRegistration,
  type PreviewAgentAdapter,
} from './notification.js'
import { renderPreviewShell } from './shell.js'
import type { PreviewStore } from './store.js'

const MAX_BODY_BYTES = 1024 * 1024
const WATCH_DEBOUNCE_MS = 200
const SSE_HEARTBEAT_MS = 15_000

/** The package installs the `artifactshare` binary only, and the basename
 * alone would not find a file in a subdirectory. */
export function previewResumeCommand(filePath: string): string {
  const from = relativeTo(process.cwd(), filePath)
  // A path outside the working directory reads better absolute than as a
  // chain of parent hops.
  const relative = from === '' || from.startsWith('..') ? filePath : from
  const quoted = /^[\w./@-]+$/.test(relative)
    ? relative
    : `'${relative.replaceAll("'", `'\\''`)}'`
  return `npx --yes @artifactshare/cli preview ${quoted}`
}

export interface PreviewServerOptions {
  /** Absolute realpath of the previewed .md or .html file. */
  filePath: string
  store: PreviewStore
  sessionId: string
  notificationRegistration?: PreviewAgentNotificationRegistration
  notificationAdapter?: PreviewAgentAdapter
  notificationTimeoutMs?: number
  onNotificationRegistrationChange?: (
    registration: PreviewAgentNotificationRegistration,
  ) => void
  openBrowser?: boolean
  /** Extra CLI options; accepted for forward compatibility, unused here. */
  cliOptions?: Record<string, unknown>
}

export interface PreviewServer {
  port: number
  sharePort: number
  url: string
  agent: PreviewAgentNotificationProjection
  /** Trusted local registration, including the private target. Never project
   * this object to the browser or CLI output. */
  notificationRegistration: PreviewAgentNotificationRegistration
  /** Resolves once the server has fully shut down. */
  closed: Promise<void>
  close(): Promise<void>
}

interface SseClient {
  response: ServerResponse
  heartbeat: NodeJS.Timeout
}

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!match) return false
  const host = (match[1] ?? '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
  })
  response.end(html)
}

function mutationHeadersValid(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return false
  return (
    request.headers[PREVIEW_MUTATION_HEADER] === PREVIEW_MUTATION_HEADER_VALUE
  )
}

async function readBodyJson(
  request: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_BODY_BYTES) return { ok: false, status: 413 }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, status: 400 }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return { ok: true, body: {} }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400 }
  }
}

/** Neutralise any <meta http-equiv="Content-Security-Policy"> tag so the
 * previewed HTML cannot block the injected reporter script. Robust to
 * attribute order, quoting style, and case. */
export function stripMetaCsp(html: string): string {
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)[^>]*>/gi,
    '<!-- meta CSP removed by as preview -->',
  )
}

function doneEventThreads(
  store: PreviewStore,
  items: PreviewDoneItemInput[],
): Array<{ thread: string; selector?: string; summary: string | null }> {
  const byThread = new Map(store.all().map((entry) => [entry.thread, entry]))
  return items.map((item) => {
    const annotation = byThread.get(item.thread)
    const anchor: PreviewAnchor | undefined = annotation?.anchor
    const selector =
      anchor && anchor.kind === 'element' ? anchor.selector : undefined
    return {
      thread: item.thread,
      ...(selector !== undefined ? { selector } : {}),
      summary: annotation?.summary ?? item.note ?? null,
    }
  })
}

export async function startPreviewServer(
  options: PreviewServerOptions,
): Promise<PreviewServer> {
  const { filePath, store, sessionId } = options
  const notification = createPreviewNotificationCoordinator({
    sessionId,
    registration:
      options.notificationRegistration ??
      defaultPreviewNotificationRegistration(),
    store,
    ...(options.notificationAdapter
      ? { adapter: options.notificationAdapter }
      : {}),
    ...(options.notificationTimeoutMs !== undefined
      ? { timeoutMs: options.notificationTimeoutMs }
      : {}),
    ...(options.onNotificationRegistrationChange
      ? { onRegistrationChange: options.onNotificationRegistrationChange }
      : {}),
  })
  const fileName = basename(filePath)
  const isMarkdown = filePath.toLowerCase().endsWith('.md')

  let revision = ''
  try {
    revision = sha256Hex(readFileSync(filePath))
  } catch {
    revision = sha256Hex(`missing:${Date.now()}`)
  }

  let closedResolve: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve
  })
  let closing = false

  const events = new EventEmitter()
  events.setMaxListeners(0)
  const sseClients = new Set<SseClient>()
  let activeWait = false

  function broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
      client.response.write(frame)
    }
  }

  function broadcastAnnotations(): void {
    broadcast('annotations', {
      annotations: store.all(),
      agent: notification.projection(),
    })
  }

  // --- file watching -------------------------------------------------------
  let watcher: FSWatcher | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  try {
    // Watch the parent directory so delete-then-recreate (the common editor
    // save strategy) keeps being observed.
    watcher = watch(dirname(filePath), (eventType, changed) => {
      if (changed !== null && changed !== fileName) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        let next: string | null = null
        try {
          next = sha256Hex(readFileSync(filePath))
        } catch {
          next = null
        }
        if (next !== null && next !== revision) {
          revision = next
          broadcast('reload', { revision })
        }
      }, WATCH_DEBOUNCE_MS)
    })
  } catch {
    watcher = null
  }

  // --- request handling ----------------------------------------------------

  function guard(request: IncomingMessage, response: ServerResponse): boolean {
    if (!hostAllowed(request.headers.host)) {
      sendJson(response, 403, { error: 'forbidden_host' })
      return false
    }
    const method = request.method ?? 'GET'
    if (method === 'POST' || method === 'DELETE') {
      if (!mutationHeadersValid(request)) {
        sendJson(response, 403, { error: 'missing_preview_header' })
        return false
      }
    }
    return true
  }

  function serveArtifact(response: ServerResponse): void {
    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      sendHtml(response, 404, '<!doctype html><p>File not found.</p>')
      return
    }
    if (isMarkdown) {
      // The ready envelope is the only line this process writes to stdout.
      const document = renderMarkdownDocument(bytes.toString('utf8'), {
        logTiming: false,
      })
      sendHtml(response, 200, injectReadyReporter(document))
      return
    }
    const html = stripMetaCsp(bytes.toString('utf8'))
    sendHtml(response, 200, injectReadyReporter(html))
  }

  function serveEvents(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    response.write(': connected\n\n')
    const client: SseClient = {
      response,
      heartbeat: setInterval(() => {
        response.write(': heartbeat\n\n')
      }, SSE_HEARTBEAT_MS),
    }
    sseClients.add(client)
    // Initial annotation state so the shell can render without racing the
    // first fetch.
    response.write(
      `event: annotations\ndata: ${JSON.stringify({
        annotations: store.all(),
        agent: notification.projection(),
      })}\n\n`,
    )
    response.on('close', () => {
      clearInterval(client.heartbeat)
      sseClients.delete(client)
    })
  }

  async function handleAgentNext(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const read = await readBodyJson(request)
    if (!read.ok) return sendJson(response, read.status, { error: 'bad_body' })
    const body = (read.body ?? {}) as Record<string, unknown>
    const waitSeconds =
      typeof body.wait === 'number' && Number.isFinite(body.wait)
        ? Math.max(0, Math.min(3600, body.wait))
        : 0
    if (activeWait) {
      return sendJson(response, 409, {
        error: 'active_wait_conflict',
        agent: notification.projection(),
      })
    }
    const immediate = store.deliver()
    if (immediate.length > 0 || waitSeconds === 0) {
      const result: PreviewNextResult = {
        items: immediate,
        ...(immediate.length === 0 && waitSeconds === 0
          ? { timed_out: true }
          : {}),
        revision,
        agent: notification.projection(),
      }
      if (immediate.length > 0) broadcastAnnotations()
      return sendJson(response, 200, result)
    }
    // Long-poll: wait for a submit (or shutdown / timeout).
    activeWait = true
    notification.setWaitConnected(true)
    broadcastAnnotations()
    let settled = false
    const releaseWait = (): void => {
      if (!activeWait) return
      activeWait = false
      notification.setWaitConnected(false)
    }
    const finish = (result: PreviewNextResult): void => {
      if (settled) return
      settled = true
      events.off('submitted', onSubmit)
      events.off('closing', onClosing)
      clearTimeout(timer)
      releaseWait()
      result.agent = notification.projection()
      sendJson(response, 200, result)
      broadcastAnnotations()
    }
    const onSubmit = (): void => {
      const items = store.deliver()
      if (items.length === 0) return
      broadcastAnnotations()
      finish({ items, revision, agent: notification.projection() })
    }
    const onClosing = (): void => {
      finish({
        items: [],
        session_ended: true,
        revision,
        agent: notification.projection(),
      })
    }
    const timer = setTimeout(() => {
      finish({
        items: [],
        timed_out: true,
        revision,
        agent: notification.projection(),
      })
    }, waitSeconds * 1000)
    events.on('submitted', onSubmit)
    events.on('closing', onClosing)
    // The request stream is already consumed here, so a `close` listener on it
    // would never fire. Watch the response socket instead: without this an
    // aborted poll keeps its `submitted` handler, consumes the next batch into
    // a dead socket, and the agent's fresh poll never sees it.
    response.on('close', () => {
      if (settled) return
      settled = true
      events.off('submitted', onSubmit)
      events.off('closing', onClosing)
      clearTimeout(timer)
      releaseWait()
      broadcastAnnotations()
    })
  }

  async function handleArtifactRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!guard(request, response)) return
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (method === 'GET') {
      if (path === '/') {
        // The artifact server binds first, so a request can arrive before the
        // share origin has a port. Reading it then throws rather than
        // rendering, so say "not ready" the way the share server does.
        if (shareOrigin === null) {
          return sendJson(response, 503, { error: 'preview_not_ready' })
        }
        return sendHtml(
          response,
          200,
          renderPreviewShell({
            fileName,
            resumeCommand: previewResumeCommand(filePath),
            shareOrigin,
            messages: PREVIEW_MESSAGES,
          }),
        )
      }
      if (path === '/artifact') return serveArtifact(response)
      if (path === PREVIEW_SESSION_ENDPOINT) {
        const identity: PreviewSessionIdentity = {
          service: 'artifactshare-preview',
          session_id: sessionId,
          realpath: filePath,
          share_port: sharePort,
        }
        return sendJson(response, 200, identity)
      }
      if (path === '/events') return serveEvents(response)
      if (path === '/api/annotations') {
        return sendJson(response, 200, {
          annotations: store.all(),
          agent: notification.projection(),
          revision,
          quarantined: store.quarantinedPath !== null,
        })
      }
      return sendJson(response, 404, { error: 'not_found' })
    }

    if (method === 'POST' && path === '/api/annotations') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      const body = (read.body ?? {}) as Record<string, unknown>
      if (!isPreviewAnchor(body.anchor) || typeof body.comment !== 'string') {
        return sendJson(response, 400, { error: 'invalid_annotation' })
      }
      const annotation = store.createDraft(body.anchor, body.comment)
      broadcastAnnotations()
      return sendJson(response, 200, { annotation })
    }

    const deleteMatch = path.match(/^\/api\/annotations\/([^/]+)$/)
    if (method === 'DELETE' && deleteMatch) {
      const result = store.deleteDraft(decodeURIComponent(deleteMatch[1] ?? ''))
      if (!result.ok) return sendJson(response, 409, result)
      broadcastAnnotations()
      return sendJson(response, 200, { deleted: true })
    }

    if (method === 'POST' && path === '/api/annotations/discard-drafts') {
      await readBodyJson(request)
      const discarded = store.discardAllDrafts()
      broadcastAnnotations()
      return sendJson(response, 200, { discarded: discarded.length })
    }

    if (method === 'POST' && path === '/api/annotations/submit') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      if (
        typeof read.body !== 'object' ||
        read.body === null ||
        Array.isArray(read.body) ||
        Object.keys(read.body as Record<string, unknown>).length > 0
      ) {
        return sendJson(response, 400, { error: 'invalid_submit_body' })
      }
      const submitted = store.submitDrafts()
      if (!submitted.ok) {
        return sendJson(response, 409, {
          error: submitted.reason,
          batch_id: submitted.batch.id,
          agent: notification.projection(),
        })
      }
      if (submitted.batch) {
        if (notification.registration.capability === 'wait' && activeWait) {
          events.emit('submitted')
        } else {
          await notification.notifyBatch(submitted.batch.id)
        }
      }
      broadcastAnnotations()
      return sendJson(response, 200, {
        submitted: submitted.annotations.length,
        ...(submitted.batch ? { batch_id: submitted.batch.id } : {}),
        agent: notification.projection(),
      })
    }

    const reopenMatch = path.match(/^\/api\/annotations\/([^/]+)\/reopen$/)
    if (method === 'POST' && reopenMatch) {
      await readBodyJson(request)
      const result = store.reopen(decodeURIComponent(reopenMatch[1] ?? ''))
      if (!result.ok) return sendJson(response, 409, result)
      broadcastAnnotations()
      return sendJson(response, 200, { annotation: result.annotation })
    }

    if (method === 'POST' && path === '/api/annotations/anchor-state') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      const body = (read.body ?? {}) as Record<string, unknown>
      const raw = Array.isArray(body.states) ? body.states : []
      const updates = raw.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as Record<string, unknown>
        const thread = record.thread
        const state = record.state
        if (typeof thread !== 'string') return []
        if (state !== 'attached' && state !== 'orphaned') return []
        return [{ thread, state: state as 'attached' | 'orphaned' }]
      })
      let changed = false
      for (const update of updates) {
        if (store.setAnchorState(update.thread, update.state).ok) changed = true
      }
      if (changed) broadcastAnnotations()
      return sendJson(response, 200, { updated: updates.length })
    }

    if (method === 'POST' && path === '/api/annotations/orphan-discard') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      const body = (read.body ?? {}) as Record<string, unknown>
      const threads = Array.isArray(body.threads)
        ? body.threads.filter(
            (value): value is string => typeof value === 'string',
          )
        : []
      const results: Array<{ thread: string; discarded: boolean }> = []
      for (const thread of threads) {
        // Draft annotations delete directly. Resolved/dismissed ones are
        // reopened to draft first, then deleted, using only public store
        // API. In-flight annotations (requested/in_progress) are left for
        // the agent to report on and are not discarded.
        let result = store.deleteDraft(thread)
        if (!result.ok && result.reason === 'invalid_status') {
          const reopened = store.reopen(thread)
          if (reopened.ok) result = store.deleteDraft(thread)
        }
        results.push({ thread, discarded: result.ok })
      }
      broadcastAnnotations()
      return sendJson(response, 200, { results })
    }

    if (method === 'POST' && path === '/api/agent/next') {
      return handleAgentNext(request, response)
    }

    if (method === 'POST' && path === '/api/agent/done') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      const body = (read.body ?? {}) as Record<string, unknown>
      const rawItems = Array.isArray(body.items) ? body.items : null
      if (!rawItems || !rawItems.every(isPreviewDoneItemInput)) {
        return sendJson(response, 400, { error: 'invalid_done_items' })
      }
      const items = rawItems as PreviewDoneItemInput[]
      const outcomes = store.applyDone(items)
      const results = items.map((item, index) => ({
        thread: item.thread,
        result: outcomes[index] ?? 'unknown_thread',
      }))
      // Only accepted items changed state; announcing the rest would flash and
      // re-toast threads that a retry left untouched.
      const accepted = items.filter(
        (_, index) => outcomes[index] === 'accepted',
      )
      if (accepted.length > 0) {
        broadcast('done', {
          threads: doneEventThreads(store, accepted),
          revision,
        })
      }
      broadcastAnnotations()
      return sendJson(response, 200, {
        results,
        revision,
        agent: notification.projection(),
      })
    }

    if (method === 'POST' && path === '/api/agent/reply') {
      const read = await readBodyJson(request)
      if (!read.ok)
        return sendJson(response, read.status, { error: 'bad_body' })
      const body = (read.body ?? {}) as Record<string, unknown>
      if (typeof body.thread !== 'string' || typeof body.body !== 'string') {
        return sendJson(response, 400, { error: 'invalid_reply' })
      }
      const result = store.reply(body.thread, body.body, 'agent')
      if (!result.ok) return sendJson(response, 409, result)
      broadcastAnnotations()
      return sendJson(response, 200, { annotation: result.annotation })
    }

    if (method === 'POST' && path === '/api/agent/stop') {
      await readBodyJson(request)
      sendJson(response, 200, { stopped: true })
      setImmediate(() => {
        void close()
      })
      return
    }

    return sendJson(response, 404, { error: 'not_found' })
  }

  const artifactServer: Server = createServer((request, response) => {
    void handleArtifactRequest(request, response).catch((error) => {
      console.error('[preview] artifact request failed:', error)
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'internal_error' })
      } else {
        response.end()
      }
    })
  })

  // Share origin. A separate origin so the artifact document cannot script
  // the dialog or call the share API (cross-origin, no CORS). Both the origin
  // and the handler are late-bound because they need ports that are only known
  // once the servers start listening.
  let shareOrigin: string | null = null
  let shareHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null
  const shareServer: Server = createServer((request, response) => {
    if (shareHandler) {
      shareHandler(request, response)
      return
    }
    sendJson(response, 503, { error: 'share_dialog_not_ready' })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      artifactServer.once('error', reject)
      artifactServer.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    // The watcher was opened before either bind. Leaving it holds the event
    // loop open, so the failed command reports its error and then hangs.
    watcher?.close()
    throw error
  }
  try {
    await new Promise<void>((resolve, reject) => {
      shareServer.once('error', reject)
      shareServer.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    // The artifact server is already bound; leaving it would hold a port that
    // no session file records.
    watcher?.close()
    await new Promise<void>((resolve) => artifactServer.close(() => resolve()))
    throw error
  }

  const port = (artifactServer.address() as AddressInfo).port
  const sharePort = (shareServer.address() as AddressInfo).port
  shareOrigin = `http://127.0.0.1:${sharePort}`

  shareHandler = createShareDialogHandler({
    filePath: options.filePath,
    fileName: basename(options.filePath),
    artifactOrigin: `http://127.0.0.1:${port}`,
    readFileBytes: () => readFileSync(options.filePath),
    cliOptions: (options.cliOptions ?? {}) as CliOptions,
  })

  async function close(): Promise<void> {
    if (closing) return closed
    closing = true
    events.emit('closing')
    broadcast('session-ended', {})
    if (debounceTimer) clearTimeout(debounceTimer)
    if (watcher) watcher.close()
    for (const client of sseClients) {
      clearInterval(client.heartbeat)
      client.response.end()
    }
    sseClients.clear()
    await Promise.all([
      new Promise<void>((resolve) => artifactServer.close(() => resolve())),
      new Promise<void>((resolve) => shareServer.close(() => resolve())),
    ])
    closedResolve()
    return closed
  }

  return {
    port,
    sharePort,
    url: `http://127.0.0.1:${port}/`,
    agent: notification.projection(),
    get notificationRegistration() {
      return notification.registration
    },
    closed,
    close,
  }
}
