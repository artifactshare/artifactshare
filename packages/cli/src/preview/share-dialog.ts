// Share dialog HTTP handler for the local preview server. Serves the dialog
// page on a dedicated origin and drives snapshot capture, upload, and the
// device-authorization flow when no credential is available yet.
import { createHash, randomUUID } from 'node:crypto'
import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import {
  apiUrl,
  baseUrlOf,
  cliFetch,
  isLocalHostname,
  readJson,
  requestConfig,
} from '../api.js'
import { resolveCredential } from '../credentials.js'
import { validationError } from '../errors.js'
import {
  resolveDefaultVisibility,
  resolveProjectConfig,
  resolveSharedProjectConfig,
} from '../destination.js'
import { fetchProjects } from '../command-runners/projects.js'
import {
  exchangeDeviceTokenOnce,
  requestDeviceCode,
  verifyAndStoreProfileToken,
} from '../command-runners/login.js'
import { refreshAuthenticatedCredential } from '../command-runners/auto-login.js'
import { postShareUpload } from '../share-upload.js'
import type {
  ApiErrorOptions,
  CliError,
  CliOptions,
  FetchInit,
} from '../types.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
} from './contract.js'
import { PREVIEW_MESSAGES } from './messages.generated.js'

export interface ShareDialogHandlerOptions {
  filePath: string
  fileName: string
  /** Origin of the artifact preview server, used as the postMessage target. */
  artifactOrigin: string
  /** Reads the previewed file as it is right now. */
  readFileBytes: () => Buffer
  /** CLI options from preview startup; credential and base-url resolution. */
  cliOptions: CliOptions
}

type Snapshot = {
  id: string
  bytes: Buffer
  hash: string
  takenAt: string
}

type PendingAuth = {
  id: string
  deviceCode: string
  /** Seconds the authorization server asked us to wait between exchanges. */
  intervalSeconds: number
  verificationUri: string
  verificationUriComplete: string | null
  userCode: string
  expiresAt: number
}

const MAX_BODY_BYTES = 1024 * 1024

