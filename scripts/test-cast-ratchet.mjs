import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const literal = 'as unknown as'
export const builderFiles = [
  'cli-authority',
  'worker-env',
  'stripe',
  'parent-window',
  'data-transfer',
  'd1',
].map((name) => `apps/web/app/test/typed-fakes/${name}.ts`)
const excluded = new Set([
  'node_modules',
  'dist',
  'build',
  '.wrangler',
  '.git',
  '.cache',
  '.vite',
  '.react-router',
  'coverage',
  'test-results',
  'playwright-report',
])
export const baselinePath = 'config/test-cast-baseline.json'
const guidance = `Use the typed builders:
CliAuthority: cliAuthority — ${builderFiles[0]}
Cloudflare.Env: workerEnv — ${builderFiles[1]}
Stripe: stripeClient / stripeSubscription — ${builderFiles[2]}
ParentWindow: parentWindow — ${builderFiles[3]}
DataTransfer: dataTransfer — ${builderFiles[4]}
D1Database: d1Database — ${builderFiles[5]}
Deliberately invalid values stay local, documented and counted in their negative tests; do not replace them with valid builders or exempt them.
Record reductions with node scripts/test-cast-ratchet.mjs --update-baseline (refuses per-file growth).`

function filesUnder(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      if (excluded.has(entry.name)) return []
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) return filesUnder(root, file)
      return entry.isFile() ? [file] : []
    },
  )
}

export function inventory(root) {
  const counts = {}
  const locations = {}
  for (const file of ['apps', 'packages']
    .flatMap((dir) => filesUnder(root, dir))
    .sort()) {
    if (
      !/\.test\.(?:tsx?|mjs)$/.test(file) &&
      !file.startsWith('apps/web/app/test/')
    )
      continue
    const source = readFileSync(join(root, file), 'utf8')
    const matches = [...source.matchAll(/as unknown as/g)]
    if (!matches.length) continue
    counts[file] = matches.length
    locations[file] = matches.map((match) => {
      const prefix = source.slice(0, match.index)
      const line = prefix.split('\n').length
      const column = match.index - prefix.lastIndexOf('\n')
      return `${file}:${line}:${column}: ${source.split('\n')[line - 1].trim()}`
    })
  }
  return { counts, locations }
}

export function assertionErrors(source, file) {
  const parsed = parseSync(file, source)
  const errors = parsed.errors.map(
    (error) => `${file}:1: parse error: ${error.message}`,
  )
  function visit(node) {
    if (!node || typeof node !== 'object') return
    const isConst =
      node.type === 'TSAsExpression' &&
      node.typeAnnotation?.type === 'TSTypeReference' &&
      node.typeAnnotation.typeName?.name === 'const'
    if (
      (node.type === 'TSAsExpression' && !isConst) ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'TSNonNullExpression'
    ) {
      const line = source.slice(0, node.start).split('\n').length
      errors.push(`${file}:${line}: forbidden ${node.type} in typed builder`)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parsed.program)
  return errors
}

export function analyzeTree(root, baseline) {
  const { counts, locations } = inventory(root)
  const errors = []
  for (const [file, count] of Object.entries(counts)) {
    const ceiling = baseline[file] ?? 0
    if (count > ceiling)
      errors.push(
        `${file}: ${count} occurrences exceeds ceiling ${ceiling}\nCurrent candidate locations (not historical identities):\n${locations[file].join('\n')}`,
      )
  }
  for (const file of builderFiles) {
    try {
      errors.push(
        ...assertionErrors(readFileSync(join(root, file), 'utf8'), file),
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      errors.push(`${file}: missing registered builder`)
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const ceiling = Object.values(baseline).reduce((sum, count) => sum + count, 0)
  const reduced = Object.entries(baseline).some(
    ([file, count]) => (counts[file] ?? 0) < count,
  )
  return { counts, errors, total, ceiling, reduced }
}

export function checkTestCasts(root, { update = false } = {}) {
  const baseline = JSON.parse(readFileSync(join(root, baselinePath), 'utf8'))
  const result = analyzeTree(root, baseline)
  const summary = `test cast ratchet: ${result.total} literal ${literal} occurrences; ceiling ${result.ceiling}`
  if (result.errors.length)
    throw new Error(`${summary}\n${result.errors.join('\n')}\n${guidance}`)
  if (update)
    writeFileSync(
      join(root, baselinePath),
      `${JSON.stringify(result.counts, null, 2)}\n`,
    )
  return `${summary}${result.reduced || update ? `\n${guidance}` : ''}`
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      checkTestCasts(process.cwd(), {
        update: process.argv.includes('--update-baseline'),
      }),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
