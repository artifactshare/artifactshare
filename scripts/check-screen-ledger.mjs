import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { excludedRoutes, screens } from './screen-ledger.mjs'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../apps/web')
const ROUTES_DIR = join(WEB_DIR, 'app/routes')
const MECHANICAL_EXCLUDES = [
  /^api\./,
  /^dev\./,
  /^\[\.\]well-known\./,
  /^poc\./,
  /(^|\.)og-image\.tsx$/,
  /^(sitemap|robots|llms|openapi|pricing|capabilities)\[\.\]/,
  /^mcp\.ts$/,
  /^(set-locale|set-theme|set-analytics-consent|set-analytics-tracked)\.tsx$/,
]

export function loadRouteTree() {
  const stdout = execSync('pnpm exec react-router routes --json', {
    cwd: WEB_DIR,
    encoding: 'utf8',
  })
  return JSON.parse(stdout.slice(stdout.indexOf('[')))
}

export function collectLeaves(nodes, prefix = '') {
  const leaves = []
  for (const node of nodes) {
    const path = [prefix, node.path ?? ''].filter(Boolean).join('/')
    if (node.children?.length) {
      leaves.push(...collectLeaves(node.children, path))
      continue
    }
    if (node.file?.startsWith('routes/'))
      leaves.push({
        file: node.file.slice('routes/'.length),
        path: `/${path}`.replace(/\/+$/, '') || '/',
      })
  }
  return leaves
}

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
  screens: ledgerScreens,
  excludedRoutes: ledgerExclusions,
  loadRouteTree: loadTree = loadRouteTree,
  readRouteSource = (file) => readFileSync(join(ROUTES_DIR, file), 'utf8'),
}) {
  const ledgerPaths = new Map()
  for (const screen of ledgerScreens)
    for (const [locale, path] of Object.entries(screen.route))
      ledgerPaths.set(normalizePath(path), `${screen.id} (${locale})`)
  const excluded = new Map(
    ledgerExclusions.map(({ file, reason }) => [file, reason]),
  )
  const leaves = collectLeaves(loadTree())
  const failures = []
  const seenFiles = new Set()
  const leafPaths = new Set(leaves.map((leaf) => normalizePath(leaf.path)))
  for (const leaf of leaves) {
    const base = leaf.file.split('/').pop()
    if (MECHANICAL_EXCLUDES.some((re) => re.test(base) || re.test(leaf.file)))
      continue
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
    if (excluded.has(leaf.file)) {
      seenFiles.add(leaf.file)
      continue
    }
    failures.push(
      `uncovered route: ${leaf.file} (path ${leaf.path}) — add it to screens or excludedRoutes in scripts/screen-ledger.mjs`,
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
    screens,
    excludedRoutes,
    loadRouteTree: () => routeTree,
  })
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(
    `screen-ledger check ok: ${screens.length} screens, ${excludedRoutes.length} explicit exclusions, ${collectLeaves(routeTree).length} routes`,
  )
}
