import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkScreenLedger, hasDefaultExport } from './check-screen-ledger.mjs'
import {
  CaptureFailure,
  assertNoRouteError,
  browserLaunchOptions,
  needsLocalSandbox,
  devShareableId,
  navigateForCapture,
  parseArgs,
  pathFor,
  planCaptureJobs,
  runCaptureJobs,
  waitForInteractionTarget,
  captureFailure,
  captureUrlForState,
  assertCaptureServerHead,
  cleanCaptureHead,
  screenStateRequestHeaders,
  screenStateAuth,
  screenStateSeedAuth,
  shouldHoldUpload,
  waitForReady,
} from './screen-capture.mjs'

import {
  discoverRouteModules,
  loadScreenSpecModules,
  readScreenSpec,
  screenScenarioAllowlist,
  screenSpecModules,
  screens as ledgerScreens,
  validateLedger,
} from './screen-ledger.mjs'

test('viewer retention history capture opens the seeded latest-only artifact', () => {
  const viewer = ledgerScreens.find((screen) => screen.id === 'viewer')
  const state = viewer.states.find(
    (candidate) => candidate.id === 'history-retention-open',
  )
  assert.ok(state)
  assert.equal(state.setup.scenario, 'recent/content-rich')
  assert.equal(state.setup.scenarioArtifactIndex, 1)
  assert.deepEqual(state.setup.interactions.slice(0, 2), [
    { action: 'click', selector: '[data-viewer-more-menu-trigger]' },
    { action: 'click', selector: '[data-viewer-history-menu-item]' },
  ])
})

test('billing captures default to the purchase seed and keep the purchase variants and checkout error', () => {
  const billing = ledgerScreens.find(
    (screen) => screen.id === 'settings-billing',
  )
  const state = (id) => billing.states.find((candidate) => candidate.id === id)
  assert.equal(state('default').setup.scenario, 'settings-billing/purchase')
  assert.match(state('default').setup.ready.selector, /\[data-plan="team"\]/)
  assert.deepEqual(
    ['monthly-jpy', 'monthly-usd', 'yearly-jpy', 'yearly-usd'].map((id) => [
      state(id).setup.scenario,
      state(id).setup.query,
    ]),
    [
      ['settings-billing/purchase', '?interval=monthly&currency=jpy'],
      ['settings-billing/purchase', '?interval=monthly&currency=usd'],
      ['settings-billing/purchase', '?interval=yearly&currency=jpy'],
      ['settings-billing/purchase', '?interval=yearly&currency=usd'],
    ],
  )
  const error = state('result-error').setup
  assert.equal(error.scenario, 'settings-billing/purchase')
  assert.deepEqual(error.interactions, [
    { action: 'click', selector: '[data-plan="plus"] button[type="submit"]' },
  ])
  assert.deepEqual(error.actionResponse, {
    route: '/settings/billing',
    method: 'POST',
    intent: 'checkout',
    status: 409,
    data: { ok: false, code: 'billing-unavailable', intent: 'checkout' },
  })
  assert.ok(
    error.postInteractionReady.visibleWith.includes(
      '[data-plan="plus"] form [role="alert"][data-settings-status="billing-unavailable"]',
    ),
  )
  for (const retired of ['team-unsubscribed', 'team-unsubscribed-high-usage']) {
    assert.equal(state(retired), undefined)
    assert.equal(
      screenScenarioAllowlist.has(`settings-billing/${retired}`),
      false,
    )
  }
})

test('screens:capture plans no billing state and names them in one line; the local mode argument plans them', (t) => {
  const contractStates = ledgerScreens
    .find((screen) => screen.id === 'settings-billing')
    .states.map((state) => `settings-billing/${state.id}`)
  const screenIds = ['settings-billing', 'settings-general']
  const argv = screenIds.flatMap((id) => ['--screen', id])
  // Every capture of a state: each locale, both viewports and both themes.
  const allJobIds = ledgerScreens
    .filter((screen) => screenIds.includes(screen.id))
    .flatMap((screen) =>
      screen.states.flatMap((state) =>
        Object.keys(screen.route).flatMap((locale) =>
          ['desktop', 'mobile'].flatMap((viewport) =>
            ['light', 'dark'].map(
              (theme) =>
                `${screen.id}/${state.id}/${viewport}/${theme}/${locale}`,
            ),
          ),
        ),
      ),
    )
    .sort()
  const jobIds = (plan) => plan.jobs.map((job) => job.id).sort()
  const isContractJob = (id) =>
    contractStates.some((state) => id.startsWith(`${state}/`))

  // The variable an earlier version read does not select the local mode.
  const inherited = process.env.LOCAL_CAPTURE_FAKE_STRIPE
  t.after(() => {
    if (inherited === undefined) delete process.env.LOCAL_CAPTURE_FAKE_STRIPE
    else process.env.LOCAL_CAPTURE_FAKE_STRIPE = inherited
  })
  process.env.LOCAL_CAPTURE_FAKE_STRIPE = '1'
  const plainArgs = parseArgs(argv)
  assert.equal(plainArgs.local, false)
  const plain = planCaptureJobs(plainArgs.selected, { local: plainArgs.local })
  assert.deepEqual(
    jobIds(plain),
    allJobIds.filter((id) => !isContractJob(id)),
  )
  assert.equal(plain.notice.split('\n').length, 1)
  for (const id of contractStates) assert.ok(plain.notice.includes(id), id)
  assert.match(plain.notice, /pnpm screens:capture:local/u)

  const localArgs = parseArgs(['--local-fake-stripe', ...argv])
  assert.equal(localArgs.local, true)
  const local = planCaptureJobs(localArgs.selected, { local: localArgs.local })
  assert.deepEqual(jobIds(local), allJobIds)
  assert.ok(allJobIds.some(isContractJob))
  assert.equal(local.notice, null)
})

