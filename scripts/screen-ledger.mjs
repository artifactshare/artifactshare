import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import screenScenarioIds from './screen-scenarios.json' with { type: 'json' }

export const screenScenarioAllowlist = new Set(screenScenarioIds)

const ROUTES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/web/app/routes',
)

// These are the route modules that own the 41 visual screen specifications.
// Locale aliases and data-only route modules intentionally stay unregistered.
export const screenRouteModules = [
  'ja.tsx',
  'about.tsx',
  'connect.tsx',
  'pricing.tsx',
  'privacy.tsx',
  'terms.tsx',
  'tokushoho.tsx',
  'share-with-ai.tsx',
  'start.tsx',
  'updates.tsx',
  'updates.$slug.tsx',
  'guides.cli.tsx',
  'guides.link-sharing.tsx',
  'guides.private-mobile-design-handoff.tsx',
  'guides.workspace-admin.tsx',
  'guides.workspace-owner.tsx',
  'sign-in.tsx',
  'consent.tsx',
  'device.tsx',
  'a.$id/index.tsx',
  '_protected/access-requests.tsx',
  '_home/index.tsx',
  '_home/_protected/recent.tsx',
  '_home/_protected/files.tsx',
  '_home/_protected/projects.tsx',
  '_protected/projects.$id.tsx',
  '_protected/projects.$id.files.tsx',
  '_protected/projects.$id.activity.tsx',
  '_protected/projects.archived.tsx',
  '_protected/settings/index.tsx',
  '_protected/settings/bots.tsx',
  '_protected/settings/general.tsx',
  '_protected/settings/activity.tsx',
  '_protected/settings/billing.tsx',
  '_protected/settings/external-access.tsx',
  '_protected/settings/integrations.tsx',
  '_protected/settings/inventory/projects.tsx',
  '_protected/settings/inventory/artifacts.tsx',
  '_protected/settings/tokens.tsx',
  '_protected/settings/cli-sessions.tsx',
  '_protected/settings/usage.tsx',
]

function expressionKey(node, file) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
  throw new Error(
    'screen export in ' + file + ' must use static property names',
  )
}

function evaluateScreenExpression(node, file) {
  switch (node.type) {
    case 'TSSatisfiesExpression':
    case 'TSAsExpression':
    case 'TypeCastExpression':
    case 'ParenthesizedExpression':
      return evaluateScreenExpression(node.expression, file)
    case 'Literal':
      return node.value
    case 'TemplateLiteral':
      if (node.expressions.length)
        throw new Error('screen export in ' + file + ' must be static')
      return node.quasis
        .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
        .join('')
    case 'UnaryExpression': {
      if (node.operator !== '-' && node.operator !== '+')
        throw new Error('screen export in ' + file + ' must be static')
      const value = evaluateScreenExpression(node.argument, file)
      if (typeof value !== 'number')
        throw new Error('screen export in ' + file + ' must be static')
      return node.operator === '-' ? -value : value
    }
    case 'ObjectExpression': {
      const value = {}
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          Object.assign(
            value,
            evaluateScreenExpression(property.argument, file),
          )
          continue
        }
        if (property.type !== 'Property' || property.kind !== 'init')
          throw new Error(
            'screen export in ' + file + ' must be a static object',
          )
        value[expressionKey(property.key, file)] = evaluateScreenExpression(
          property.value,
          file,
        )
      }
      return value
    }
    case 'ArrayExpression':
      return node.elements.map((element) => {
        if (!element)
          throw new Error(
            'screen export in ' + file + ' must be a static array',
          )
        return evaluateScreenExpression(element, file)
      })
    default:
      throw new Error('screen export in ' + file + ' must be static')
  }
}

/** Read the statically declared screen export from a route module. */
export function readScreenSpec(source, file = 'route.tsx') {
  const { program } = parseSync(file, source)
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (declaration?.type !== 'VariableDeclaration') continue
    const screenDeclaration = declaration.declarations.find(
      (item) => item.id.type === 'Identifier' && item.id.name === 'screen',
    )
    if (screenDeclaration) {
      if (!screenDeclaration.init)
        throw new Error('screen export in ' + file + ' must be initialized')
      return evaluateScreenExpression(screenDeclaration.init, file)
    }
  }
  return undefined
}

export function loadScreenSpecModules({
  files = screenRouteModules,
  readRouteSource = (file) => readFileSync(join(ROUTES_DIR, file), 'utf8'),
} = {}) {
  return files.flatMap((file) => {
    const screen = readScreenSpec(readRouteSource(file), file)
    return screen === undefined ? [] : [{ file, screen }]
  })
}

// Keep the historical screen order so capture manifests and duplicate route
// labels remain stable while their metadata now lives beside each route.
export const screenSpecModules = loadScreenSpecModules()
export const screens = screenSpecModules.map(({ screen }) => screen)

export const authPersonas = new Set([
  'anonymous',
  'free-owner',
  'plus-owner',
  'team-owner',
  'team-member',
])

