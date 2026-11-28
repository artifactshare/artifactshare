import type { HeadersFunction } from 'react-router'
import ViewerRoute, { ErrorBoundary as ViewerErrorBoundary } from './+viewer'
export { loader } from './+loader.server'
export { meta } from './+viewer'

// Direct component exports let React Router inject loader and error props.
export default ViewerRoute
export const ErrorBoundary = ViewerErrorBoundary

export const headers: HeadersFunction = ({
  parentHeaders,
  loaderHeaders,
  errorHeaders,
}) => {
  const responseHeaders = new Headers(parentHeaders)
  const cacheControl =
    errorHeaders?.get('Cache-Control') ?? loaderHeaders.get('Cache-Control')
  if (cacheControl) responseHeaders.set('Cache-Control', cacheControl)
  for (const source of [loaderHeaders, errorHeaders]) {
    for (const cookie of source?.getSetCookie() ?? [])
      responseHeaders.append('Set-Cookie', cookie)
  }
  return responseHeaders
}
