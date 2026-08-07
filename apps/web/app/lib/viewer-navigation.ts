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
