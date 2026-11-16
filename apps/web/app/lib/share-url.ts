import { APEX_HOST, APP_DEV_PORT, linkViewerUrl, WWW_HOST } from './hosts'
import type { Visibility } from './shareable-types'

export function buildShareableUrl(
  id: string,
  visibility: Visibility,
  appOrigin = window.location.origin,
): string {
  if (visibility === 'link') {
    const app = new URL(appOrigin)
    // A development per-ID viewer is served by the same server as the app, so
    // it keeps the app's port when a local stack runs on non-default ports.
    return linkViewerUrl(
      app.hostname === APEX_HOST || app.hostname === WWW_HOST,
      id,
      app.port ? Number(app.port) : APP_DEV_PORT,
    )
  }
  return new URL(`/a/${id}`, appOrigin).toString()
}
