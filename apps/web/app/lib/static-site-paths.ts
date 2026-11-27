const ROOT_INDEX_PATH = '/index.html'

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').at(-1) ?? ''
  return /\.[^./]+$/.test(lastSegment)
}

/**
 * The version files that can serve a static-site path. `direct` lists the
 * path itself and, for an extensionless path, its directory index, most
 * specific first. `fallback` is the root index, which serves an extensionless
 * path only when the version falls back to index.
 */
export function staticSitePathCandidates(path: string): {
  direct: string[]
  fallback: typeof ROOT_INDEX_PATH | null
} {
  if (hasFileExtension(path)) return { direct: [path], fallback: null }
  const directoryIndex = path.endsWith('/')
    ? `${path}index.html`
    : `${path}/index.html`
  return { direct: [path, directoryIndex], fallback: ROOT_INDEX_PATH }
}
