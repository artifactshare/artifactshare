import type { ArtifactType } from './artifact-type'

export type LinkNavigationMode = 'document' | 'site'

export function hasBrowserUserActivation(
  userActivation: Pick<UserActivation, 'isActive'> | null | undefined,
): boolean {
  return userActivation?.isActive === true
}

export type ViewerLinkNavigationAction =
  | { kind: 'allow-frame'; url: string }
  | { kind: 'open-app'; url: string }
  | {
      kind: 'open-external'
      url: string
      disposition: 'new-tab' | 'os-handler'
    }
  | { kind: 'blocked'; reason: 'invalid-url' | 'unsupported-scheme' }
  | { kind: 'unavailable-in-document'; url: string }

export function externalNavigationDecision(
  action: ViewerLinkNavigationAction,
  lowTrust: boolean,
): 'interstitial' | 'open' {
  return lowTrust && action.kind === 'open-external' ? 'interstitial' : 'open'
}

type ExternalNavigationAction = Extract<
  ViewerLinkNavigationAction,
  { kind: 'open-external' }
>

export function externalNavigationDestination(url: string): string {
  const parsed = new URL(url)
  const destination =
    parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname
      : parsed.href
  return destination.length <= 200
    ? destination
    : `${destination.slice(0, 199)}…`
}

export function continueExternalNavigation(
  action: ExternalNavigationAction,
  browser: {
    location: { href: string }
    open: (url: string, target: string, features: string) => unknown
  },
): void {
  if (action.disposition === 'os-handler') {
    browser.location.href = action.url
    return
  }
  browser.open(action.url, '_blank', 'noopener,noreferrer')
}

export function linkNavigationModeFor(
  renderType: ArtifactType,
): LinkNavigationMode {
  return renderType === 'static_site' ? 'site' : 'document'
}

export function classifyViewerLinkNavigation({
  href,
  appOrigin,
  appHosts,
  sandboxOrigin,
  bundlePaths = [],
  fallbackToIndex = false,
  mode,
}: {
  href: string
  appOrigin: string
  appHosts: ReadonlyArray<string>
  sandboxOrigin: string
  bundlePaths?: ReadonlyArray<string>
  fallbackToIndex?: boolean
  mode: LinkNavigationMode
}): ViewerLinkNavigationAction {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: 'blocked', reason: 'invalid-url' }
  }

  if (url.origin === sandboxOrigin) {
    const path = normalizedBundlePath(url)
    if (
      mode === 'site' &&
      (!path ||
        (!bundlePaths.includes(path) &&
          !(fallbackToIndex && !hasFileExtension(path))))
    ) {
      return { kind: 'unavailable-in-document', url: url.href }
    }
    return mode === 'site'
      ? { kind: 'allow-frame', url: url.href }
      : { kind: 'unavailable-in-document', url: url.href }
  }

  if (
    url.origin === appOrigin ||
    (url.protocol === 'https:' &&
      url.port === '' &&
      /^[a-z0-9]{10}\.artifactshare\.link$/.test(url.hostname)) ||
    (url.protocol === 'https:' &&
      url.port === '' &&
      appHosts.includes(url.hostname))
  ) {
    return { kind: 'open-app', url: url.href }
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'open-external', url: url.href, disposition: 'new-tab' }
  }

  if (
    url.protocol === 'mailto:' ||
    url.protocol === 'tel:' ||
    url.protocol === 'vscode:' ||
    url.protocol === 'cursor:' ||
    url.protocol === 'codex:' ||
    url.protocol === 'claude:' ||
    url.protocol === 'claude-cli:'
  ) {
    return { kind: 'open-external', url: url.href, disposition: 'os-handler' }
  }

  return { kind: 'blocked', reason: 'unsupported-scheme' }
}

function normalizedBundlePath(url: URL): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const rawPath = decoded === '/' ? '/index.html' : decoded
  const segments = rawPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return '/index.html'
  if (segments.length === 1) {
    const lower = segments[0].toLowerCase()
    if (lower === 'index.html' || lower === 'index.md') {
      segments[0] = lower
    }
  }
  return `/${segments.join('/')}`.normalize('NFC')
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').at(-1) ?? ''
  return /\.[^./]+$/.test(lastSegment)
}
