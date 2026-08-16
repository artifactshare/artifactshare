import assert from 'node:assert/strict'
import test from 'node:test'
import { checkScreenLedger, hasDefaultExport } from './check-screen-ledger.mjs'
import {
  CaptureFailure,
  assertNoRouteError,
  browserLaunchOptions,
  navigateForCapture,
  pathFor,
  waitForInteractionTarget,
  captureFailure,
  screenStateRequestHeaders,
  waitForReady,
} from './screen-capture.mjs'
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

test('requires a valid scenario for a scenario artifact index', () => {
  assert.throws(
    () =>
      validateLedger([
        ledgerScreen([{ id: 'default', setup: { scenarioArtifactIndex: 1 } }]),
      ]),
    /scenario artifact index requires a scenario and a positive integer/,
  )
  assert.throws(
    () =>
      validateLedger([
        ledgerScreen([
          {
            id: 'default',
            setup: {
              scenario: 'recent/content-rich',
              scenarioArtifactIndex: 0,
            },
          },
        ]),
      ]),
    /scenario artifact index requires a scenario and a positive integer/,
  )
})

test('routes a seeded state to its scenario artifact', () => {
  const path = pathFor(
    { route: { en: '/a/{seed:artifact}' }, auth: 'free-owner' },
    'en',
    {
      artifact: 'generic-artifact',
      project: null,
      update: 'latest',
      scenarioCookies: {
        'free-owner:recent/content-rich': {
          workspaceId: 'workspace',
          userId: 'viewer',
          containerKind: 'inbox',
          containerId: 'container',
        },
      },
    },
    {
      setup: {
        scenario: 'recent/content-rich',
        scenarioArtifactIndex: 21,
      },
    },
  )

  assert.equal(path, '/a/workspace-viewer-file-21')
})

test('accepts a declared screen readiness condition', () =>
  assert.equal(
    validateLedger([
      {
        ...ledgerScreen([{ id: 'default', setup: {} }]),
        ready: {
          selector: '[data-state="ready"]',
          description: 'viewer ready',
          timeoutMs: 5_000,
        },
      },
    ]),
    true,
  ))

test('validates a screen capture concurrency limit', () => {
  const state = [{ id: 'default', setup: {} }]
  assert.equal(
    validateLedger([{ ...ledgerScreen(state), captureConcurrency: 1 }]),
    true,
  )
  assert.throws(
    () => validateLedger([{ ...ledgerScreen(state), captureConcurrency: 0 }]),
    /capture concurrency must be positive for fixture/,
  )
})

test('rejects incomplete or invalid readiness conditions', () => {
  const state = [{ id: 'default', setup: {} }]
  assert.throws(
    () =>
      validateLedger([
        {
          ...ledgerScreen(state),
          ready: { selector: '', description: 'ready' },
        },
      ]),
    /ready selector required/,
  )
  assert.throws(
    () =>
      validateLedger([
        {
          ...ledgerScreen(state),
          ready: { selector: '.ready', description: '', timeoutMs: 0 },
        },
      ]),
    /ready description required/,
  )
  assert.throws(
    () =>
      validateLedger([
        {
          ...ledgerScreen(state),
          ready: { selector: '.ready', description: 'ready', timeoutMs: 0 },
        },
      ]),
    /ready timeout must be positive/,
  )
})

test('preserves typed capture failures for manifest reporting', () => {
  assert.deepEqual(
    captureFailure(
      new CaptureFailure('readiness_timeout', 'viewer not ready', {
        condition: 'sandbox frame ready',
        timeoutMs: 30_000,
      }),
    ),
    {
      kind: 'readiness_timeout',
      message: 'viewer not ready',
      condition: 'sandbox frame ready',
      timeoutMs: 30_000,
    },
  )
  assert.deepEqual(captureFailure(new Error('unknown failure')), {
    kind: 'capture_failure',
    message: 'unknown failure',
  })
})

test('classifies a rendered route error without exposing its stack', async () => {
  const textLocator = (text) => ({
    count: () => Promise.resolve(1),
    first: () => textLocator(text),
    innerText: () => Promise.resolve(text),
  })
  const root = {
    getAttribute: () => Promise.resolve('route-error-boundary'),
    locator: (selector) =>
      selector.includes('heading')
        ? textLocator('Oops!')
        : textLocator('Bad Request'),
  }
  const page = {
    locator: () => ({
      count: () => Promise.resolve(1),
      first: () => root,
    }),
  }

  await assert.rejects(
    assertNoRouteError(page),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'screen_error' &&
      error.message ===
        'screen rendered route-error-boundary: Oops! — Bad Request',
  )
})

test('classifies a marker without heading or details immediately', async () => {
  const root = {
    getAttribute: () => Promise.resolve('viewer-route-error-boundary'),
    locator: () => ({ count: () => Promise.resolve(0) }),
  }
  const page = {
    locator: () => ({
      count: () => Promise.resolve(1),
      first: () => root,
    }),
  }

  await assert.rejects(
    assertNoRouteError(page),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'screen_error' &&
      error.message === 'screen rendered viewer-route-error-boundary',
  )
})

test('classifies rejected and unsuccessful navigation', async () => {
  await assert.rejects(
    navigateForCapture(
      { goto: () => Promise.reject(new Error('connection refused')) },
      'https://localhost/',
    ),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'navigation_failure' &&
      error.message === 'navigation failed: connection refused',
  )
  await assert.rejects(
    navigateForCapture(
      {
        goto: () => Promise.resolve({ ok: () => false, status: () => 503 }),
      },
      'https://localhost/',
    ),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'navigation_failure' &&
      error.message === 'navigation failed: HTTP 503',
  )
})

test('classifies an unmet screen readiness contract', async () => {
  const page = {
    locator: (selector) => ({
      count: () =>
        Promise.resolve(selector === '[data-screen-capture-error]' ? 0 : 1),
      waitFor: () => Promise.reject(new Error('timeout')),
    }),
  }

  await assert.rejects(
    waitForReady(page, {
      selector: '[data-state="ready"]',
      description: 'viewer ready',
      timeoutMs: 25,
    }),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'readiness_timeout' &&
      error.details.condition === 'viewer ready' &&
      error.details.timeoutMs === 25,
  )
})

test('waits for a delayed interaction target before acting', async () => {
  let waitOptions
  const page = {
    locator: () => ({
      waitFor: (options) => {
        waitOptions = options
        return Promise.resolve()
      },
    }),
  }

  await waitForInteractionTarget(page, {
    action: 'click',
    selector: '[aria-label="Updates"]',
  })
  assert.deepEqual(waitOptions, { state: 'visible' })
})

test('classifies a missing interaction target as a precondition failure', async () => {
  const page = {
    locator: () => ({ waitFor: () => Promise.reject(new Error('timeout')) }),
  }

  await assert.rejects(
    waitForInteractionTarget(page, {
      action: 'hover',
      selector: '[data-help]',
    }),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'interaction_precondition' &&
      error.details.action === 'hover' &&
      error.details.selector === '[data-help]',
  )
})

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

test('maps local sandbox hostnames for both bundled and installed browsers', () => {
  assert.deepEqual(browserLaunchOptions(undefined), {
    args: ['--host-resolver-rules=MAP *.sandbox.localhost 127.0.0.1'],
  })
  assert.deepEqual(browserLaunchOptions('chrome'), {
    channel: 'chrome',
    args: ['--host-resolver-rules=MAP *.sandbox.localhost 127.0.0.1'],
  })
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