test('allows a state to capture anonymously from an authenticated scenario seed', () => {
  const screen = { auth: 'team-owner' }
  const state = {
    setup: {
      auth: 'anonymous',
      seedAuth: 'team-owner',
      scenario: 'recent/content-rich',
    },
  }
  assert.equal(screenStateAuth(screen, state), 'anonymous')
  assert.equal(screenStateSeedAuth(screen, state), 'team-owner')
})

test('captures anonymous viewers on the per-ID link host', () => {
  assert.equal(
    captureUrlForState(
      'https://localhost:5173',
      '/a/abc123def4?theme=dark',
      'anonymous',
    ).toString(),
    'https://abc123def4.localhost:5173/?theme=dark',
  )
  assert.equal(
    captureUrlForState(
      'https://localhost:5173',
      '/a/abc123def4',
      'team-owner',
    ).toString(),
    'https://localhost:5173/a/abc123def4',
  )
})

test('requires a clean committed checkout before stamping capture evidence', () => {
  const dirty = (_file, args) =>
    args[0] === 'status' ? ' M app.tsx' : `${'a'.repeat(40)}\n`
  assert.throws(() => cleanCaptureHead(dirty), /clean checkout/u)
  const clean = (_file, args) =>
    args[0] === 'status' ? '' : `${'a'.repeat(40)}\n`
  assert.equal(cleanCaptureHead(clean), 'a'.repeat(40))
})

test('requires the app dev server to run the capture checkout HEAD', async () => {
  const head = 'a'.repeat(40)
  await assert.rejects(
    () => assertCaptureServerHead('https://localhost:1', head),
    /not running the clean checkout HEAD/u,
  )
})

test('holds immediate upload captures before persistence completes', () => {
  assert.equal(
    shouldHoldUpload([{ action: 'setInputFiles', captureImmediately: true }]),
    true,
  )
  assert.equal(
    shouldHoldUpload([{ action: 'setInputFiles', captureImmediately: false }]),
    false,
  )
})

const routeTree = [
  {
    path: 'settings',
    children: [{ path: 'profile', file: 'routes/settings/profile.tsx' }],
  },
]
const screens = [{ id: 'profile', route: { en: '/settings/profile' } }]

function exportedFunctionBody(source, name) {
  const declaration = source.indexOf(`export function ${name}(`)
  assert.notEqual(declaration, -1, `missing export function ${name}`)
  const openingBrace = source.indexOf('{', declaration)
  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBrace, index + 1)
  }
  assert.fail(`unterminated export function ${name}`)
}

test('screen capture devShareableId stays identical to the scenario seeder', () => {
  const captureSource = readFileSync(
    new URL('./screen-capture.mjs', import.meta.url),
    'utf8',
  )
  const seederSource = readFileSync(
    new URL(
      '../apps/web/app/services/dev-screen-state.server.ts',
      import.meta.url,
    ),
    'utf8',
  )
  assert.equal(
    exportedFunctionBody(captureSource, 'devShareableId'),
    exportedFunctionBody(seederSource, 'devShareableId'),
  )
})

