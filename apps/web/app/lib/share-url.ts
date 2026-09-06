import { APEX_HOST, linkViewerUrl, WWW_HOST } from './hosts'
import type { Visibility } from './shareable-types'

export function buildShareableUrl(
  id: string,
  visibility: Visibility,
  appOrigin = window.location.origin,
): string {
  if (visibility === 'link') {
    const hostname = new URL(appOrigin).hostname
    return linkViewerUrl(hostname === APEX_HOST || hostname === WWW_HOST, id)
  }
  return new URL(`/a/${id}`, appOrigin).toString()
}
