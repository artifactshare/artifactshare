import { computeTextSha256Hex } from '../../lib/sha256'
import { validateBundlePath } from '../../../workers/lib/path-validator'

function component(value: string): string {
  if (!value || value === '.' || value === '..' || value.length > 512)
    throw new Error('invalid_search_identity')
  return encodeURIComponent(value)
}
export function workspaceSearchPrefix(workspaceId: string): string {
  return `search-text/${component(workspaceId)}/`
}
export function shareableSearchPrefix(workspaceId: string, id: string): string {
  return `${workspaceSearchPrefix(workspaceId)}${component(id)}/`
}
export async function searchTextKey(
  workspaceId: string,
  id: string,
  version: string,
  path: string,
): Promise<string> {
  if (
    !path.startsWith('/') ||
    path.includes('//') ||
    path.split('/').includes('.') ||
    validateBundlePath(path).kind === 'blocked'
  )
    throw new Error('invalid_search_path')
  return `${shareableSearchPrefix(workspaceId, id)}${component(version)}/${await computeTextSha256Hex(path)}`
}