export function createShareDialogHandler(
  options: ShareDialogHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const snapshots = new Map<string, Snapshot>()
  const pendingAuths = new Map<string, PendingAuth>()
  // Session token obtained through the dialog's device flow. Held in memory
  // for this preview process; persisting to a profile is best-effort.
  let memoryToken: string | null = null
  // Provenance of the token `currentToken` last returned, so a 401 is mapped
  // against the credential that produced it.
  let tokenProvenance: Partial<ApiErrorOptions> | null = null

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!hostAllowed(request)) {
      return sendJson(response, 403, { error: 'forbidden_host' })
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const route = `${request.method ?? 'GET'} ${url.pathname}`

    if (route === 'GET /') {
      const html = renderPage(options)
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(html)
      return
    }

    if (route === 'GET /api/context') {
      return await handleContext(options, response)
    }

    if (route === 'GET /api/auth-status') {
      return await handleAuthStatus(url, response)
    }

    if (request.method === 'POST') {
      if (!mutationHeadersValid(request)) {
        return sendJson(response, 403, { error: 'forbidden' })
      }
      const body = await readBody(request)
      if (body === null) {
        return sendJson(response, 413, { error: 'body_too_large' })
      }
      let parsed: unknown
      try {
        parsed = body.length === 0 ? {} : JSON.parse(body)
      } catch {
        return sendJson(response, 400, { error: 'invalid_json' })
      }
      const payload = isRecord(parsed) ? parsed : {}

      if (url.pathname === '/api/snapshot') {
        const snapshot = takeSnapshot()
        return sendJson(response, 200, {
          snapshot_id: snapshot.id,
          hash: snapshot.hash,
          taken_at: snapshot.takenAt,
        })
      }
      if (url.pathname === '/api/snapshot/discard') {
        const id =
          typeof payload.snapshot_id === 'string' ? payload.snapshot_id : ''
        snapshots.delete(id)
        return sendJson(response, 200, { ok: true })
      }
      if (url.pathname === '/api/share') {
        return await handleShare(payload, response)
      }
    }

    sendJson(response, 404, { error: 'not_found' })
  }

  function takeSnapshot(): Snapshot {
    const bytes = options.readFileBytes()
    const snapshot: Snapshot = {
      id: randomUUID(),
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
      takenAt: new Date().toISOString(),
    }
    snapshots.set(snapshot.id, snapshot)
    return snapshot
  }

  async function handleContext(
    handlerOptions: ShareDialogHandlerOptions,
    response: ServerResponse,
  ): Promise<void> {
    const cliOptions = handlerOptions.cliOptions
    const request = requestConfig(cliOptions)
    if (request.error) {
      return sendJson(response, 200, {
        authenticated: false,
        projects: null,
        // null, never a guess: the dialog disables sharing rather than
        // publishing to an audience the config did not actually ask for.
        default_visibility: null,
        file_name: handlerOptions.fileName,
      })
    }
    const resolved = await resolveDefaultVisibility(
      'home_audience',
      await resolveSharedProjectConfig(),
    ).catch(() => null)
    const defaultVisibility =
      resolved && !('error' in resolved) ? resolved.value : null

    const token = await currentToken(cliOptions)
    if (!token) {
      return sendJson(response, 200, {
        authenticated: false,
        projects: null,
        default_visibility: defaultVisibility,
        file_name: handlerOptions.fileName,
      })
    }
    const projectsResult = await fetchProjects(token, cliOptions, request.init)
    const projects = projectsResult.error
      ? null
      : projectsResult.projects.map((project) => ({
          id: project.id,
          name: project.name ?? project.id,
        }))
    sendJson(response, 200, {
      authenticated: true,
      projects,
      default_visibility: defaultVisibility,
      file_name: handlerOptions.fileName,
    })
  }

  async function currentToken(cliOptions: CliOptions): Promise<string | null> {
    if (memoryToken) {
      // A token minted by this dialog's device flow has no stored profile, so
      // it carries no refreshable provenance.
      tokenProvenance = null
      return memoryToken
    }
    const credential = await resolveCredential(
      cliOptions,
      await resolveProjectConfig().catch(() => null),
    ).catch(() => null)
    if (!credential?.ok) {
      tokenProvenance = null
      return null
    }
    tokenProvenance = {
      credentialSource: credential.source,
      profile: credential.profile,
      profileCredentialKind: credential.profileCredentialKind,
      botProfile: credential.botProfile,
    }
    return credential.token
  }

  /** mapApiError needs the provenance of the token that was actually sent to
   * turn a 401 into auth_required; describing a different credential would
   * either lose the refresh path or retry under the wrong account. */
  function uploadErrorOptions(baseUrl: string): ApiErrorOptions {
    return { authenticated: true, baseUrl, ...(tokenProvenance ?? {}) }
  }

  /** A saved session token can expire while the preview stays open. Refresh
   * it once and let the caller retry; if that fails, forget the cached token
   * so the next share falls back to device authorization instead of repeating
   * the same rejected upload. */
  async function refreshTokenOnce(
    cliOptions: CliOptions,
    error: CliError,
  ): Promise<string | null> {
    const credential = await resolveCredential(
      cliOptions,
      await resolveProjectConfig().catch(() => null),
    ).catch(() => null)
    if (!credential?.ok) {
      memoryToken = null
      return null
    }
    // Only a stored session profile can be refreshed. A bearer token or a PAT
    // profile has no refresh path, and silently starting device auth for one
    // would write a profile the caller never asked for.
    if (credential.profileCredentialKind !== 'session') {
      memoryToken = null
      return null
    }
    const refreshed = await refreshAuthenticatedCredential(
      error,
      credential,
      cliOptions,
    ).catch(() => null)
    if (refreshed?.ok) {
      memoryToken = refreshed.credential.token
      return refreshed.credential.token
    }
    memoryToken = null
    return null
  }

  async function handleShare(
    payload: Record<string, unknown>,
    response: ServerResponse,
  ): Promise<void> {
    const snapshotId =
      typeof payload.snapshot_id === 'string' ? payload.snapshot_id : ''
    const snapshot = snapshots.get(snapshotId)
    if (!snapshot) {
      return sendJson(response, 404, { error: 'unknown_snapshot' })
    }
    const cliOptions = options.cliOptions
    const request = requestConfig(cliOptions)
    if (request.error) {
      return sendCliError(response, request.error)
    }
    const token = await currentToken(cliOptions)
    if (!token) {
      return await startDeviceAuth(cliOptions, request.init, response)
    }

    const projectId =
      typeof payload.project_id === 'string' && payload.project_id !== ''
        ? payload.project_id
        : null
    let visibility =
      typeof payload.visibility === 'string' && payload.visibility !== ''
        ? payload.visibility
        : null
    if (projectId) {
      visibility = 'project'
    } else if (!visibility) {
      // Never guess an audience: a config that cannot be read could be hiding
      // a private default, and publishing that to the workspace is not
      // recoverable. `share` refuses here too.
      const resolved = await resolveDefaultVisibility(
        'home_audience',
        await resolveSharedProjectConfig(),
      ).catch(() => ({ error: visibilityUnresolvedError() }))
      if ('error' in resolved) {
        return sendCliError(response, resolved.error)
      }
      visibility = resolved.value
    }

    const { FormData } = await import('undici')
    const { Blob } = await import('node:buffer')
    const form = new FormData()
    form.set('visibility', visibility)
    if (projectId) form.set('container_id', projectId)
    form.append(
      'file',
      new Blob([new Uint8Array(snapshot.bytes)], {
        type: contentTypeForName(options.fileName),
      }),
      options.fileName,
    )

    const baseUrl = baseUrlOf(cliOptions)
    const uploadUrl = apiUrl('/api/shareables/uploads', baseUrl)
    const result = await postShareUpload(
      {
        uploadUrl,
        token,
        form,
        requestInit: request.init,
        errorOptions: uploadErrorOptions(baseUrl),
      },
      baseUrl,
      artifactKindForName(options.fileName),
    )
    if ('error' in result && result.error.code === 'auth_required') {
      const refreshed = await refreshTokenOnce(cliOptions, result.error)
      if (!refreshed) {
        return await startDeviceAuth(cliOptions, request.init, response)
      }
      const retry = await postShareUpload(
        {
          uploadUrl,
          token: refreshed,
          form,
          requestInit: request.init,
          errorOptions: uploadErrorOptions(baseUrl),
        },
        baseUrl,
        artifactKindForName(options.fileName),
      )
      if ('error' in retry) {
        return sendCliError(response, retry.error)
      }
      snapshots.delete(snapshotId)
      return sendJson(response, 200, {
        url: retry.body.url,
        id: retry.body.id,
        version_id: retry.body.versionId,
        visibility: retry.body.visibility ?? visibility,
        warnings: retry.body.warnings,
      })
    }
    if ('error' in result) {
      return sendCliError(response, result.error)
    }
    // The share is done; the snapshot has served its purpose.
    snapshots.delete(snapshotId)
    sendJson(response, 200, {
      url: result.body.url,
      id: result.body.id,
      version_id: result.body.versionId,
      visibility: result.body.visibility ?? visibility,
      warnings: result.body.warnings,
    })
  }

  async function startDeviceAuth(
    cliOptions: CliOptions,
    init: FetchInit,
    response: ServerResponse,
  ): Promise<void> {
    const code = await requestDeviceCode(cliOptions, init)
    if ('error' in code) {
      return sendCliError(response, code.error)
    }
    const pending: PendingAuth = {
      id: randomUUID(),
      deviceCode: code.device_code,
      intervalSeconds: Math.max(1, code.interval || 5),
      verificationUri: code.verification_uri,
      verificationUriComplete: code.verification_uri_complete ?? null,
      userCode: code.user_code,
      expiresAt: Date.now() + code.expires_in * 1000,
    }
    pendingAuths.set(pending.id, pending)
    sendJson(response, 200, {
      auth_required: true,
      verification_uri: pending.verificationUri,
      verification_uri_complete: pending.verificationUriComplete,
      interval_seconds: pending.intervalSeconds,
      user_code: pending.userCode,
      auth_id: pending.id,
    })
  }

  async function handleAuthStatus(
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const authId = url.searchParams.get('auth_id') ?? ''
    const pending = pendingAuths.get(authId)
    if (!pending) {
      return sendJson(response, 404, { status: 'failed' })
    }
    if (Date.now() > pending.expiresAt) {
      pendingAuths.delete(authId)
      return sendJson(response, 200, { status: 'failed' })
    }
    const cliOptions = options.cliOptions
    const request = requestConfig(cliOptions)
    if (request.error) {
      pendingAuths.delete(authId)
      return sendJson(response, 200, { status: 'failed' })
    }
    const exchange = await exchangeDeviceTokenOnce(
      cliOptions,
      pending.deviceCode,
      request.init,
    )
    if ('error' in exchange) {
      pendingAuths.delete(authId)
      return sendJson(response, 200, { status: 'failed' })
    }
    if (exchange.status === 'success') {
      pendingAuths.delete(authId)
      memoryToken = exchange.token.access_token
      tokenProvenance = null
      // Best effort: persist the session as a profile so later CLI commands
      // stay signed in. The share itself only needs the in-memory token.
      const profile =
        typeof cliOptions.profile === 'string' && cliOptions.profile !== ''
          ? cliOptions.profile
          : 'default'
      const sessionExpiresAt =
        exchange.token.expires_in === undefined
          ? null
          : new Date(
              Date.now() + exchange.token.expires_in * 1000,
            ).toISOString()
      await verifyAndStoreProfileToken(
        profile,
        exchange.token.access_token,
        cliOptions,
        request.init,
        sessionExpiresAt,
      ).catch(() => null)
      return sendJson(response, 200, { status: 'authenticated' })
    }
    if (
      exchange.status === 'pending' ||
      exchange.status === 'slow_down' ||
      exchange.status === 'retry_later'
    ) {
      if (exchange.status === 'slow_down') {
        pending.intervalSeconds += 5
      }
      return sendJson(response, 200, {
        status: 'pending',
        interval_seconds: pending.intervalSeconds,
      })
    }
    pendingAuths.delete(authId)
    sendJson(response, 200, { status: 'failed' })
  }

  return (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'internal_error' })
      } else {
        response.end()
      }
    })
  }
}

