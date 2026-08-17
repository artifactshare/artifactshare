export const APEX_HOST = 'artifactshare.com'
export const WWW_HOST = 'www.artifactshare.com'
export const SANDBOX_HOST = 'sandbox.artifactshare.com'

// Origins where MCP hosts render app widgets. An embed-token preview frames the
// artifact's sandbox content from inside one of these, so the content's
// `frame-ancestors` must allow them — but only for embed tokens
// (`app/lib/sandbox-token.ts`), never the normal viewer path. The embed token
// is the real access gate (a bearer secret), so naming the host chain here is
// defence in depth, not the primary control. Verified per host via the host's
// frame-ancestors console error:
// - ChatGPT: widget under `<domain>.web-sandbox.oaiusercontent.com`, top
//   `chatgpt.com`.
// - Cursor / VS Code desktop: the app runs at `vscode-file://vscode-app` (a
//   local app origin, not a web page); widgets inherit it.
// - Claude: widget under `{sha256(mcpServerUrl)[:32]}.claudemcpcontent.com`
//   when `_meta.ui.domain` is set to that host.
export const MCP_EMBED_FRAME_ANCESTORS = [
  'https://*.web-sandbox.oaiusercontent.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://*.claudemcpcontent.com',
  'vscode-file://vscode-app',
  'vscode-webview:',
]

// Embed tokens outlive the 60s viewer token so the host can re-render the
// widget during a conversation without the preview breaking.
export const SANDBOX_EMBED_TTL_SECONDS = 1800

export function isProduction(env: { APP_ENV: string }): boolean {
  return env.APP_ENV === 'production'
}

export function requestHostname(
  request: Request,
  env: { APP_ENV: string },
): string {
  const urlHostname = new URL(request.url).hostname.toLowerCase()
  if (isProduction(env)) return urlHostname
  if (urlHostname.endsWith('.localhost')) return urlHostname

  const originalHostname = hostHeaderHostname(
    request.headers.get('mf-original-hostname'),
  )
  if (originalHostname?.endsWith('.sandbox.localhost')) {
    return originalHostname
  }

  const hostHostname = hostHeaderHostname(request.headers.get('host'))
  if (
    hostHostname?.endsWith('.sandbox.localhost') ||
    hostHostname === 'localhost'
  ) {
    return hostHostname
  }
  return urlHostname
}

export const APP_DEV_PORT = 5173
export const BUNDLE_SANDBOX_DEV_PORT = 5174

/**
 * Build the iframe src URL for a published version's sandboxed entrypoint.
 * The hostname is scoped to both the shareable and the exact version. Version
 * ids use nanoid's DNS-unsafe alphabet, so encode their UTF-8 bytes as hex.
 */
export function artifactSandboxUrl(
  env: { APP_ENV: string },
  shareableId: string,
  versionId: string,
  token: string,
  entrypointPath = '/index.html',
): string {
  const path = browserEntrypointPath(entrypointPath)
  const query = `?t=${encodeURIComponent(token)}`
  const label = sandboxVersionLabel(shareableId, versionId)
  return isProduction(env)
    ? `https://${label}.${SANDBOX_HOST}${path}${query}`
    : `https://${label}.sandbox.localhost:${BUNDLE_SANDBOX_DEV_PORT}${path}${query}`
}

export function sandboxVersionLabel(
  shareableId: string,
  versionId: string,
): string {
  const encodedVersion = Array.from(
    new TextEncoder().encode(versionId),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const label = `${shareableId}--v-${encodedVersion}`
  if (!/^[a-z0-9]{10}--v-[a-f0-9]+$/.test(label) || label.length > 63) {
    throw new Error('Invalid sandbox version identity')
  }
  return label
}

export function sandboxVersionIdentityFromHostname(
  hostname: string,
  env: { APP_ENV: string },
): { shareableId: string; versionId: string } | null {
  const suffix = isProduction(env) ? `.${SANDBOX_HOST}` : '.sandbox.localhost'
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  const match = /^([a-z0-9]{10})--v-([a-f0-9]+)$/.exec(label)
  if (!match || match[2].length % 2 !== 0) return null
  try {
    const bytes = new Uint8Array(
      match[2].match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    )
    const versionId = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return versionId ? { shareableId: match[1], versionId } : null
  } catch {
    return null
  }
}

function browserEntrypointPath(path: string): string {
  if (path.toLowerCase() === '/index.html') return '/'
  return encodeSandboxPath(path)
}

function encodeSandboxPath(path: string): string {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment, index) => index === 0 || segment !== '')
  return segments
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/')
}

function hostHeaderHostname(host: string | null): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}
