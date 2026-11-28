// The oxlint plugin tests build their fixtures inside the app tree, so the
// repository's own lint configuration applies to them. This module is the one
// place that spells those paths: the plugin tests create directories under
// these prefixes, and check-d1-compatibility skips the same directories when
// it walks production sources.

const LINT_FIXTURE_PARENT = 'apps/web/app'
const MODULES_PARENT = `${LINT_FIXTURE_PARENT}/modules`
const PLUGINS = [
  'analytics',
  'module-boundary',
  'plan-tier',
  'file-url-path',
  'access',
]

function assertPlugin(plugin) {
  if (!PLUGINS.includes(plugin))
    throw new Error(`Unknown lint plugin fixture: ${plugin}`)
  return plugin
}

// mkdtemp appends random characters, so each prefix names a family, not a path.
export function lintFixturePrefix(plugin) {
  return `${LINT_FIXTURE_PARENT}/${assertPlugin(plugin)}-lint-fixture-`
}

// The module-boundary fixture mirrors its directory name under modules/ to get
// a module with a public entry and an internal file.
export function lintFixtureModulePrefix(plugin) {
  return `${MODULES_PARENT}/${assertPlugin(plugin)}-lint-fixture-`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PREFIXES = [
  ...PLUGINS.map(lintFixturePrefix),
  lintFixtureModulePrefix('module-boundary'),
]

export const LINT_FIXTURE_DIRECTORY = new RegExp(
  `^(?:${PREFIXES.map(escapeRegExp).join('|')})[^/]+$`,
)
