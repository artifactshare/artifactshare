import { APEX_HOST, linkViewerUrl } from './hosts'
import type { Visibility } from './shareable-types'

export function buildShareableUrl(id: string, visibility: Visibility): string {
  if (visibility === 'link') {
    return linkViewerUrl(window.location.hostname === APEX_HOST, id)
  }
  return `${window.location.origin}/a/${id}`
}
