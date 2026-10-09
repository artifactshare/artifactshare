import {
  EXTERNAL_SCRIPT_CSP_SOURCES,
  SOCIAL_EMBED_SCRIPT_CSP_SOURCES,
} from '@artifactshare/viewer-kit/script-policy-sources'

const allowedScriptOrigins = new Set(
  `${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_SCRIPT_CSP_SOURCES}`.split(
    ' ',
  ),
)

// Presentation attribution only: injected inline scripts can also name the document.
export function classifyCspViolation(
  sourceFile: string | null,
  sandboxOrigin: string,
  renderType: string | null,
  blockedURI = '',
): 'artifact' | 'environment' {
  try {
    if (!sourceFile) {
      // Parser-initiated loads can omit their source. Browsers redact data/blob
      // resource URLs to these exact scheme names in violation reports.
      if (blockedURI === 'data' || blockedURI === 'blob') return 'artifact'
      const blocked = new URL(blockedURI)
      return blocked.protocol === 'http:' || blocked.protocol === 'https:'
        ? 'artifact'
        : 'environment'
    }
    const source = new URL(sourceFile)
    if (source.protocol !== 'https:' && source.protocol !== 'http:')
      return 'environment'
    if (source.origin === new URL(sandboxOrigin).origin) return 'artifact'
    return (renderType === 'html' || renderType === 'static_site') &&
      allowedScriptOrigins.has(source.origin)
      ? 'artifact'
      : 'environment'
  } catch {
    return 'environment'
  }
}