test('accepts both default export forms', () => {
  assert.equal(hasDefaultExport('export default function Profile() {}'), true)
  assert.equal(
    hasDefaultExport(
      'const Profile = () => null\nexport { Profile as default }',
    ),
    true,
  )
  assert.equal(hasDefaultExport("export { default } from './profile'"), true)
  assert.equal(
    hasDefaultExport(
      'const Profile = () => null\nexport { Profile as "default" }',
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

test('discovers typed screen specifications from route modules', () => {
  const routeModules = discoverRouteModules()
  assert.ok(routeModules.length > screenSpecModules.length)
  for (const page of [
    'about',
    'connect',
    'pricing',
    'privacy',
    'start',
    'terms',
    'tokushoho',
  ]) {
    assert.ok(!routeModules.includes(`ja.${page}.tsx`))
    assert.ok(routeModules.includes(`_public/($locale)/${page}.tsx`))
  }
  assert.ok(routeModules.every((file) => !/\.test\.(?:ts|tsx)$|\+/u.test(file)))
  assert.ok(
    screenSpecModules.some(
      ({ screen }) =>
        screen.id === 'guides-search' &&
        screen.route.en === '/guides/search' &&
        screen.route.ja === '/ja/guides/search',
    ),
  )
  assert.equal(screenSpecModules.length, 41)
  assert.equal(
    new Set(screenSpecModules.map(({ screen }) => screen.id)).size,
    41,
  )
})

const typedScreenSource = `
  export const screen = {
    id: 'profile',
    route: { en: '/settings/profile' },
    auth: 'anonymous',
    loop: 'support',
    metric: 'metric',
    role: 'role',
    primaryAction: 'action',
    states: [{ id: 'default', description: 'default', setup: {} }],
  } satisfies ScreenSpec
  export default function Profile() {}
`

test('only route-tree leaves can contribute screen specifications', () => {
  const sources = new Map([
    ['settings/profile.tsx', typedScreenSource],
    ['settings/profile.test.tsx', typedScreenSource],
    ['settings/+helper.ts', typedScreenSource],
    ['settings/layout.tsx', typedScreenSource],
  ])
  const tree = [
    {
      path: 'settings',
      file: 'routes/settings/layout.tsx',
      children: [{ path: 'profile', file: 'routes/settings/profile.tsx' }],
    },
  ]
  const readFiles = []
  const readRouteSource = (file) => {
    readFiles.push(file)
    return sources.get(file)
  }
  const options = {
    routeTree: tree,
    readRouteSource,
  }
  const check = () =>
    checkScreenLedger({
      excludedRoutes: [],
      loadRouteTree: () => tree,
      readRouteSource,
    })

  assert.deepEqual(
    loadScreenSpecModules(options).map(({ file }) => file),
    ['settings/profile.tsx'],
  )
  assert.deepEqual(check(), [])
  assert.ok(readFiles.every((file) => file === 'settings/profile.tsx'))

  // Valid-looking ignored exports cannot cover a leaf missing its own export.
  sources.set('settings/profile.tsx', 'export default function Profile() {}')
  assert.deepEqual(loadScreenSpecModules(options), [])
  assert.deepEqual(check(), [
    'route without screen export: settings/profile.tsx — add an export const screen that satisfies ScreenSpec',
  ])

  // Once configured as a leaf, the same module enters discovery AND validation.
  tree[0].children = [{ path: 'profile', file: 'routes/settings/+helper.ts' }]
  sources.set(
    'settings/+helper.ts',
    typedScreenSource.replace("auth: 'anonymous'", "auth: 'invalid'"),
  )
  assert.deepEqual(
    loadScreenSpecModules(options).map(({ file }) => file),
    ['settings/+helper.ts'],
  )
  assert.deepEqual(check(), ['invalid auth for profile'])
})

test('discovers route exports and rejects a leaf without a screen export', () => {
  const discoveryRouteTree = [
    {
      path: 'settings',
      children: [
        { path: 'profile', file: 'routes/settings/profile.tsx' },
        { path: 'new', file: 'routes/settings/new.tsx' },
      ],
    },
  ]
  const sources = new Map([
    ['settings/profile.tsx', typedScreenSource],
    ['settings/new.tsx', 'export default function New() {}'],
  ])

  assert.deepEqual(
    checkScreenLedger({
      excludedRoutes: [],
      loadRouteTree: () => discoveryRouteTree,
      readRouteSource: (file) => sources.get(file),
    }),
    [
      'route without screen export: settings/new.tsx — add an export const screen that satisfies ScreenSpec',
    ],
  )
})

for (const duplicatePath of ['profile/:id', 'profile/:otherId/']) {
  test(`rejects a missing screen export masked by normalized path ${duplicatePath}`, () => {
    const sources = new Map([
      [
        'settings/profile.tsx',
        typedScreenSource.replace('/settings/profile', '/settings/profile/:id'),
      ],
      ['settings/duplicate.tsx', 'export default function Duplicate() {}'],
    ])

    assert.deepEqual(
      checkScreenLedger({
        excludedRoutes: [],
        loadRouteTree: () => [
          {
            path: 'settings',
            children: [
              { path: 'profile/:id', file: 'routes/settings/profile.tsx' },
              { path: duplicatePath, file: 'routes/settings/duplicate.tsx' },
            ],
          },
        ],
        readRouteSource: (file) => sources.get(file),
      }),
      [
        'route without screen export: settings/duplicate.tsx — add an export const screen that satisfies ScreenSpec',
      ],
    )
  })
}

test('requires locale wrappers to have a matching canonical sibling screen', () => {
  const localeSource = typedScreenSource.replace(
    "en: '/settings/profile'",
    "en: '/settings/profile', ja: '/ja/settings/profile'",
  )
  const sources = new Map([
    ['profile.tsx', localeSource],
    ['ja.profile.tsx', 'export default function JaProfile() {}'],
  ])
  const options = {
    excludedRoutes: [],
    loadRouteTree: () => [
      { path: 'settings/profile', file: 'routes/profile.tsx' },
      { path: 'ja/settings/profile', file: 'routes/ja.profile.tsx' },
    ],
    readRouteSource: (file) => sources.get(file),
  }
  const missingExport =
    'route without screen export: ja.profile.tsx — add an export const screen that satisfies ScreenSpec'

  assert.deepEqual(checkScreenLedger(options), [])

  sources.set('ja.profile.tsx', 'export function loader() {}')
  assert.deepEqual(checkScreenLedger(options), [
    'route without default export: ja.profile.tsx (path /ja/settings/profile) — remove it from screens or add a default export',
  ])
  sources.set('ja.profile.tsx', 'export default function JaProfile() {}')

  sources.set('profile.tsx', typedScreenSource)
  assert.deepEqual(checkScreenLedger(options), [missingExport])

  sources.set(
    'profile.tsx',
    localeSource.replace('/ja/settings/profile', '/ja/settings/missing'),
  )
  assert.deepEqual(checkScreenLedger(options), [
    'wrong Settings capture route: profile/default /ja/settings/missing (owner /settings/profile)',
    missingExport,
    'dangling ledger entry: profile (ja) points at /ja/settings/missing which has no route',
  ])

  sources.set('profile.tsx', 'export default function Profile() {}')
  assert.deepEqual(checkScreenLedger(options), [
    'route without screen export: profile.tsx — add an export const screen that satisfies ScreenSpec',
    missingExport,
  ])

  sources.set(
    'profile.tsx',
    localeSource
      .replaceAll('/settings/profile', '/settings/billing')
      .replace('/ja/settings/billing', '/ja/settings/billing/')
      .replace('setup: {}', "setup: { query: '?status=checkout-success' }"),
  )
  assert.deepEqual(
    checkScreenLedger({
      ...options,
      loadRouteTree: () => [
        { path: 'settings/billing', file: 'routes/profile.tsx' },
        { path: 'ja/settings/billing', file: 'routes/ja.profile.tsx' },
      ],
    }),
    [],
  )
  sources.set('profile.tsx', 'export default function Profile() {}')

  // An unrelated module with the same paths cannot stand in for the sibling.
  sources.set('unrelated.tsx', localeSource)
  assert.deepEqual(
    checkScreenLedger({
      ...options,
      loadRouteTree: () => [
        { path: 'settings/profile', file: 'routes/unrelated.tsx' },
        { path: 'ja/settings/profile', file: 'routes/ja.profile.tsx' },
      ],
    }),
    [
      'wrong Settings capture route: profile/default /ja/settings/profile (owner /settings/profile)',
      missingExport,
    ],
  )
})

test('accepts one screen route module under an optional locale layout', () => {
  const localeSource = typedScreenSource.replace(
    "en: '/settings/profile'",
    "en: '/guides/cli', ja: '/ja/guides/cli'",
  )
  const file = '_public/($locale)/guides.cli.tsx'

  assert.deepEqual(
    checkScreenLedger({
      excludedRoutes: [],
      loadRouteTree: () => [
        {
          path: ':locale?',
          file: 'routes/_public/($locale)/_layout.tsx',
          children: [{ path: 'guides/cli', file: `routes/${file}` }],
        },
      ],
      readRouteSource: (routeFile) => {
        assert.equal(routeFile, file)
        return localeSource
      },
    }),
    [],
  )
})

test('rejects a screen export whose declared route is not in the route tree', () => {
  const danglingRouteTree = [
    {
      path: 'settings',
      children: [{ path: 'profile', file: 'routes/settings/profile.tsx' }],
    },
  ]
  const sources = new Map([
    [
      'settings/profile.tsx',
      typedScreenSource.replace('/settings/profile', '/settings/missing'),
    ],
  ])

  assert.deepEqual(
    checkScreenLedger({
      excludedRoutes: [],
      loadRouteTree: () => danglingRouteTree,
      readRouteSource: (file) => sources.get(file),
    }),
    [
      'wrong Settings capture route: profile/default /settings/missing (owner /settings/profile)',
      'uncovered route: settings/profile.tsx (path /settings/profile) — add it to screens or excludedRoutes in scripts/check-screen-ledger.mjs',
      'dangling ledger entry: profile (en) points at /settings/missing which has no route',
    ],
  )
})

test('reads a static screen export without importing the route module', () => {
  assert.deepEqual(
    readScreenSpec(
      `export const screen = {
        id: 'fixture',
        route: { en: '/fixture' },
        auth: 'anonymous',
        loop: 'support',
        metric: 'metric',
        role: 'role',
        primaryAction: 'action',
        states: [{ id: 'default', description: 'default', setup: {} }],
      } satisfies ScreenSpec`,
      'fixture.tsx',
    ),
    {
      id: 'fixture',
      route: { en: '/fixture' },
      auth: 'anonymous',
      loop: 'support',
      metric: 'metric',
      role: 'role',
      primaryAction: 'action',
      states: [{ id: 'default', description: 'default', setup: {} }],
    },
  )
  assert.equal(
    readScreenSpec('export default function Fixture() {}'),
    undefined,
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

test('requires seed auth for an anonymous scenario capture', () =>
  assert.throws(
    () =>
      validateLedger([
        ledgerScreen([
          {
            id: 'seeded',
            setup: { scenario: 'recent/content-rich' },
          },
        ]),
      ]),
    /anonymous scenario requires seed auth: fixture\/seeded/,
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

  // scenario シードは devShareableId でハッシュした id で保存されるため、
  // capture の URL も同じ変換後の id を指す。
  assert.equal(path, `/a/${devShareableId('workspace-viewer-file-21')}`)
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
    locator: () => ({
      waitFor: () => Promise.reject(new Error('Timeout 30000ms exceeded.')),
      count: () => Promise.resolve(0),
    }),
  }

  await assert.rejects(
    waitForInteractionTarget(page, {
      action: 'hover',
      selector: '[data-help]',
    }),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'interaction_precondition' &&
      error.message === 'interaction target was not found: [data-help]' &&
      error.details.action === 'hover' &&
      error.details.selector === '[data-help]' &&
      error.details.matches === 0 &&
      error.details.cause === 'Timeout 30000ms exceeded.',
  )
})

test('says a single target never became visible instead of calling it missing', async () => {
  const page = {
    locator: () => ({
      waitFor: () => Promise.reject(new Error('Timeout 30000ms exceeded.')),
      count: () => Promise.resolve(1),
    }),
  }

  await assert.rejects(
    waitForInteractionTarget(page, {
      action: 'click',
      selector: '[data-hidden-menu]',
    }),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'interaction_precondition' &&
      error.message ===
        'interaction target was found but did not become visible: [data-hidden-menu]' &&
      error.details.matches === 1,
  )
})

test('names a selector that matches several targets instead of calling it missing', async () => {
  const page = {
    locator: () => ({
      waitFor: () =>
        Promise.reject(
          new Error(
            'strict mode violation: locator(\'tbody button:has-text("Stop")\') resolved to 2 elements:\n    1) <button>Stop</button>',
          ),
        ),
      count: () => Promise.resolve(2),
    }),
  }

  await assert.rejects(
    waitForInteractionTarget(page, {
      action: 'click',
      selector: 'tbody button:has-text("Stop")',
    }),
    (error) =>
      error instanceof CaptureFailure &&
      error.kind === 'interaction_precondition' &&
      error.message ===
        'interaction target matched 2 elements; narrow the selector to one: tbody button:has-text("Stop")' &&
      error.details.matches === 2 &&
      error.details.cause.startsWith('strict mode violation') &&
      !error.details.cause.includes('\n'),
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

test('maps local viewer and sandbox hostnames for both browser modes', () => {
  assert.deepEqual(browserLaunchOptions(undefined), {
    args: ['--host-resolver-rules=MAP *.localhost [::1]'],
  })
  assert.deepEqual(browserLaunchOptions('chrome'), {
    channel: 'chrome',
    args: ['--host-resolver-rules=MAP *.localhost [::1]'],
  })
})

test('requires the local sandbox only for local captures that render it', () => {
  const sandboxScreen = {
    ready: { selector: '[data-sandbox-state="ready"]' },
  }
  assert.equal(
    needsLocalSandbox('https://localhost:5173', [sandboxScreen]),
    true,
  )
  assert.equal(needsLocalSandbox('https://localhost:5173', screens), false)
  assert.equal(
    needsLocalSandbox('https://preview.example.com', [sandboxScreen]),
    false,
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
    {
      scenario: 'project-detail/with-files',
    },
  )
})

test('static optional sections validate and propagate checker errors', () => {
  for (const sections of [
    undefined,
    [],
    [{ id: 'introduction', selector: '#introduction' }],
    ['a', '0', `a${'b-0'.repeat(21)}`].map((id) => ({
      id,
      selector: '#introduction',
    })),
  ]) {
    const source = typedScreenSource.replace(
      "id: 'profile',",
      `id: 'profile', ${sections === undefined ? '' : `sections: ${JSON.stringify(sections)},`}`,
    )
    const screen = readScreenSpec(source)
    assert.deepEqual(screen.sections, sections)
    assert.equal(validateLedger([screen]), true)
    if (sections?.length)
      assert.equal(validateLedger([screen, { ...screen, id: 'other' }]), true)
  }
  const invalid = [
    null,
    {},
    'sections',
    1,
    [null],
    [[]],
    ['entry'],
    [{}],
    ...[
      undefined,
      '',
      'Upper',
      'has space',
      '../escape',
      'a/b',
      42,
      '-',
      '-introduction',
      'a'.repeat(65),
      'a'.repeat(200_000),
    ].map((id) => [{ id, selector: '#ok' }]),
    ...[undefined, null, 42, '', ' \n\t'].map((selector) => [
      { id: 'introduction', selector },
    ]),
    [
      { id: 'intro', selector: '#one' },
      { id: 'intro', selector: '#two' },
    ],
  ]
  for (const sections of invalid) {
    const source = typedScreenSource.replace(
      "id: 'profile',",
      `id: 'profile', sections: ${JSON.stringify(sections)},`,
    )
    assert.throws(
      () => validateLedger([readScreenSpec(source)]),
      /section.*profile/,
    )
    const errors = checkScreenLedger({
      excludedRoutes: [],
      loadRouteTree: () => routeTree,
      readRouteSource: () => source,
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /section.*profile/)
  }
})

test('CLI guide declares five ordered sections for both locale routes', () => {
  const screen = ledgerScreens.find(
    (candidate) => candidate.id === 'guides-cli',
  )
  assert.deepEqual(screen.route, { en: '/guides/cli', ja: '/ja/guides/cli' })
  assert.deepEqual(
    screen.sections,
    ['introduction', 'basics', 'destinations', 'commands', 'recovery'].map(
      (id) => ({
        id,
        selector: `#${id}`,
      }),
    ),
  )
})

test('section declarations reject IDs that critique cannot label', async (t) => {
  for (const id of [
    '-',
    '-introduction',
    'a'.repeat(65),
    'a'.repeat(200_000),
  ]) {
    await t.test(
      `rejects ${id.length > 64 ? `${id.length} characters` : id}`,
      () => {
        const source = typedScreenSource.replace(
          "id: 'profile',",
          `id: 'profile', sections: ${JSON.stringify([{ id, selector: '#introduction' }])},`,
        )
        assert.throws(
          () => validateLedger([readScreenSpec(source)]),
          /invalid section id for profile\/section 1/,
        )
        assert.deepEqual(
          checkScreenLedger({
            excludedRoutes: [],
            loadRouteTree: () => routeTree,
            readRouteSource: () => source,
          }),
          ['invalid section id for profile/section 1'],
        )
      },
    )
  }
})

test('retention capture query uses the same artifact-scoped removed ID as its seed', () => {
  const viewer = ledgerScreens.find((screen) => screen.id === 'viewer')
  const state = viewer.states.find(
    (candidate) => candidate.id === 'retention-removed',
  )
  const seeds = {
    scenarioCookies: {
      'team-owner:viewer/retention-removed': {
        workspaceId: 'ws1',
        userId: 'u1',
      },
    },
  }
  const artifactId = devShareableId('ws1-u1-file-1')
  assert.equal(
    pathFor(viewer, 'en', seeds, state),
    `/a/${artifactId}?version=${artifactId}-removed-v1`,
  )
})

test('owner retention captures include the unchanged editor and a completed zero-removal save', () => {
  const viewer = ledgerScreens.find((screen) => screen.id === 'viewer')
  for (const id of ['retention-expanded', 'retention-saved']) {
    const state = viewer.states.find((candidate) => candidate.id === id)
    assert.ok(state)
    assert.equal(state.setup.scenario, `viewer/${id}`)
    assert.ok(screenScenarioAllowlist.has(state.setup.scenario))
    assert.equal(state.setup.scenarioArtifactIndex, 1)
    const selectors = state.setup.interactions.map(
      (interaction) => interaction.selector,
    )
    assert.deepEqual(selectors.slice(0, 3), [
      '[data-viewer-more-menu-trigger]',
      '[data-viewer-history-menu-item]',
      '[data-retention-change]',
    ])
    assert.deepEqual(
      selectors.slice(3),
      id === 'retention-saved'
        ? [
            '[data-retention-all]',
            '[data-retention-save]',
            '[data-retention-saved]',
          ]
        : [],
    )
  }
})

test('each Saved capture in the full matrix starts with fresh retention after ordinary jobs finish', async () => {
  const viewer = ledgerScreens.find((screen) => screen.id === 'viewer')
  const state = viewer.states.find(
    (candidate) => candidate.id === 'retention-saved',
  )
  const jobs = []
  for (const locale of ['en', 'ja'])
    for (const viewport of ['desktop', 'mobile'])
      for (const theme of ['light', 'dark'])
        jobs.push({ screen: viewer, state, locale, viewport, theme })
  const ordinaryJobs = [
    { screen: viewer, state: { setup: {} } },
    { screen: viewer, state: { setup: { scenario: state.setup.scenario } } },
  ]
  let retention = 1
  let active = 0
  let ordinaryDone = 0
  const saved = []
  const resets = []
  await runCaptureJobs({
    // Interleave to ensure execution order, rather than input ordering, protects shared data.
    jobs: [jobs[0], ordinaryJobs[0], ...jobs.slice(1), ordinaryJobs[1]],
    concurrency: 6,
    reseed: async (job) => {
      assert.equal(active, 0, 'a reset must not overlap a capture')
      assert.equal(ordinaryDone, ordinaryJobs.length)
      retention = 1
      resets.push(job)
      await new Promise((resolve) => setImmediate(resolve))
    },
    captureJob: async (job) => {
      active++
      if (ordinaryJobs.includes(job)) {
        assert.equal(
          retention,
          1,
          'ordinary captures must see the original seed',
        )
        await new Promise((resolve) => setImmediate(resolve))
        ordinaryDone++
      } else {
        assert.equal(active, 1, 'mutating captures must be serial')
        assert.equal(
          retention,
          1,
          'Keep all must change the stored setting so Save is enabled',
        )
        retention = null
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(
          retention,
          null,
          'another reset must not race the saved capture',
        )
        saved.push(job)
      }
      active--
    },
  })
  assert.equal(saved.length, 8)
  assert.deepEqual(saved, jobs)
  assert.deepEqual(resets, jobs)
})

test('capture reseeding requires an explicit scenario and a boolean', () => {
  for (const setup of [
    { reseedBeforeCapture: true },
    { scenario: 'viewer/retention-saved', reseedBeforeCapture: 'true' },
  ]) {
    assert.throws(
      () =>
        validateLedger([
          { ...ledgerScreen([{ id: 'saved', setup }]), auth: 'team-owner' },
        ]),
      /reseedBeforeCapture requires a scenario and a boolean/,
    )
  }
  assert.equal(
    validateLedger([
      {
        ...ledgerScreen([
          {
            id: 'saved',
            setup: {
              scenario: 'viewer/retention-saved',
              reseedBeforeCapture: true,
            },
          },
        ]),
        auth: 'team-owner',
      },
    ]),
    true,
  )
})

test('validates typed fill values and same-route action fixtures', () => {
  const base = {
    screens: [
      {
        id: 'profile',
        route: { en: '/settings/profile' },
        states: [
          {
            id: 'error',
            setup: {
              interactions: [
                { action: 'fill', selector: 'input', value: '30' },
              ],
              actionResponse: {
                route: '/settings/profile',
                method: 'POST',
                intent: 'save',
                data: { kind: 'forbidden' },
              },
            },
          },
        ],
      },
    ],
    excludedRoutes: [],
    loadRouteTree: () => routeTree,
    readRouteSource: () => 'export default function Profile() {}',
  }
  assert.deepEqual(checkScreenLedger(base), [])
  const missingReady = structuredClone(base.screens[0])
  missingReady.id = 'settings-general'
  missingReady.states[0].id = 'result-error'
  assert.match(
    checkScreenLedger({ ...base, screens: [missingReady] }).join(' '),
    /missing post-interaction readiness/,
  )
  base.screens[0].states[0].setup.interactions[0].value = 30
  assert.match(checkScreenLedger(base).join(' '), /fill requires a string/)
  base.screens[0].states[0].setup.actionResponse.route = '/settings/other'
  assert.match(
    checkScreenLedger(base).join(' '),
    /invalid action response fixture/,
  )
})

test('Settings capture URLs must stay on their owning route and use a registered first status', () => {
  const check = (query) =>
    checkScreenLedger({
      screens: [
        {
          id: 'billing',
          route: { en: '/settings/billing' },
          states: [{ id: 'ordinary', setup: { query } }],
        },
      ],
      excludedRoutes: [],
      loadRouteTree: () => [
        { path: 'settings/billing', file: 'routes/billing.tsx' },
      ],
      readRouteSource: () => 'export default function Billing() {}',
    })
  for (const query of [
    '?status=checkout-success&status=unknown',
    '?status=checkout-cancelled&extra=1',
    '#details',
  ])
    assert.deepEqual(check(query), [])
  for (const status of [
    'removed-transfer-failed',
    'unknown',
    'forbidden',
    '',
  ]) {
    assert.deepEqual(check('?status=' + status + '&status=invalid'), [
      'unregistered Settings status: billing/ordinary /settings/billing?status=' +
        status,
    ])
  }
  assert.deepEqual(check('/../tokens?status=invalid'), [
    'wrong Settings capture route: billing/ordinary /settings/tokens?status=invalid (owner /settings/billing)',
  ])
})

test('Settings captures select only the intended route results', () => {
  const expected = {
    settings: [],
    'settings-general': [],
    'settings-billing': ['checkout-success', 'checkout-cancelled'],
    'settings-integrations': ['slack-team-in-use'],
    'settings-external-access': [],
    'settings-tokens': [],
    'settings-analytics': [],
    'settings-activity': [],
    'settings-inventory-projects': [],
    'settings-inventory-artifacts': [],
  }
  for (const [id, statuses] of Object.entries(expected)) {
    const screen = ledgerScreens.find((candidate) => candidate.id === id)
    assert.deepEqual(
      screen.states.flatMap((state) =>
        new URLSearchParams(state.setup.query).getAll('status'),
      ),
      statuses,
    )
  }
})

test('expected boundary markers must be visible and unique', async () => {
  for (const [markers, visible, accepted] of [
    [['settings-error-boundary'], true, true],
    [['settings-error-boundary'], false, false],
    [[], true, false],
    [['route-error-boundary'], true, false],
    [['settings-error-boundary', 'route-error-boundary'], true, false],
  ]) {
    const check = assertNoRouteError(
      {
        locator: () => ({
          count: () => markers.length,
          first: () => ({
            getAttribute: () => markers[0],
            isVisible: () => visible,
          }),
        }),
      },
      'settings-error-boundary',
    )
    if (accepted) await check
    else await assert.rejects(check, /Expected one visible boundary/)
  }
})

test('capture ledger rejects an expected boundary without its exact HTTP status', () => {
  const state = {
    id: 'denied',
    expectedError: 'settings-error-boundary',
    setup: { ready: { selector: 'main a', description: 'Recovery link' } },
  }
  assert.throws(
    () => validateLedger([ledgerScreen([state])]),
    /expected error requires a marker, exact status and readiness/,
  )
  assert.equal(
    validateLedger([ledgerScreen([{ ...state, expectedStatus: 403 }])]),
    true,
  )
})

test('screens:capture refuses a run that only selects billing, before it touches the output', () => {
  const billing = ledgerScreens.filter(
    (screen) => screen.id === 'settings-billing',
  )
  assert.throws(
    () => planCaptureJobs(billing, { local: false }),
    /No capture jobs remain[^\n]*pnpm screens:capture:local/u,
  )
  assert.ok(planCaptureJobs(billing, { local: true }).jobs.length > 0)
})

const SETTINGS_ROUTES = fileURLToPath(
  new URL('../apps/web/app/routes/_protected/settings/', import.meta.url),
)

/**
 * Non-test source files under `dir` (relative paths) that mention
 * dev-screen-state or `isDevScreenStateRequest`.
 */
function settingsCaptureStateMentions(dir) {
  // JavaScript and TypeScript sources, including `.mts`/`.cts`; test files
  // carry `.test.` or `.spec.` before the extension.
  return readdirSync(dir, { recursive: true })
    .filter(
      (file) =>
        /\.[cm]?[jt]sx?$/.test(file) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
    )
    .filter((file) =>
      /dev-screen-state|isDevScreenStateRequest/.test(
        readFileSync(join(dir, file), 'utf8'),
      ),
    )
    .sort()
}

test('Settings routes and components do not mention dev-screen-state', () => {
  assert.ok(existsSync(join(SETTINGS_ROUTES, '_content/index.tsx')))
  assert.deepEqual(settingsCaptureStateMentions(SETTINGS_ROUTES), [])
  // Declaring a capture scenario in screen metadata is not a capture check.
  assert.ok(
    readFileSync(join(SETTINGS_ROUTES, '_content/tokens.tsx'), 'utf8').includes(
      "scenario: 'settings-tokens/created-secret'",
    ),
  )

  const fixture = mkdtempSync(join(tmpdir(), 'settings-guard-'))
  try {
    mkdirSync(join(fixture, '_content'))
    writeFileSync(
      join(fixture, '_content/tokens.tsx'),
      "export const loader = ({ request }) => isDevScreenStateRequest(request, 'settings-tokens/created-secret')",
    )
    writeFileSync(
      join(fixture, '_content/legacy-helper.cjs'),
      "module.exports = require('~/services/dev-screen-state.server')",
    )
    writeFileSync(
      join(fixture, '_content/tokens.test.tsx'),
      "import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'",
    )
    writeFileSync(
      join(fixture, '_content/capture.test.mjs'),
      "import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'",
    )
    writeFileSync(
      join(fixture, '_content/capture-helper.mts'),
      "export { isDevScreenStateRequest } from '~/services/dev-screen-state.server'",
    )
    writeFileSync(
      join(fixture, '_content/tokens.spec.tsx'),
      "import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'",
    )
    assert.deepEqual(settingsCaptureStateMentions(fixture), [
      join('_content', 'capture-helper.mts'),
      join('_content', 'legacy-helper.cjs'),
      join('_content', 'tokens.tsx'),
    ])
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('the created-secret capture submits the real token form and waits for its result', () => {
  const tokens = ledgerScreens.find((screen) => screen.id === 'settings-tokens')
  const state = tokens.states.find(({ id }) => id === 'created-secret')
  assert.equal(state.setup.scenario, 'settings-tokens/created-secret')
  assert.equal(state.setup.reseedBeforeCapture, true)
  assert.equal(state.setup.actionResponse, undefined)
  const [fill, submit, ...rest] = state.setup.interactions ?? []
  assert.deepEqual(rest, [])
  assert.equal(fill?.action, 'fill')
  assert.equal(fill.selector, '#token-name')
  assert.notEqual(fill.value.trim(), '')
  assert.notEqual(fill.value, 'CLI deploy')
  assert.equal(submit?.action, 'click')
  assert.match(submit.selector, /^form:has\(#token-name\) /)
  // The created-token panel renders only from the action's response.
  assert.match(
    state.setup.postInteractionReady.selector,
    /\[role="status"\] code/,
  )
})

test('the Members screen has no committed-removal warning capture', () => {
  // Production reaches that warning only when the recipient becomes
  // ineligible mid-submission, so no capture fakes the removal response.
  const members = ledgerScreens.find((screen) => screen.id === 'settings')
  const ids = members.states.map(({ id }) => id)
  for (const retired of ['result-warning', 'result-warning-transfer'])
    assert.ok(!ids.includes(retired), retired)
  for (const { setup } of members.states)
    assert.notEqual(setup.actionResponse?.intent, 'remove-member')
})

test('the Settings 403 capture is a Team member opening the admin-only Bots page', () => {
  const bots = ledgerScreens.find((screen) => screen.id === 'settings-bots')
  const state = bots.states.find(({ id }) => id === 'forbidden')
  assert.equal(state.expectedStatus, 403)
  assert.equal(state.expectedError, 'settings-error-boundary')
  assert.equal(state.setup.auth, 'team-member')
  assert.equal(state.setup.scenario, undefined)
  assert.equal(state.setup.actionResponse, undefined)
  assert.equal(state.setup.interactions, undefined)
  assert.match(state.setup.ready.selector, /a\[href="\/settings"\]/)
})

test('the synthetic General content errors are retired and the root error remains', () => {
  const general = ledgerScreens.find(
    (screen) => screen.id === 'settings-general',
  )
  const ids = general.states.map((state) => state.id)
  for (const retired of ['forbidden', 'not-found', 'unexpected-error']) {
    assert.ok(!ids.includes(retired), retired)
    assert.ok(!screenScenarioAllowlist.has(`settings-general/${retired}`))
  }
  const root = general.states.find((state) => state.id === 'root-error')
  assert.equal(root.setup.scenario, 'settings-general/root-error')
  assert.equal(root.expectedError, 'route-error-boundary')
  assert.equal(root.expectedStatus, 500)
})
