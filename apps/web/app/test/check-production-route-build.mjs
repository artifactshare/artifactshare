import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const BUILD_ROOT = path.resolve(import.meta.dirname, '../../build')
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.map'])
const FORBIDDEN_MARKERS = [
  'routes/api.poc.slack.events',
  'routes/dev.gallery',
  'routes/dev.scenarios.$scenario',
  'routes/dev.sign-in',
  'routes/poc.static-site',
  'Component gallery',
  'Product shell regression scenarios',
  'Slack chat.unfurl behavior PoC',
]

async function textFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) return textFiles(target)
      return entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))
        ? [target]
        : []
    }),
  )
  return files.flat()
}

const files = await textFiles(BUILD_ROOT)
assert(files.length > 0, `Production build is empty: ${BUILD_ROOT}`)
const artifacts = await Promise.all(
  files.map(async (file) => ({ file, contents: await readFile(file, 'utf8') })),
)

const violations = []
let foundProductionRoute = false
for (const { file, contents } of artifacts) {
  if (contents.includes('routes/about')) foundProductionRoute = true
  for (const marker of FORBIDDEN_MARKERS) {
    if (contents.includes(marker)) {
      violations.push(`${path.relative(BUILD_ROOT, file)}: ${marker}`)
    }
  }
}

assert(
  foundProductionRoute,
  'Production route manifest was not found in build output',
)
assert.equal(
  violations.length,
  0,
  `Development-only routes leaked into the production build:\n${violations.join('\n')}`,
)

console.log(
  `production route build: ${files.length} text artifacts checked; no development routes found`,
)
