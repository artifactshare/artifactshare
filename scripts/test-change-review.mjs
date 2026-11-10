#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const testPath = (file) =>
  /(?:^|\/)(?:test|tests|__tests__)\//.test(file) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(?:^|\/)(?:vitest|playwright)[^/]*\.[cm]?[jt]s$/.test(file) ||
  /(?:^|\/)[^/]*fixture[^/]*\.[cm]?[jt]sx?$/.test(file) ||
  file.startsWith('scripts/ci/') ||
  file.startsWith('.github/workflows/')

function categories(line, side) {
  const result = []
  if (
    /\b(?:timeout(?:Ms)?|testTimeout|hookTimeout|actionTimeout|navigationTimeout|retry|retries|repeats|REPETITIONS|REPETITION_TIMEOUT_MS)\s*[:=]/.test(
      line,
    )
  )
    result.push('execution-limit')
  if (
    /\b(?:test|it)\s*\.\s*(?:setTimeout|slow)\s*\(|\btimeout\s*[,}]/.test(line)
  )
    result.push('execution-limit')
  if (
    side === 'added' &&
    /\b(?:test|it|describe)\s*\.\s*(?:skip|skipIf|runIf|only|todo|fixme|fails)\b/.test(
      line,
    )
  )
    result.push('test-selection')
  if (
    side === 'added' &&
    /\b(?:skip|only|todo)\s*:|\bctx\s*\.\s*skip\s*\(/.test(line)
  )
    result.push('test-selection')
  if (
    side === 'removed' &&
    /\bexpect(?:\.(?:soft|poll))?\s*\(|\bassert(?:\.[A-Za-z]+)?\s*\(|\.to[A-Z]\w*\s*\(/.test(
      line,
    )
  )
    result.push('removed-assertion')
  if (
    /\b(?:length|size|count|pageCount|pages|iterations|width|height)\s*[:=][^\n]*\d/.test(
      line,
    )
  )
    result.push('fixture-load')
  return result
}

export function inspectTestPatch(patch) {
  const notes = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      inHunk = true
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
    } else if (inHunk && line.startsWith('+')) {
      for (const kind of categories(line.slice(1), 'added'))
        notes.push({ kind, side: 'added', line: newLine })
      newLine++
    } else if (inHunk && line.startsWith('-')) {
      for (const kind of categories(line.slice(1), 'removed'))
        notes.push({ kind, side: 'removed', line: oldLine })
      oldLine++
    } else if (line.startsWith(' ')) {
      oldLine++
      newLine++
    }
  }
  return notes
}

export function collectTestChanges({
  base,
  head,
  run = (file, args) =>
    execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
}) {
  for (const sha of [base, head]) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? ''))
      throw new Error('Test change review requires fixed full base/head SHAs.')
    run('git', ['cat-file', '-e', `${sha}^{commit}`])
  }
  const tokens = run('git', [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    base,
    head,
    '--',
  ]).split('\0')
  if (tokens.pop() !== '') throw new Error('Invalid test-change path report')
  const files = []
  while (tokens.length) {
    const status = tokens.shift()
    const file = tokens.shift()
    if (!/^[AMDT]$/.test(status ?? '') || !file)
      throw new Error('Invalid test-change status')
    if (!testPath(file)) continue
    const patch = run('git', [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--unified=0',
      base,
      head,
      '--',
      file,
    ])
    const all = inspectTestPatch(patch)
    if (status === 'D')
      all.unshift({ kind: 'removed-test-file', side: 'removed', line: 1 })
    files.push({
      file,
      status,
      notes: all.slice(0, 40),
      omitted: Math.max(0, all.length - 40),
    })
  }
  return { schemaVersion: 1, base, head, files }
}

export function renderTestChanges(report) {
  return [
    '## Changed test evidence',
    'These are syntactic review cues, not proof that a change is wrong or that all weakening was found. For execution limits, test selection, removed assertions and fixture load, inspect the fixed diff and require the cause, preserved behavior and normal/fault evidence where detection changes. A legitimate timeout, capability difference or synthetic negative fixture is not automatically a defect. Missing baseline imports or new APIs do not prove detection. No source text is copied into this summary.',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--base' || args[2] !== '--head')
      throw new Error(
        'Usage: node scripts/test-change-review.mjs --base <sha> --head <sha>',
      )
    process.stdout.write(
      `${JSON.stringify(collectTestChanges({ base: args[1], head: args[3] }), null, 2)}\n`,
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
