import { RouterContextProvider } from 'react-router'
import type { ShouldRevalidateFunctionArgs } from 'react-router'
import { expect, test, vi } from 'vitest'
import { userContext } from '~/middleware/context'
import { appShellShouldRevalidate } from './+lib/app-shell-revalidation'
import { loadAppShell } from './+lib/app-shell.server'

const joined = vi.hoisted(() => vi.fn())
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: joined,
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('./settings/+lib/settings-request.server', () => ({
  settingsWorkspace: async () => ({ name: 'Example workspace' }),
}))

function signedIn() {
  const context = new RouterContextProvider()
  context.set(userContext, {
    id: 'viewer',
    email: 'viewer@example.test',
    emailVerified: true,
    workspaceId: 'ws1',
    kind: 'human',
    name: 'Viewer',
    image: null,
    locale: null,
    hd: null,
    msTenantId: null,
  })
  return context
}

test('the header lists the joined projects it read', async () => {
  joined.mockResolvedValueOnce([
    {
      id: 'p1',
      name: 'Launch',
      workspaceId: 'ws1',
      workspaceName: undefined,
      updatedAt: '2026-11-01T00:00:00.000Z',
      fileCount: 4,
      newCount: 2,
    },
  ])
  const shell = await loadAppShell(signedIn())
  expect(shell).toMatchObject({
    workspaceName: 'Example workspace',
    user: { id: 'viewer' },
    joinedProjects: [
      { id: 'p1', name: 'Launch', newCount: 2, workspaceName: undefined },
    ],
  })
})

test('a failed joined-projects read leaves the header with an empty list', async () => {
  joined.mockRejectedValueOnce(new TypeError('query failed'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const shell = await loadAppShell(signedIn())
  expect(shell.joinedProjects).toEqual([])
  expect(log.mock.calls).toEqual([
    [
      {
        operation: 'app-shell.joined-projects',
        cause: 'TypeError',
        frames: expect.any(Array),
      },
    ],
  ])
  log.mockRestore()
})

function navigation(
  current: string,
  next: string,
  defaultShouldRevalidate: boolean,
): ShouldRevalidateFunctionArgs {
  return {
    currentUrl: new URL(current, 'https://example.test'),
    currentParams: {},
    nextUrl: new URL(next, 'https://example.test'),
    nextParams: {},
    defaultShouldRevalidate,
  }
}

function submission(
  formAction: string,
  intent: string,
): ShouldRevalidateFunctionArgs {
  const formData = new FormData()
  formData.set('intent', intent)
  const here = new URL(formAction, 'https://example.test')
  return {
    currentUrl: here,
    currentParams: {},
    nextUrl: here,
    nextParams: {},
    formMethod: 'POST',
    formAction,
    formEncType: 'application/x-www-form-urlencoded',
    formData,
    actionResult: { ok: true },
    actionStatus: 200,
    defaultShouldRevalidate: true,
  }
}

test.each([
  ['another tab of the same page', '/projects?tab=a', '/projects?tab=b'],
  ['other search conditions', '/search?q=alpha', '/search?q=beta&owner=me'],
])('%s keeps the header', (_, current, next) => {
  expect(appShellShouldRevalidate(navigation(current, next, true))).toBe(false)
})

test.each([
  ['another page of the same list', '/files', '/files?page=2'],
  ['a search outside its conditions', '/search?q=a', '/search?q=a&x=1'],
  ['the same URL again', '/files', '/files'],
])('%s follows the router and rereads the header', (_, current, next) => {
  expect(appShellShouldRevalidate(navigation(current, next, true))).toBe(true)
})

test('moving to another page under the shell keeps what the router keeps', () => {
  expect(
    appShellShouldRevalidate(navigation('/settings', '/projects/p1', false)),
  ).toBe(false)
})

test.each([
  ['/settings/tokens', 'create', false],
  ['/set-theme', '', false],
  ['/settings/general', 'update-workspace-name', true],
  ['/settings?index', 'remove-member', true],
  ['/projects/p1', 'seen', true],
  ['/projects/p1', 'leave-project', true],
])(
  'a %s %s submission rereads the header: %s',
  (formAction, intent, rereads) => {
    expect(appShellShouldRevalidate(submission(formAction, intent))).toBe(
      rereads,
    )
  },
)
