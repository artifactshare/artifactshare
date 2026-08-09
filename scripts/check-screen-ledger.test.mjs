import assert from 'node:assert/strict'
import test from 'node:test'
import { checkScreenLedger, hasDefaultExport } from './check-screen-ledger.mjs'
import { screenStateRequestHeaders } from './screen-capture.mjs'
import {
  screenScenarioAllowlist,
  screens as ledgerScreens,
  validateLedger,
} from './screen-ledger.mjs'

const routeTree = [
  {
    path: 'settings',
    children: [{ path: 'profile', file: 'routes/settings/profile.tsx' }],
  },
]
const screens = [{ id: 'profile', route: { en: '/settings/profile' } }]

test('accepts both default export forms', () => {
  assert.equal(hasDefaultExport('export default function Profile() {}'), true)
  assert.equal(
    hasDefaultExport(
      'const Profile = () => null\nexport { Profile as default }',
    ),
    true,
  )
  assert.equal(hasDefaultExport('export async function loader() {}'), false)
  assert.equal(
    hasDefaultExport('// export default is intentionally omitted'),
    false,
  )
  assert.equal(hasDefaultExport("const note = 'export default'"), false)
  assert.equal(
    hasDefaultExport("export { default as Profile } from './profile'"),
    false,
  )
})
test('accepts a route with a default export', () =>
  assert.deepEqual(
    checkScreenLedger({
      screens,
      excludedRoutes: [],
      loadRouteTree: () => routeTree,
      readRouteSource: () => 'export default function Profile() {}',
    }),
    [],
  ))
test('rejects a route without a default export', () =>
  assert.deepEqual(
    checkScreenLedger({
      screens,
      excludedRoutes: [],
      loadRouteTree: () => routeTree,
      readRouteSource: () => 'export async function loader() {}',
    }),
    [
      'route without default export: settings/profile.tsx (path /settings/profile) — remove it from screens or add a default export',
    ],
  ))
test('accepts an excluded loader-only route', () =>
  assert.deepEqual(
    checkScreenLedger({
      screens: [],
      excludedRoutes: [
        { file: 'settings/profile.tsx', reason: 'data-only route' },
      ],
      loadRouteTree: () => routeTree,
      readRouteSource: () => 'export async function loader() {}',
    }),
    [],
  ))
test('rejects a route registered as both a screen and an exclusion', () =>
  assert.deepEqual(
    checkScreenLedger({
      screens,
      excludedRoutes: [
        { file: 'settings/profile.tsx', reason: 'data-only route' },
      ],
      loadRouteTree: () => routeTree,
      readRouteSource: () => 'export async function loader() {}',
    }),
    [
      'conflicting route classification: settings/profile.tsx (path /settings/profile) is both profile (en) and excluded',
      'route without default export: settings/profile.tsx (path /settings/profile) — remove it from screens or add a default export',
    ],
  ))

const ledgerScreen = (states) => ({
  id: 'fixture',
  route: { en: '/fixture' },
  auth: 'anonymous',
  loop: 'support',
  states,
})

test('rejects duplicate state ids within a screen', () =>
  assert.throws(
    () =>
      validateLedger([
        ledgerScreen([
          { id: 'default', setup: {} },
          { id: 'default', setup: {} },
        ]),
      ]),
    /duplicate state id: fixture\/default/,
  ))

test('rejects an unknown screen scenario', () =>
  assert.throws(
    () =>
      validateLedger([
        ledgerScreen([
          { id: 'default', setup: {} },
          { id: 'seeded', setup: { scenario: 'unknown/scenario' } },
        ]),
      ]),
    /unknown scenario: unknown\/scenario/,
  ))

test('adds the scenario header only to a seeded state job', () => {
  assert.deepEqual(screenStateRequestHeaders({ setup: {} }), {})
  assert.deepEqual(
    screenStateRequestHeaders({
      setup: { scenario: 'settings-billing/subscribed' },
    }),
    {
      'X-ArtifactShare-Dev-Screen-State': 'settings-billing/subscribed',
    },
  )
})

test('keeps the scenario allowlist and ledger references in sync', () => {
  const ledgerScenarios = ledgerScreens.flatMap((screen) =>
    screen.states.flatMap((state) =>
      state.setup?.scenario ? [state.setup.scenario] : [],
    ),
  )

  assert.deepEqual(
    [...new Set(ledgerScenarios)].sort(),
    [...screenScenarioAllowlist].sort(),
  )
})

test('captures project activity with representative feed events', () => {
  const projectActivity = ledgerScreens.find(
    (screen) => screen.id === 'project-activity',
  )

  assert.deepEqual(
    projectActivity?.states.find((state) => state.id === 'content-rich')?.setup,
    { scenario: 'project-detail/with-files' },
  )
})
