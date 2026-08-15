import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function parseArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const allowed = new Set(['--dry-run', '--ui-gate-complete'])
  if (normalized.some((arg) => !allowed.has(arg)))
    throw new Error('Usage: pnpm pr:ready -- [--dry-run] [--ui-gate-complete]')
  return {
    dryRun: normalized.includes('--dry-run'),
    uiGateComplete: normalized.includes('--ui-gate-complete'),
  }
}

function isUiFile(file) {
  if (file.startsWith('apps/web/public/')) return true
  if (/^apps\/web\/app\/.*\.css$/u.test(file)) return true
  if (/^apps\/web\/app\/i18n\/[^/]+\.json$/u.test(file)) return true
  if (/^apps\/web\/app\/(?:guides|legal|updates\/entries)\/.*\.md$/u.test(file))
    return true
  if (
    /^apps\/web\/app\/(?:components|hooks|lib)\/.*\.ts$/u.test(file) ||
    /^apps\/web\/app\/routes\/.*\/(?:\+components|\+hooks)\/.*\.ts$/u.test(file)
  )
    return !/\.(?:(?:test|spec)|server)\.ts$/u.test(file)
  if (!/^apps\/web\/app\/.*\.tsx$/u.test(file)) return false
  if (/\.(?:test|spec)\.tsx$/u.test(file)) return false
  if (file === 'apps/web/app/entry.server.tsx') return false
  return !/^apps\/web\/app\/routes\/api\./u.test(file)
}

function uiFiles(exec, base) {
  return output(exec, 'git', [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `origin/${base}...HEAD`,
  ])
    .split('\n')
    .filter(Boolean)
    .filter(isUiFile)
}

function ready({
  exec = execFileSync,
  parsed = parseArgs(process.argv.slice(2)),
} = {}) {
  const branch = output(exec, 'git', ['branch', '--show-current'])
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  if (output(exec, 'git', ['status', '--porcelain']))
    throw new Error('Working tree must be clean.')
  const rows = JSON.parse(
    output(exec, 'gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,isDraft,baseRefName,headRefName,headRefOid',
    ]),
  )
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Exactly one open PR for the current branch is required.')
  const pr = rows[0]
  if (!pr.isDraft || pr.baseRefName !== 'main' || pr.headRefName !== branch)
    throw new Error(
      'PR must be a Draft targeting main from the current branch.',
    )
  if (pr.headRefOid !== head)
    throw new Error('Push the current HEAD before making the PR ready.')
  const changedUiFiles = uiFiles(exec, pr.baseRefName)
  if (changedUiFiles.length > 0 && !parsed.uiGateComplete)
    throw new Error(
      [
        'UI changes detected. Ready was not changed.',
        'Before retrying, confirm all of the following:',
        '- Every affected screen state has been captured.',
        '- UI critique using the captures and relevant source is complete; captures alone are not sufficient.',
        '- HEAD has no UI changes after that critique. If it does, recapture and repeat the critique.',
        'Then run: pnpm pr:ready -- --ui-gate-complete',
      ].join('\n'),
    )
  exec('gh', ['pr', 'checks', String(pr.number), '--required'])
  if (!parsed.dryRun) exec('gh', ['pr', 'ready', String(pr.number)])
  return { number: pr.number, head, dryRun: parsed.dryRun }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = ready()
    process.stdout.write(
      `${result.dryRun ? 'Would mark' : 'Marked'} PR #${result.number} ready at ${result.head}.\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

export { isUiFile, parseArgs, ready }
