import { splitAssetRef } from './asset-ref'

/** Decode each segment once, before resolving dots. Never let URL normalization
 * reinterpret an artifact path as an application endpoint. */
export function canonicalExportPath(
  value: string,
  base = '/index.html',
): string {
  const { pathname } = splitAssetRef(value)
  if (/^[a-z][\w+.-]*:/i.test(pathname) || pathname.startsWith('//')) {
    throw new Error('Invalid export path')
  }
  const parts = pathname.startsWith('/') ? [] : base.split('/').slice(1, -1)
  for (const encoded of pathname.split('/')) {
    const part = decodeURIComponent(encoded)
    if (
      /[\\/?#%]/.test(part) ||
      Array.from(part).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new Error('Invalid export path')
    if (encoded !== part && (part === '.' || part === '..'))
      throw new Error('Encoded traversal')
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error('Export path escapes artifact')
      parts.pop()
    } else parts.push(part)
  }
  return `/${parts.join('/')}${pathname.endsWith('/') && parts.length ? '/' : ''}`
}

export function exportEndpointRoot(id: string): string {
  if (!id || id === '.' || id === '..')
    throw new Error('Invalid export artifact')
  return `/api/shareables/${encodeURIComponent(id)}`
}

export function exportAssetHref(
  id: string,
  versionId: string,
  path: string,
  origin: string,
): string {
  if (!versionId) throw new Error('Export version is required')
  const canonical = canonicalExportPath(path)
  const url = new URL(
    `${exportEndpointRoot(id)}/export-asset${canonical.split('/').map(encodeURIComponent).join('/')}`,
    origin,
  )
  url.searchParams.set('versionId', versionId)
  return url.href
}
