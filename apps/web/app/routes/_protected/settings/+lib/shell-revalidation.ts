import type { ShouldRevalidateFunctionArgs } from 'react-router'

/**
 * What the Settings shell shows: the workspace (name, plan, storage), the
 * viewer's role, and the joined projects in the header with their unread
 * counts.
 */
type ShellPart = 'workspace' | 'role' | 'joined-projects' | 'unread-counts'

/**
 * Every submission made from a Settings page, by action path and intent, with
 * the parts of the shell it can change. `*` covers every submission to that
 * path. After a submission that changes none of them the page keeps the shell
 * it already shows and refreshes only its own data; any other submission, and
 * any submission not listed, refreshes the shell like any other revalidation.
 */
export const SETTINGS_SUBMISSION_SHELL_CHANGES: Record<
  string,
  Readonly<Record<string, readonly ShellPart[]>>
> = {
  '/settings': {
    'grant-admin': ['role'],
    'revoke-admin': ['role'],
    'transfer-owner': ['role'],
    'remove-member': ['role', 'joined-projects', 'unread-counts'],
    'restore-member': ['role', 'joined-projects', 'unread-counts'],
    'revoke-cli-sessions': [],
    // The removed member's files become the viewer's, unread ones included.
    'transfer-removed-assets': ['joined-projects', 'unread-counts'],
  },
  '/settings/general': { 'update-workspace-name': ['workspace'] },
  '/settings/billing': {
    'change-plan': ['workspace'],
    checkout: ['workspace'],
    portal: [],
  },
  '/settings/tokens': {
    create: [],
    revoke: [],
    'revoke-cli-family': [],
    'revoke-all-cli-families': [],
  },
  '/settings/bots': {
    destinations: [],
    create: [],
    stop: [],
    cancel: [],
    reissue: [],
  },
  '/settings/integrations': { 'disconnect-slack': [] },
  '/settings/external-access': {
    'preview-external-access': [],
    // Link sharing decides which files count as unread.
    'update-external-access': ['unread-counts'],
  },
  '/set-analytics-consent': { '*': [] },
  // The theme switch in the header.
  '/set-theme': { '*': [] },
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
 * Whether the Settings shell reloads after a revalidation. Only a listed
 * submission that changes no part of the shell and stays on the same entry
 * keeps the shell it
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
  const intents =
    SETTINGS_SUBMISSION_SHELL_CHANGES[actionPath(formAction, currentUrl)]
  if (!intents) return defaultShouldRevalidate
  const key = Object.hasOwn(intents, '*') ? '*' : submissionIntent(args)
  const changes = Object.hasOwn(intents, key) ? intents[key] : undefined
  return changes?.length === 0 ? false : defaultShouldRevalidate
}
