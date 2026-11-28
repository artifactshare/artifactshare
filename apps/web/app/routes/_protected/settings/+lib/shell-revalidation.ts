import type { ShouldRevalidateFunctionArgs } from 'react-router'

type ShellPart = 'workspace' | 'role' | 'joined-projects' | 'unread-counts'

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
    'update-external-access': ['unread-counts'],
  },
  '/set-analytics-consent': { '*': [] },
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

function decodedSegment(segment: string) {
  try {
    return decodeURIComponent(segment).replaceAll('/', '%2F')
  } catch {
    return segment
  }
}

function normalizedPath(pathname: string) {
  const decoded = pathname.split('/').map(decodedSegment).join('/')
  const lower = decoded.toLowerCase()
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower
}

function actionPath(formAction: string, currentUrl: URL) {
  return normalizedPath(new URL(formAction, currentUrl).pathname)
}

function sameEntry(currentUrl: URL, nextUrl: URL) {
  return (
    normalizedPath(currentUrl.pathname) === normalizedPath(nextUrl.pathname) &&
    currentUrl.search === nextUrl.search
  )
}

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
