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
      /[\\/?#]/.test(part) ||
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
  const canonical = storedExportPath(path)
  const url = new URL(
    `${exportEndpointRoot(id)}/export-asset${canonical.split('/').map(encodeURIComponent).join('/')}`,
    origin,
  )
  url.searchParams.set('versionId', versionId)
  return url.href
}

/** Stored paths and decoded route params are names, not URL references. Never
 * decode them again: percent-hex sequences are literal stored filename bytes. */
export function storedExportPath(path: string): string {
  if (
    /^[a-z][\w+.-]*:|^\/\//i.test(path) ||
    /[\\?#]/.test(path) ||
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid stored export path')
  const segments = path.split('/')
  if (segments.some((part) => part === '.' || part === '..'))
    throw new Error('Invalid stored export path')
  return (
    '/' +
    segments.filter(Boolean).join('/') +
    (path.endsWith('/') && segments.some(Boolean) ? '/' : '')
  )
}
