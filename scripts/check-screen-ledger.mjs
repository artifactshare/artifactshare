import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import {
  collectLeaves,
  loadRouteTree,
  loadScreenSpecModules,
  validateLedger,
} from './screen-ledger.mjs'

export { collectLeaves, loadRouteTree } from './screen-ledger.mjs'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../apps/web')
const ROUTES_DIR = join(WEB_DIR, 'app/routes')
const MECHANICAL_EXCLUDES = [
  /^api\./,
  /^dev\./,
  // Operator page reached only through a signed link in a Slack alert.
  /^ops\./,
  /^\[\.\]well-known\./,
  /^poc\./,
  /(^|\.)og-image\.tsx$/,
  /^(sitemap|robots|llms|openapi|pricing|capabilities)\[\.\]/,
  /^mcp\.ts$/,
  /^(set-locale|set-theme|set-analytics-consent|set-analytics-tracked)\.tsx$/,
]

// UI leaf route ではない、または dev persona から到達できない route の明示除外。
// 機械的な除外 (api./dev./og-image 等) はこの checker が持つ。
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

function normalizePath(path) {
  return (
    path
      .replace(/\{seed:[^}]+\}/g, ':param')
      .replace(/:[A-Za-z0-9_]+/g, ':param')
      .replace(/\/+$/, '') || '/'
  )
}

export function hasDefaultExport(source) {
  const { program } = parseSync('route.tsx', source)
  return program.body.some((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') return true
    if (statement.type !== 'ExportNamedDeclaration') return false
    return statement.specifiers.some(
      (specifier) =>
        specifier.type === 'ExportSpecifier' &&
        ((specifier.exported.type === 'Identifier' &&
          specifier.exported.name === 'default') ||
          (specifier.exported.type === 'Literal' &&
            specifier.exported.value === 'default')),
    )
  })
}

export function checkScreenLedger({
  screens: suppliedScreens,
  excludedRoutes: ledgerExclusions = excludedRoutes,
  loadRouteTree: loadTree = loadRouteTree,
  readRouteSource = (file) => readFileSync(join(ROUTES_DIR, file), 'utf8'),
  screenModules: suppliedScreenModules,
}) {
  const routeTree = loadTree()
  const leaves = collectLeaves(routeTree)
  const screenModules =
    suppliedScreenModules ??
    (suppliedScreens === undefined
      ? loadScreenSpecModules({
          routeTree,
          readRouteSource,
        })
      : undefined)
  const ledgerScreens =
    suppliedScreens ?? screenModules?.map(({ screen }) => screen) ?? []
  const ledgerPaths = new Map()
  for (const screen of ledgerScreens)
    for (const [locale, path] of Object.entries(screen.route))
      ledgerPaths.set(normalizePath(path), `${screen.id} (${locale})`)
  const excluded = new Map(
    ledgerExclusions.map(({ file, reason }) => [file, reason]),
  )
  const failures = []
  if (screenModules) {
    try {
      validateLedger(ledgerScreens)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  const seenFiles = new Set()
  const leafPaths = new Set(leaves.map((leaf) => normalizePath(leaf.path)))
  const screenModulesByFile = new Map(
    screenModules?.map((module) => [module.file, module]) ?? [],
  )
  for (const leaf of leaves) {
    const base = leaf.file.split('/').pop()
    if (MECHANICAL_EXCLUDES.some((re) => re.test(base) || re.test(leaf.file)))
      continue
    // Locale wrappers share the specification owned by their canonical sibling.
    const localeSibling = leaf.file.startsWith('ja.')
      ? screenModulesByFile.get(leaf.file.slice('ja.'.length))
      : undefined
    const screenModule =
      screenModulesByFile.get(leaf.file) ??
      (localeSibling?.screen.route.ja &&
      normalizePath(localeSibling.screen.route.ja) === normalizePath(leaf.path)
        ? localeSibling
        : undefined)
    if (screenModules && !screenModule && !excluded.has(leaf.file)) {
      failures.push(
        `route without screen export: ${leaf.file} — add an export const screen that satisfies ScreenSpec`,
      )
      continue
    }
    const ledgerLabel = ledgerPaths.get(normalizePath(leaf.path))
    if (ledgerLabel) {
      if (excluded.has(leaf.file)) {
        seenFiles.add(leaf.file)
        failures.push(
          `conflicting route classification: ${leaf.file} (path ${leaf.path}) is both ${ledgerLabel} and excluded`,
        )
      }
      if (!hasDefaultExport(readRouteSource(leaf.file)))
        failures.push(
          `route without default export: ${leaf.file} (path ${leaf.path}) — remove it from screens or add a default export`,
        )
      continue
    }
    if (screenModule) {
      failures.push(
        `uncovered route: ${leaf.file} (path ${leaf.path}) — add it to screens or excludedRoutes in scripts/check-screen-ledger.mjs`,
      )
      continue
    }
    if (excluded.has(leaf.file)) {
      seenFiles.add(leaf.file)
      continue
    }
    failures.push(
      `uncovered route: ${leaf.file} (path ${leaf.path}) — add it to screens or excludedRoutes in scripts/check-screen-ledger.mjs`,
    )
  }
  for (const [file] of excluded)
    if (!seenFiles.has(file))
      failures.push(
        `stale exclusion: ${file} no longer exists — remove it from excludedRoutes`,
      )
  for (const [path, label] of ledgerPaths)
    if (!leafPaths.has(path))
      failures.push(
        `dangling ledger entry: ${label} points at ${path} which has no route`,
      )
  return failures
}

if (import.meta.main) {
  const routeTree = loadRouteTree()
  const failures = checkScreenLedger({
    excludedRoutes,
    loadRouteTree: () => routeTree,
  })
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  const screens = loadScreenSpecModules({ routeTree })
  console.log(
    `screen-ledger check ok: ${screens.length} screens, ${excludedRoutes.length} explicit exclusions, ${collectLeaves(routeTree).length} routes`,
  )
}
