// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
  UNSAFE_withComponentProps,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import { userContext } from '~/middleware/context'
import * as dom from '~/test/dom-actions'
import * as settingsLayout from './_layout'
import { SETTINGS_SUBMISSION_SHELL_CHANGES } from './+lib/shell-revalidation'
import SettingsContent from './_content/_layout'
import * as general from './_content/general'
import * as tokens from './_content/tokens'
import * as members from './_content/index'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: async () => [],
}))
// The stored workspace and tokens the real loaders and actions read and write.
const store = vi.hoisted(() => ({
  name: 'Example',
  role: 'owner' as 'owner' | 'admin',
  caseyRole: 'member' as 'owner' | 'member',
  tokens: [] as Array<{
    id: string
    name: string
    createdAt: string
    lastUsedAt: string | null
  }>,
}))
vi.mock('./+lib/settings-request.server', () => ({
  loadSettingsShell: async () => ({
    kind: 'team',
    workspace: {
      id: 'ws1',
      name: store.name,
      hd: null,
      plan: 'team',
      storageUsedBytes: 0,
      storageQuotaBytes: 100,
    },
    currentUserIsAdmin: true,
    currentUserRole: store.role,
  }),
  settingsActiveAdmin: async () => true,
}))
function contributor(id: string, role: 'owner' | 'admin' | 'member') {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    image: null,
    firstContributedAt: null,
    lastContributedAt: null,
    pendingUploads: 0,
    isAdmin: role !== 'member',
    role,
  }
}
vi.mock('~/services/team-management.server', () => ({
  parseMembersPageFilters: () => ({
    query: '',
    role: 'all',
    activity: 'all',
    page: 1,
  }),
  loadWorkspaceMembersPage: async () => ({
    members: [
      contributor('owner', store.role),
      contributor('casey', store.caseyRole),
    ],
    total: 2,
    page: 1,
  }),
  loadRemovedWorkspaceMembers: async () => [],
  transferWorkspaceOwner: async () => {
    store.role = 'admin'
    store.caseyRole = 'owner'
    return { kind: 'ok' }
  },
  loadWorkspaceOwner: async () => null,
  updateWorkspaceName: async (_db: unknown, _user: unknown, name: string) => {
    store.name = name
    return { kind: 'ok' }
  },
}))
vi.mock('~/services/api-tokens.server', () => ({
  listApiTokens: async () => store.tokens,
  createApiToken: async (_db: unknown, _user: string, name: string) => {
    store.tokens.push({
      id: `token-${store.tokens.length}`,
      name,
      createdAt: '2026-05-26T00:00:00.000Z',
      lastUsedAt: null,
    })
    return { token: 'as_test_created', name }
  },
  revokeApiToken: vi.fn(),
}))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: async () => [],
  revokeCliRefreshCredentialFamily: vi.fn(),
  revokeAllCliRefreshCredentialFamilies: vi.fn(),
}))
// The shared chrome is not what this checks.
vi.mock('../../_home/+components/topbar', () => ({ Topbar: () => null }))
vi.mock('../../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => null,
}))

const t = bindI18n('en').t
const here = new URL('https://example.test/settings/tokens')

function submission(
  formAction: string,
  intent: string,
  json: boolean,
): ShouldRevalidateFunctionArgs {
  const formData = new FormData()
  formData.set('intent', intent)
  return {
    currentUrl: here,
    currentParams: {},
    nextUrl: here,
    nextParams: {},
    formMethod: 'POST',
    formAction,
    formEncType: json
      ? 'application/json'
      : 'application/x-www-form-urlencoded',
    formData: json ? undefined : formData,
    json: json ? { intent } : undefined,
    text: undefined,
    actionResult: { ok: true },
    actionStatus: 200,
    defaultShouldRevalidate: true,
  }
}