const values = {
  auth: authPersonas,
  loop: new Set([
    'create',
    'post',
    'share',
    'view',
    'react',
    'repost',
    'support',
  ]),
}

// UI leaf route ではない、または dev persona から到達できない route の明示除外。
// 機械的な除外 (api./dev./og-image 等) は scripts/check-screen-ledger.mjs が持つ。
export const excludedRoutes = [
  {
    file: '_home/_protected/activity.tsx',
    reason: '廃止したグローバル activity URL からホームへの無条件 redirect',
  },
  {
    file: '_protected/connect.slack.tsx',
    reason: 'loader が常に text Response を返すデータ専用 route',
  },
  {
    file: '_protected/projects.$id.slack.tsx',
    reason: 'Slack 通知ダイアログが利用する loader/action 専用 route',
  },
  {
    file: '_protected/integrations.slack.install.tsx',
    reason: 'Slack OAuth への無条件 redirect',
  },
  {
    file: '_protected/projects.$id.slack.install.tsx',
    reason: 'プロジェクトの Slack 通知認可への無条件 redirect',
  },
  {
    file: '_protected/settings/billing-preview.tsx',
    reason: 'data のみを返す loader で UI を描画しない',
  },
  {
    file: '_protected/settings/recipients.tsx',
    reason: 'RecipientPicker が利用する JSON 専用 route で UI を描画しない',
  },
  {
    file: '_protected/settings/inventory/index.tsx',
    reason: 'inventory/projects への無条件 redirect',
  },
  {
    file: 'notice-updates.tsx',
    reason: '更新通知を既読化する POST data route で UI を描画しない',
  },
]

export function validateLedger(
  ledgerScreens = screens,
  scenarioAllowlist = screenScenarioAllowlist,
) {
  const ids = new Set()
  for (const screen of ledgerScreens) {
    if (ids.has(screen.id)) throw new Error(`duplicate screen id: ${screen.id}`)
    ids.add(screen.id)
    if (!values.auth.has(screen.auth))
      throw new Error(`invalid auth for ${screen.id}`)
    if (!values.loop.has(screen.loop))
      throw new Error(`invalid loop for ${screen.id}`)
    if (!Array.isArray(screen.states) || screen.states.length === 0)
      throw new Error(`states required for ${screen.id}`)
    if (
      screen.captureConcurrency !== undefined &&
      (!Number.isInteger(screen.captureConcurrency) ||
        screen.captureConcurrency < 1)
    )
      throw new Error(`capture concurrency must be positive for ${screen.id}`)
    if (screen.ready) {
      if (!screen.ready.selector?.trim())
        throw new Error(`ready selector required for ${screen.id}`)
      if (!screen.ready.description?.trim())
        throw new Error(`ready description required for ${screen.id}`)
      if (
        screen.ready.timeoutMs !== undefined &&
        (!Number.isInteger(screen.ready.timeoutMs) ||
          screen.ready.timeoutMs < 1)
      )
        throw new Error(`ready timeout must be positive for ${screen.id}`)
    }
    const stateIds = new Set()
    for (const state of screen.states) {
      if (stateIds.has(state.id))
        throw new Error(`duplicate state id: ${screen.id}/${state.id}`)
      stateIds.add(state.id)
      if (state.setup?.auth !== undefined && !values.auth.has(state.setup.auth))
        throw new Error(`invalid state auth for ${screen.id}/${state.id}`)
      if (
        state.setup?.seedAuth !== undefined &&
        !values.auth.has(state.setup.seedAuth)
      )
        throw new Error(`invalid seed auth for ${screen.id}/${state.id}`)
      if (state.setup?.seedAuth && !state.setup?.scenario)
        throw new Error(
          `seed auth requires a scenario: ${screen.id}/${state.id}`,
        )
      if (state.setup?.scenario && !scenarioAllowlist.has(state.setup.scenario))
        throw new Error(`unknown scenario: ${state.setup.scenario}`)
      if (
        state.setup?.ready &&
        (!state.setup.ready.selector?.trim() ||
          !state.setup.ready.description?.trim())
      )
        throw new Error(
          `state ready override needs a selector and a description: ${screen.id}/${state.id}`,
        )
      if (
        state.setup?.scenarioArtifactIndex !== undefined &&
        (!state.setup.scenario ||
          !Number.isInteger(state.setup.scenarioArtifactIndex) ||
          state.setup.scenarioArtifactIndex < 1)
      )
        throw new Error(
          `scenario artifact index requires a scenario and a positive integer: ${screen.id}/${state.id}`,
        )
      if (
        state.setup?.scenario &&
        !state.setup.seedAuth &&
        (state.setup.auth ?? screen.auth) === 'anonymous'
      )
        throw new Error(
          `anonymous scenario requires seed auth: ${screen.id}/${state.id}`,
        )
    }
  }
  return true
}
