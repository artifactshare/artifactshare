import { HttpNetworkFrame } from 'msw/experimental'
import type { setupServer } from 'msw/node'

type UnhandledFrame = Exclude<
  NonNullable<
    Parameters<ReturnType<typeof setupServer>['listen']>[0]
  >['onUnhandledFrame'],
  string | undefined
>

// These harnesses intentionally have different loopback allowlists.
export const usercontentUnhandledFrame: UnhandledFrame = ({ frame }) => {
  if (!(frame instanceof HttpNetworkFrame))
    throw new Error('Unexpected Worker non-HTTP network frame')
  const request = frame.data.request
  const url = new URL(request.url)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return
  throw new Error(`Unexpected Worker network request: ${url.origin}`)
}

export const integrationUnhandledFrame: UnhandledFrame = ({ frame }) => {
  if (!(frame instanceof HttpNetworkFrame))
    throw new Error('Unhandled outbound non-HTTP network frame')
  const request = frame.data.request
  if (new URL(request.url).hostname === '127.0.0.1') return
  throw new Error(
    `Unhandled outbound request: ${request.method} ${request.url}`,
  )
}
