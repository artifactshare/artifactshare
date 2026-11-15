import type { Page } from 'playwright'
import type { ParentWindow } from '../pdf-viewer-browser-command'
type Controls = Pick<
  ParentWindow,
  'sendPreferences' | 'postToViewer' | 'syncPage' | 'replaceViewer'
>
type RemoteControls = {
  [K in keyof Controls]: (...args: Parameters<Controls[K]>) => Promise<void>
}
export function parentWindow(
  page: Page,
  overrides: Partial<RemoteControls> = {},
): RemoteControls {
  return {
    sendPreferences: (message) =>
      page.evaluate(
        ([receivedMessage]) => {
          if (
            !('sendPreferences' in window) ||
            typeof window.sendPreferences !== 'function'
          )
            throw new Error('Missing parent fixture control: sendPreferences')
          window.sendPreferences(receivedMessage)
        },
        [message] as const,
      ),
    postToViewer: (data) =>
      page.evaluate(
        ([receivedData]) => {
          if (
            !('postToViewer' in window) ||
            typeof window.postToViewer !== 'function'
          )
            throw new Error('Missing parent fixture control: postToViewer')
          window.postToViewer(receivedData)
        },
        [data] as const,
      ),
    syncPage: (token) =>
      page.evaluate(
        ([receivedToken]) => {
          if (!('syncPage' in window) || typeof window.syncPage !== 'function')
            throw new Error('Missing parent fixture control: syncPage')
          window.syncPage(receivedToken)
        },
        [token] as const,
      ),
    replaceViewer: (src, name) =>
      page.evaluate(
        ([receivedSrc, receivedName]) => {
          if (
            !('replaceViewer' in window) ||
            typeof window.replaceViewer !== 'function'
          )
            throw new Error('Missing parent fixture control: replaceViewer')
          window.replaceViewer(receivedSrc, receivedName)
        },
        [src, name] as const,
      ),
    ...overrides,
  }
}