// Every Settings submission and whether it can change the shell, listed from
// the pages' own forms rather than from the decision's tables.
const SUBMISSIONS = [
  ['/settings?index', 'grant-admin', false, true],
  ['/settings?index', 'revoke-admin', false, true],
  ['/settings?index', 'transfer-owner', false, true],
  ['/settings?index', 'remove-member', false, true],
  ['/settings?index', 'restore-member', false, true],
  ['/settings/general', 'update-workspace-name', false, true],
  ['/settings/billing', 'change-plan', false, true],
  ['/settings/billing', 'checkout', false, true],
  // The transferred files can be unread and count in the header.
  ['/settings?index', 'transfer-removed-assets', false, true],
  // Turning link sharing back on counts shared files as unread again.
  ['/settings/external-access', 'update-external-access', false, true],
  ['/settings?index', 'revoke-cli-sessions', false, false],
  ['/settings/tokens', 'create', false, false],
  ['/settings/tokens', 'revoke', false, false],
  ['/settings/tokens', 'revoke-cli-family', false, false],
  ['/settings/tokens', 'revoke-all-cli-families', false, false],
  ['/settings/bots', 'destinations', true, false],
  ['/settings/bots', 'create', true, false],
  ['/settings/bots', 'stop', true, false],
  ['/settings/bots', 'cancel', true, false],
  ['/settings/bots', 'reissue', true, false],
  ['/settings/integrations', 'disconnect-slack', false, false],
  ['/settings/external-access', 'preview-external-access', false, false],
  ['/settings/billing', 'portal', false, false],
  ['/set-analytics-consent', '', false, false],
  // The header's theme switch, available on every Settings page.
  ['/set-theme', '', false, false],
  ['/settings/tokens', 'something-new', false, true],
  ['/settings/other', 'create', false, true],
] as const

test.each(SUBMISSIONS)(
  'a %s %s submission (JSON: %s) rereads the shell: %s',
  (action, intent, json, rereads) => {
    expect(
      settingsLayout.shouldRevalidate(submission(action, intent, json)),
    ).toBe(rereads)
  },
)

test('the decision table lists no submission this file does not check', () => {
  const checked = new Set(
    SUBMISSIONS.map(([action, intent]) => {
      const path = action.replace('?index', '')
      return `${path} ${intent || '*'}`
    }),
  )
  const listed = Object.entries(SETTINGS_SUBMISSION_SHELL_CHANGES).flatMap(
    ([path, intents]) => Object.keys(intents).map((i) => `${path} ${i}`),
  )
  expect(listed.filter((entry) => !checked.has(entry))).toEqual([])
})

test('a submission that moves to another entry keeps the router decision', () => {
  const args = {
    ...submission('/settings/tokens', 'create', false),
    nextUrl: new URL('https://example.test/settings/general'),
  }
  expect(settingsLayout.shouldRevalidate(args)).toBe(true)
  expect(
    settingsLayout.shouldRevalidate({
      ...args,
      defaultShouldRevalidate: false,
    }),
  ).toBe(false)
})

test.each([
  ['a trailing slash', 'https://example.test/settings/tokens/'],
  ['another hash', 'https://example.test/settings/tokens#cli'],
])(
  'a neutral submission seen from %s of the same page keeps the shell',
  (_, current) => {
    expect(
      settingsLayout.shouldRevalidate({
        ...submission('/settings/tokens', 'create', false),
        currentUrl: new URL(current),
      }),
    ).toBe(false)
  },
)

// The router matches Settings paths case-insensitively and percent-decoded.
test.each(['/SETTINGS/INTEGRATIONS', '/settings/%69ntegrations'])(
  'a neutral submission on the variant Settings URL %s keeps the shell',
  (path) => {
    const current = new URL(`https://example.test${path}`)
    expect(
      settingsLayout.shouldRevalidate({
        ...submission(path, 'disconnect-slack', false),
        currentUrl: current,
        nextUrl: current,
      }),
    ).toBe(false)
  },
)

test('a neutral submission seen from another query of the page rereads the shell', () => {
  expect(
    settingsLayout.shouldRevalidate({
      ...submission('/settings/tokens', 'create', false),
      currentUrl: new URL('https://example.test/settings/tokens?tab=cli'),
    }),
  ).toBe(true)
})

test.each([
  ['a navigation', { formMethod: undefined, formAction: undefined }],
  ['an explicit or external-return revalidation', {}],
])('%s keeps the router decision', (_, override) => {
  const args: ShouldRevalidateFunctionArgs = {
    currentUrl: here,
    currentParams: {},
    nextUrl: here,
    nextParams: {},
    defaultShouldRevalidate: true,
    ...override,
  }
  expect(settingsLayout.shouldRevalidate(args)).toBe(true)
})

