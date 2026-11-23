import type { ShouldRevalidateFunctionArgs } from 'react-router'

/**
 * Settings submissions that cannot change the shell. After one of them the
 * page keeps the shell it already shows and refreshes only its own data.
 * `*` covers every submission to that path. Submissions that can change the
 * shell (the workspace name, the plan, the viewer's role, ownership or
 * membership) are not listed and refresh it like any other revalidation.
 */
const SHELL_NEUTRAL_SUBMISSIONS: Record<string, readonly string[]> = {
  '/settings': ['revoke-cli-sessions', 'transfer-removed-assets'],
  '/settings/tokens': [
    'create',
    'revoke',
    'revoke-cli-family',
    'revoke-all-cli-families',
  ],
  '/settings/bots': ['destinations', 'create', 'stop', 'cancel', 'reissue'],
  '/settings/integrations': ['disconnect-slack'],
  '/settings/external-access': [
    'preview-external-access',
    'update-external-access',
  ],
  '/settings/billing': ['portal'],
  '/set-analytics-consent': ['*'],
}

function submissionIntent({
  formData,
  json,
}: Pick<ShouldRevalidateFunctionArgs, 'formData' | 'json'>) {
  const fromForm = formData?.get('intent')
  if (typeof fromForm === 'string') return fromForm
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const fromJson = (json as Record<string, unknown>).intent
    if (typeof fromJson === 'string') return fromJson
  }
  return ''
}

/** A path segment decoded as the router decodes it before matching. */
function decodedSegment(segment: string) {
  try {
    return decodeURIComponent(segment).replaceAll('/', '%2F')
  } catch {
    return segment
  }
}

/**
 * A pathname as the router matches it: percent-decoded, without a trailing
 * slash, and case-insensitive, so every spelling of a Settings page is the
 * same page.
 */
function normalizedPath(pathname: string) {
  const decoded = pathname.split('/').map(decodedSegment).join('/')
  const lower = decoded.toLowerCase()
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower
}

function actionPath(formAction: string, currentUrl: URL) {
  return normalizedPath(new URL(formAction, currentUrl).pathname)
}

/**
 * Whether two URLs load the same Settings data: the same page and query. A
 * trailing slash and the hash do not reach any loader.
 */
function sameEntry(currentUrl: URL, nextUrl: URL) {
  return (
    normalizedPath(currentUrl.pathname) === normalizedPath(nextUrl.pathname) &&
    currentUrl.search === nextUrl.search
  )
}

/**
 * Whether the Settings shell reloads after a revalidation. Only a known
 * shell-neutral submission that stays on the same entry keeps the shell it
 * already has; navigations, explicit or external-return revalidations and
 * unknown submissions keep the router's own decision. A native POST that
 * renders a document does not ask: it loads a fresh shell.
 */
export function settingsShellShouldRevalidate(
  args: ShouldRevalidateFunctionArgs,
) {
  const {
    currentUrl,
    nextUrl,
    formAction,
    formMethod,
    defaultShouldRevalidate,
  } = args
  if (!formAction || !formMethod || formMethod.toUpperCase() === 'GET')
    return defaultShouldRevalidate
  if (!sameEntry(currentUrl, nextUrl)) return defaultShouldRevalidate
  const neutral = SHELL_NEUTRAL_SUBMISSIONS[actionPath(formAction, currentUrl)]
  if (!neutral) return defaultShouldRevalidate
  const intent = submissionIntent(args)
  return neutral.includes('*') || neutral.includes(intent)
    ? false
    : defaultShouldRevalidate
}
