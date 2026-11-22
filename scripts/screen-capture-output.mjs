import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, stat, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function screenCaptureOutputRoot(run = commandOutput) {
  const gitDir = resolve(run('git', ['rev-parse', '--absolute-git-dir']).trim())
  const checkout = resolve(run('git', ['rev-parse', '--show-toplevel']).trim())
  const parent = dirname(checkout)
  if (parent === checkout) {
    throw new Error(
      'Screen capture requires a checkout below the filesystem root',
    )
  }
  const worktreeId = createHash('sha256').update(gitDir).digest('hex')
  return join(parent, `.${basename(checkout)}-screen-captures`, worktreeId)
}

export function screenCaptureOutputDirectory(
  label,
  outputRoot = screenCaptureOutputRoot(),
) {
  return join(resolve(outputRoot), label)
}

// Resolve existing ancestors too: an output directory may not exist yet.
function physicalPath(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(physicalPath(parent), basename(absolute))
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
  )
}

export function assertSafeCaptureOutput(paths, run = commandOutput) {
  const worktrees = run('git', ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => physicalPath(field.slice('worktree '.length)))
  if (!worktrees.length)
    throw new Error('Cannot determine registered worktrees')
  for (const path of paths) {
    const candidate = physicalPath(path)
    if (
      worktrees.some(
        (worktree) =>
          contains(worktree, candidate) || contains(candidate, worktree),
      )
    ) {
      throw new Error(`Capture output overlaps a registered worktree: ${path}`)
    }
  }
}

export async function removeCaptureOutput(
  outputRoot,
  target,
  run = commandOutput,
) {
  assertSafeCaptureOutput([outputRoot, target], run)
  await rm(target, { recursive: true, force: true })
}

export async function createCaptureOutput(
  outputRoot,
  target,
  run = commandOutput,
) {
  assertSafeCaptureOutput([outputRoot, target], run)
  await mkdir(target, { recursive: true })
}

export function verifySettingsErrorEvidence(general, manifest) {
  const errorStates = general.states.filter((state) => state.expectedError)
  for (const id of [
    'forbidden',
    'not-found',
    'unexpected-error',
    'root-error',
  ]) {
    if (!errorStates.some((state) => state.id === id))
      throw new Error('Missing required error state: ' + id)
  }
  for (const state of errorStates) {
    for (const viewport of ['desktop', 'mobile'])
      for (const theme of ['light', 'dark']) {
        const evidence = manifest.find(
          (entry) =>
            entry.screen === general.id &&
            entry.state === state.id &&
            entry.viewport === viewport &&
            entry.theme === theme &&
            !entry.section,
        )
        if (
          !evidence ||
          evidence.httpStatus !== state.expectedStatus ||
          evidence.boundaryMarker !== state.expectedError ||
          evidence.readySelector !== state.setup.ready.selector
        )
          throw new Error(
            'Missing error evidence: ' + [state.id, viewport, theme].join('/'),
          )
      }
  }
}

if (
  process.argv[2] === '--check-labels' &&
  import.meta.filename === resolve(process.argv[1])
) {
  const labels = process.argv.slice(3)
  if (!labels.length) throw new Error('Provide at least one capture label')
  const head = commandOutput('git', ['rev-parse', 'HEAD'])
  for (const label of labels) {
    const directory = screenCaptureOutputDirectory(label)
    const manifest = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8'),
    )
    if (!manifest.length) throw new Error('Empty capture: ' + label)
    for (const entry of manifest) {
      if (entry.head !== head)
        throw new Error(
          `Capture revision mismatch for ${label}/${entry.file}: expected ${head}, found ${entry.head}`,
        )
      if (entry.status !== 'success' || !entry.file)
        throw new Error('Missing capture: ' + entry.screen + '/' + entry.state)
      const file = await stat(join(directory, entry.file))
      if (!file.isFile() || !file.size)
        throw new Error('Empty screenshot: ' + entry.file)
    }
    if (label === 'settings-errors') {
      for (const screen of [
        'settings',
        'settings-activity',
        'settings-analytics',
        'settings-billing',
        'settings-bots',
        'settings-external-access',
        'settings-general',
        'settings-integrations',
        'settings-inventory-artifacts',
        'settings-inventory-projects',
        'settings-tokens',
      ]) {
        if (!manifest.some((entry) => entry.screen === screen))
          throw new Error('Missing screen: ' + screen)
      }
      const { screens } = await import('./screen-ledger.mjs')
      const general = screens.find((screen) => screen.id === 'settings-general')
      verifySettingsErrorEvidence(general, manifest)
    }
  }
}
