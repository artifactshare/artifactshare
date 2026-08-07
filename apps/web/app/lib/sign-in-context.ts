import { safeInternalNext } from './safe-next'

export function signInMethod(
  params: URLSearchParams,
  providerError: string | null,
) {
  return params.get('method') === 'email' ||
    providerError?.toLowerCase().includes('account_not_linked')
    ? 'email'
    : 'provider'
}

export function signInIntent(params: URLSearchParams) {
  return params.get('intent') === 'upload' ? 'upload' : null
}

export function buildSignInErrorCallback(params: URLSearchParams) {
  const query = new URLSearchParams()
  if (signInIntent(params)) query.set('intent', 'upload')
  const next = safeInternalNext(params.get('next'))
  if (next !== '/') query.set('next', next)
  const suffix = query.toString()
  return `/sign-in${suffix ? `?${suffix}` : ''}`
}