beforeEach(() => {
  store.name = 'Example'
  store.role = 'owner'
  store.caseyRole = 'member'
  store.tokens = []
})

/** Each request the router makes gets its own context, as on the server. */
function requestArgs(args: LoaderFunctionArgs, pattern: string) {
  const context = new RouterContextProvider()
  context.set(userContext, {
    id: 'owner',
    email: 'owner@example.com',
    emailVerified: true,
    workspaceId: 'ws1',
    kind: 'human',
    name: null,
    image: null,
    locale: null,
    hd: null,
    msTenantId: null,
  })
  return {
    ...args,
    context,
    params: {},
    pattern,
    url: new URL(args.request.url),
  }
}

test('a hydrated Settings page keeps its shell after creating a token and refreshes it after a rename', async () => {
  const shellReads = vi.fn((args: LoaderFunctionArgs) =>
    settingsLayout.loader(requestArgs(args, '/settings')),
  )
  const router = createMemoryRouter(
    [
      {
        path: '/settings',
        loader: shellReads,
        shouldRevalidate: settingsLayout.shouldRevalidate,
        Component: UNSAFE_withComponentProps(settingsLayout.default),
        children: [
          {
            Component: SettingsContent,
            children: [
              {
                path: 'tokens',
                loader: (args) =>
                  tokens.loader(requestArgs(args, '/settings/tokens')),
                action: (args) =>
                  tokens.action(requestArgs(args, '/settings/tokens')),
                Component: UNSAFE_withComponentProps(tokens.default),
              },
              {
                path: 'general',
                loader: (args) =>
                  general.loader(requestArgs(args, '/settings/general')),
                action: (args) =>
                  general.action(requestArgs(args, '/settings/general')),
                Component: UNSAFE_withComponentProps(general.default),
              },
              {
                index: true,
                loader: (args) =>
                  members.loader(requestArgs(args, '/settings')),
                action: (args) =>
                  members.action(requestArgs(args, '/settings')),
                Component: UNSAFE_withComponentProps(members.default),
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/settings/tokens'] },
  )
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const breadcrumb = () =>
    container.querySelector('nav a[href="/"]')?.textContent
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>,
      ),
    )
    await vi.waitFor(() => expect(breadcrumb()).toBe('Example'))
    expect(shellReads).toHaveBeenCalledTimes(1)

    // A shell-neutral submission refreshes the token list only.
    await dom.fill(
      await dom.find(() => container.querySelector<HTMLElement>('#token-name')),
      'Deploy key',
    )
    await dom.press(
      await dom.find(() =>
        dom.byRole(container, 'button', t('team.tokens.create')),
      ),
    )
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll('td, li, span')].some(
          (cell) => cell.textContent === 'Deploy key',
        ),
      ).toBe(true),
    )
    await vi.waitFor(() => expect(router.state.revalidation).toBe('idle'))
    expect(shellReads).toHaveBeenCalledTimes(1)

    // A rename rereads the shell, and the page shows the new name.
    await act(() => router.navigate('/settings/general'))
    await dom.fill(
      await dom.find(() =>
        container.querySelector<HTMLElement>('#workspace-name'),
      ),
      'Renamed workspace',
    )
    await dom.press(
      await dom.find(() =>
        dom.byRole(container, 'button', t('team.workspace.name.save')),
      ),
    )
    await vi.waitFor(() => expect(breadcrumb()).toBe('Renamed workspace'))
    expect(shellReads).toHaveBeenCalledTimes(2)

    // Handing ownership over rereads the shell, and the owner-only controls
    // give way to the admin's guidance.
    await act(() => router.navigate('/settings'))
    await dom.press(
      await dom.find(() =>
        dom.byRole(container, 'button', t('team.members.menu')),
      ),
    )
    await dom.press(
      await dom.find(() =>
        dom.byRole(document.body, 'menuitem', t('team.members.transferOwner')),
      ),
    )
    await dom.press(
      await dom.find(() =>
        dom.byRole(
          document.body,
          'button',
          t('team.members.transferOwnerConfirm.action'),
        ),
      ),
    )
    await vi.waitFor(() =>
      expect(container.textContent).toContain(t('team.members.ownerActions')),
    )
    expect(shellReads).toHaveBeenCalledTimes(3)
  } finally {
    act(() => root.unmount())
    container.remove()
    router.dispose()
  }
})
