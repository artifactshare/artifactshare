import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
const webPackage = JSON.parse(
  fs.readFileSync(path.join(root, 'apps/web/package.json')),
)
function filesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'build', '.wrangler'].includes(entry.name))
      return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(file) : [file]
  })
}

const nodeTests = filesUnder(path.join(root, 'scripts'))
  .filter((file) => file.endsWith('.test.mjs'))
  .map((file) => path.relative(root, file))
for (const file of nodeTests)
  assert.match(
    rootPackage.scripts['test:scripts'],
    new RegExp(file.replaceAll('.', '\\.')),
  )

const webTests = filesUnder(path.join(root, 'apps/web'))
  .map((file) => path.relative(root, file))
  .filter((file) => /\.test\.(?:ts|tsx)$/.test(file))
assert.ok(webTests.length > 0, 'web test inventory must not be empty')
const publicTestSkips = webTests
  .filter((file) =>
    fs.readFileSync(path.join(root, file), 'utf8').includes('PUBLIC_TEST'),
  )
  .sort()
assert.deepEqual(publicTestSkips, [
  'apps/web/app/services/slack-notifications.server.test.ts',
])
assert.match(
  fs.readFileSync(path.join(root, publicTestSkips[0]), 'utf8'),
  /test\.skipIf\(globalThis\.process\.env\.PUBLIC_TEST === '1'\)/,
)
const internalVisualTests = webTests
  .filter(
    (file) => file.includes('.browser.test.') && !file.includes('.behavior.'),
  )
  .sort()
assert.deepEqual(internalVisualTests, [
  'apps/web/app/lib/gap-audit.browser.test.tsx',
  'apps/web/app/root.locale.browser.test.tsx',
  'apps/web/app/routes/dev.gallery/gallery.browser.test.tsx',
  'apps/web/app/routes/dev.scenarios.$scenario/scenarios.browser.test.tsx',
])
assert.ok(webPackage.scripts.test, 'web unit test command is required')
assert.match(webPackage.scripts.test, /(?:^|\s)PUBLIC_TEST=1(?:\s|$)/u)
assert.ok(
  webPackage.scripts['test:behavior-browser'],
  'web browser test command is required',
)
assert.ok(
  webPackage.scripts['test:visual-browser'],
  'web visual browser test command is required',
)
assert.match(webPackage.scripts.test, /pnpm test:visual-browser/u)
assert.ok(
  webPackage.scripts['integration:test:run'],
  'workerd integration test command is required',
)
assert.ok(rootPackage.scripts.test.includes('@artifactshare/cli'))

console.log(
  `public test audit: ${nodeTests.length} node tests, ${webTests.length} runnable web tests, ${internalVisualTests.length} public visual tests`,
)