function hostAllowed(request: IncomingMessage): boolean {
  const host = request.headers.host
  if (!host) return false
  try {
    return isLocalHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

function mutationHeadersValid(request: IncomingMessage): boolean {
  const contentType = String(request.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) return false
  return (
    request.headers[PREVIEW_MUTATION_HEADER] === PREVIEW_MUTATION_HEADER_VALUE
  )
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        request.removeAllListeners('data')
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(chunks.map((chunk) => chunk.toString('utf8')).join(''))
    })
    request.on('error', reject)
  })
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function sendCliError(response: ServerResponse, error: CliError): void {
  sendJson(response, 502, { error })
}

function visibilityUnresolvedError(): CliError {
  return validationError(
    'The default audience could not be resolved.',
    'Fix the Artifact Share config, or pick an audience explicitly before sharing.',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function artifactKindForName(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  return extension === '.md' || extension === '.markdown'
    ? 'markdown_page'
    : 'html_page'
}

function contentTypeForName(fileName: string): string {
  return artifactKindForName(fileName) === 'markdown_page'
    ? 'text/markdown'
    : 'text/html'
}

function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('</', '<\\/')
    .replaceAll('<!--', '<\\!--')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderPage(options: ShareDialogHandlerOptions): string {
  const messages = {
    en: pickShareMessages('en'),
    ja: pickShareMessages('ja'),
  }
  const bootstrap = embedJson({
    messages,
    artifactOrigin: options.artifactOrigin,
    fileName: options.fileName,
    mutationHeader: PREVIEW_MUTATION_HEADER,
    mutationHeaderValue: PREVIEW_MUTATION_HEADER_VALUE,
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.fileName)}</title>
<style>
  :root {
    --background: #ffffff; --surface-warm: #fbfaf8; --foreground: #37352f;
    --muted-foreground: rgba(55,53,47,0.86); --faint: rgba(55,53,47,0.45);
    --border: rgba(55,53,47,0.1); --border-strong: rgba(55,53,47,0.22);
    --accent: rgba(55,53,47,0.04); --link: #116bb1; --primary: #1766ad;
    --card: #ffffff; --r-md: 6px; --r-lg: 8px;
    --shadow-lg: rgba(15,15,15,0.05) 0 0 0 1px, rgba(15,15,15,0.1) 0 8px 24px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: #111315; --surface-warm: #0e1012; --foreground: #e7e2d8;
      --muted-foreground: rgba(231,226,216,0.77); --faint: rgba(231,226,216,0.4);
      --border: rgba(231,226,216,0.13); --border-strong: rgba(231,226,216,0.28);
      --accent: rgba(231,226,216,0.07); --link: #7db7ff; --primary: #7db7ff;
      --card: #191c1f;
      --shadow-lg: rgba(0,0,0,0.4) 0 0 0 1px, rgba(0,0,0,0.5) 0 8px 24px;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-warm); color: var(--foreground);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
    font-size: 14px; line-height: 1.5; min-height: 100vh;
    display: grid; place-items: center; padding: 16px; }
  .dialog { width: min(400px, calc(100vw - 32px)); background: var(--card);
    border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: 20px; }
  .dialog h3 { margin: 0 0 12px; font-size: 15px; }
  .field { margin-bottom: 12px; font-size: 13px; }
  .field label { display: block; font-size: 11px; color: var(--faint); margin-bottom: 4px; }
  select { width: 100%; font: inherit; font-size: 13px; padding: 6px 8px;
    border: 1px solid var(--border-strong); border-radius: var(--r-md);
    background: var(--background); color: var(--foreground); }
  .note { font-size: 12px; color: var(--muted-foreground);
    background: var(--accent); border-radius: var(--r-md);
    padding: 8px 10px; margin-bottom: 12px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .btn { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--background); color: var(--foreground);
    padding: 5px 12px; }
  .btn:hover { background: var(--accent); }
  .btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .btn[disabled] { opacity: 0.5; cursor: default; }
  .url-box { display: flex; gap: 8px; margin-bottom: 12px; }
  .url-box input { flex: 1; font: inherit; font-size: 13px; padding: 6px 8px;
    border: 1px solid var(--border-strong); border-radius: var(--r-md);
    background: var(--background); color: var(--foreground); }
  .auth-part, .done-part { display: none; }
  .dialog.auth .form-part { display: none; }
  .dialog.auth .auth-part { display: block; }
  .dialog.shared .form-part, .dialog.shared .auth-part { display: none; }
  .dialog.shared .done-part { display: block; }
  a { color: var(--link); }
  .user-code { font-size: 18px; font-weight: 700; letter-spacing: 2px; margin: 8px 0; }
  .error { color: #c0392b; font-size: 12px; margin-bottom: 8px; display: none; }
</style>
</head>
<body>
<div class="dialog" id="dialog">
  <div class="form-part">
    <h3 id="title"></h3>
    <div class="field">
      <label id="destLabel"></label>
      <select id="destination"></select>
    </div>
    <div class="field">
      <label id="visLabel"></label>
      <select id="visibility">
        <option value="private">private</option>
        <option value="workspace">workspace</option>
        <option value="link">link</option>
      </select>
    </div>
    <div class="note" id="notCarried"></div>
    <div class="note" id="snapshotNote"></div>
    <div class="error" id="shareError"></div>
    <div class="row">
      <button class="btn" id="cancelBtn"></button>
      <button class="btn btn-primary" id="shareBtn"></button>
    </div>
  </div>
  <div class="auth-part">
    <h3 id="authTitle"></h3>
    <div class="note" id="authRequired"></div>
    <div><a id="authLink" target="_blank" rel="noopener"></a></div>
    <div class="user-code" id="userCode"></div>
    <div id="authWaiting"></div>
  </div>
  <div class="done-part">
    <h3 id="doneTitle"></h3>
    <div class="url-box">
      <input readonly id="shareUrl">
      <button class="btn" id="copyBtn"></button>
    </div>
    <p class="note" id="shareNotes" style="display:none"></p>
    <div class="row">
      <button class="btn" id="continueBtn"></button>
      <button class="btn btn-primary" id="finishBtn"></button>
    </div>
  </div>
</div>
<script>
(function () {
  var bootstrap = ${bootstrap};
  var lang = (navigator.language || 'en').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en';
  var messages = bootstrap.messages[lang];
  document.documentElement.lang = lang;
  function t(key) { return messages['preview.shareDialog.' + key] || key; }
  function el(id) { return document.getElementById(id); }

  el('title').textContent = t('title') + ' - ' + bootstrap.fileName;
  el('destLabel').textContent = t('destination');
  el('visLabel').textContent = t('visibility');
  el('notCarried').textContent = t('notCarried');
  el('cancelBtn').textContent = t('cancel');
  el('shareBtn').textContent = t('confirm');
  el('authTitle').textContent = t('title');
  el('authRequired').textContent = t('authRequired');
  el('authWaiting').textContent = t('authWaiting');
  el('doneTitle').textContent = t('done');
  el('copyBtn').textContent = t('copy');
  el('continueBtn').textContent = t('continue');
  el('finishBtn').textContent = t('finish');

  var headers = { 'content-type': 'application/json' };
  headers[bootstrap.mutationHeader] = bootstrap.mutationHeaderValue;
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (json) {
        return { ok: response.ok, body: json };
      });
    });
  }

  var snapshotId = null;
  var context = { authenticated: false, projects: null, default_visibility: null };
  var pollTimer = null;
  var shareInFlight = false;

  post('/api/snapshot').then(function (result) {
    if (!result.ok) return;
    snapshotId = result.body.snapshot_id;
    var takenAt = new Date(result.body.taken_at);
    el('snapshotNote').textContent =
      t('snapshotNote').replace('{time}', takenAt.toLocaleTimeString());
  });

  function loadContext() {
    return fetch('/api/context')
      .then(function (response) { return response.json(); })
      .then(function (body) {
        context = body;
        var destination = el('destination');
        var previous = destination.value;
        destination.innerHTML = '';
        var home = document.createElement('option');
        home.value = '';
        home.textContent = lang === 'ja' ? 'ホーム' : 'Home';
        destination.appendChild(home);
        (body.projects || []).forEach(function (project) {
          var option = document.createElement('option');
          option.value = project.id;
          option.textContent = project.name;
          destination.appendChild(option);
        });
        destination.value = previous;
        if (body.default_visibility) {
          el('visibility').value = body.default_visibility;
        }
        syncVisibility();
      })
      .catch(function () {
        // Without context the audience is unknown; refuse rather than posting
        // the first static option as if it were a resolved default.
        context = { authenticated: false, projects: null, default_visibility: null };
        syncVisibility();
      });
  }
  syncVisibility();
  loadContext();

  function syncVisibility() {
    var projectSelected = el('destination').value !== '';
    var visibility = el('visibility');
    visibility.disabled = projectSelected;
    // A project destination carries its own audience, so an unresolved home
    // default only blocks home shares.
    var audienceUnknown = !projectSelected && !context.default_visibility;
    el('shareBtn').disabled = audienceUnknown || shareInFlight;
    if (audienceUnknown) {
      el('shareError').textContent = t('visibilityUnknown');
      el('shareError').style.display = 'block';
    } else if (el('shareError').textContent === t('visibilityUnknown')) {
      el('shareError').style.display = 'none';
    }
    if (projectSelected) {
      var fixed = document.createElement('option');
      fixed.value = 'project';
      fixed.textContent = 'project';
      if (!visibility.querySelector('option[value="project"]')) {
        visibility.appendChild(fixed);
      }
      visibility.value = 'project';
    } else if (visibility.value === 'project') {
      visibility.value = context.default_visibility || 'private';
    }
  }
  el('destination').addEventListener('change', syncVisibility);

  function share() {
    if (!snapshotId || shareInFlight) return;
    shareInFlight = true;
    el('shareBtn').disabled = true;
    el('shareError').style.display = 'none';
    var projectId = el('destination').value || null;
    var payload = { snapshot_id: snapshotId };
    if (projectId) payload.project_id = projectId;
    else payload.visibility = el('visibility').value;
    post('/api/share', payload).then(function (result) {
      shareInFlight = false;
      el('shareBtn').disabled = false;
      if (result.ok && result.body.auth_required) {
        showAuth(result.body);
        return;
      }
      if (result.ok && result.body.url) {
        showDone(result.body.url, result.body.visibility, result.body.warnings);
        return;
      }
      var message = result.body && result.body.error && result.body.error.message;
      el('shareError').textContent = message || 'Share failed.';
      el('shareError').style.display = 'block';
    }).catch(function () {
      shareInFlight = false;
      el('shareBtn').disabled = false;
      el('shareError').textContent = 'Share failed.';
      el('shareError').style.display = 'block';
    });
  }
  el('shareBtn').addEventListener('click', share);

  function showAuth(auth) {
    el('dialog').className = 'dialog auth';
    var link = auth.verification_uri_complete || auth.verification_uri;
    el('authLink').href = link;
    el('authLink').textContent = link;
    el('userCode').textContent = auth.user_code;
    // The authorization server dictates the poll rate; polling faster earns
    // slow_down responses that never converge.
    var intervalMs = Math.max(1, auth.interval_seconds || 5) * 1000;
    var poll = function () {
      fetch('/api/auth-status?auth_id=' + encodeURIComponent(auth.auth_id))
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (body.status === 'authenticated') {
            clearTimeout(pollTimer);
            el('dialog').className = 'dialog';
            // Projects only become visible once authenticated; sharing straight
            // away would silently pick Home for a first-time user.
            loadContext().then(function () {
              el('shareError').textContent = t('confirmDestination');
              el('shareError').style.display = 'block';
            });
            return;
          }
          if (body.status === 'failed') {
            clearTimeout(pollTimer);
            el('dialog').className = 'dialog';
            el('shareError').textContent = t('authRequired');
            el('shareError').style.display = 'block';
            return;
          }
          if (body.interval_seconds) {
            intervalMs = Math.max(1, body.interval_seconds) * 1000;
          }
          pollTimer = setTimeout(poll, intervalMs);
        })
        .catch(function () {
          pollTimer = setTimeout(poll, intervalMs);
        });
    };
    pollTimer = setTimeout(poll, intervalMs);
  }

  function showDone(url, confirmed, warnings) {
    el('dialog').className = 'dialog shared';
    el('shareUrl').value = url;
    var notes = [];
    var requested = el('destination').value ? 'project' : el('visibility').value;
    if (confirmed && confirmed !== requested) {
      notes.push(t('visibilityAdjusted').replace('{visibility}', confirmed));
    }
    (warnings || []).forEach(function (warning) {
      if (warning && warning.message) notes.push(warning.message);
    });
    var noteEl = el('shareNotes');
    noteEl.textContent = notes.join(' ');
    noteEl.style.display = notes.length > 0 ? 'block' : 'none';
    snapshotId = null;
  }

  el('copyBtn').addEventListener('click', function () {
    var input = el('shareUrl');
    input.select();
    var copied = function () { el('copyBtn').textContent = t('copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(copied, copied);
    } else {
      document.execCommand('copy');
      copied();
    }
  });

  el('finishBtn').addEventListener('click', function () {
    if (window.opener) {
      window.opener.postMessage(
        { source: 'artifactshare-preview-share', kind: 'share-finished' },
        bootstrap.artifactOrigin
      );
    }
    window.close();
  });
  el('continueBtn').addEventListener('click', function () {
    window.close();
  });
  el('cancelBtn').addEventListener('click', function () {
    var finish = function () { window.close(); };
    if (snapshotId) {
      post('/api/snapshot/discard', { snapshot_id: snapshotId }).then(finish, finish);
    } else {
      finish();
    }
  });
})();
</script>
</body>
</html>
`
}

function pickShareMessages(locale: 'en' | 'ja'): Record<string, string> {
  const all = PREVIEW_MESSAGES[locale] as Record<string, string>
  const picked: Record<string, string> = {}
  for (const key of Object.keys(all)) {
    const value = all[key]
    if (key.startsWith('preview.shareDialog.') && value !== undefined) {
      picked[key] = value
    }
  }
  return picked
}
