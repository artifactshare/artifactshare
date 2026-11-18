import { computeTextSha256Hex } from '../../lib/sha256'
import { validateBundlePath } from '../../../workers/lib/path-validator'
import type { SearchIndexLocation } from './names'

function component(value: string): string {
  if (!value || value === '.' || value === '..' || value.length > 512)
    throw new Error('invalid_search_identity')
  return encodeURIComponent(value)
}
/**
 * Where an index keeps its extracted text. A placed index uses its own
 * `@<location>/` area, so neither index's cleanup reaches the other's
 * objects. An encoded workspace id never starts with `@`.
 */
export function workspaceSearchPrefix(
  workspaceId: string,
  location?: SearchIndexLocation,
): string {
  return `search-text/${location ? `@${location}/` : ''}${component(workspaceId)}/`
}
export function shareableSearchPrefix(
  workspaceId: string,
  id: string,
  location?: SearchIndexLocation,
): string {
  return `${workspaceSearchPrefix(workspaceId, location)}${component(id)}/`
}
export async function searchTextKey(
  workspaceId: string,
  id: string,
  version: string,
  path: string,
  location?: SearchIndexLocation,
): Promise<string> {
  if (
    !path.startsWith('/') ||
    path.includes('//') ||
    path.split('/').includes('.') ||
    validateBundlePath(path).kind === 'blocked'
  )
    throw new Error('invalid_search_path')
  return `${shareableSearchPrefix(workspaceId, id, location)}${component(version)}/${await computeTextSha256Hex(path)}`
}
