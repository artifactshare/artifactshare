import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const repair =
  're-test the D1 suite (`pnpm test:d1`) and update or remove the override'
const selectorPattern = /^vite@(\d+\.\d+\.\d+(?:-[\w.-]+)?)>rolldown$/u
const withoutPeers = (version) => version.split('(')[0]

function parseDocuments(source, filename) {
  const documents = parseAllDocuments(source)
  for (const document of documents) {
    if (document.errors.length)
      throw new Error(
        `${filename}: repair invalid YAML: ${document.errors[0].message}`,
      )
  }
  return documents.map((document) => document.toJS())
}

export function analyzeDependencyOverrides(workspaceSource, lockSource) {
  const workspaces = parseDocuments(workspaceSource, 'pnpm-workspace.yaml')
  if (workspaces.length !== 1 || !workspaces[0]?.overrides)
    throw new Error('pnpm-workspace.yaml: restore the dependency overrides')
  const workspace = workspaces[0]
  const applications = parseDocuments(lockSource, 'pnpm-lock.yaml').filter(
    (document) =>
      document?.importers?.['.'] && document?.importers?.['apps/web'],
  )
  if (applications.length !== 1)
    throw new Error(
      'pnpm-lock.yaml: restore the application workspace document',
    )
  const lock = applications[0]
  const overrides = Object.entries(workspace.overrides).filter(([key]) =>
    selectorPattern.test(key),
  )
  const fail = (message) => {
    throw new Error(`${message}; ${repair}`)
  }
  if (overrides.length !== 1)
    fail(
      'pnpm-workspace.yaml: expected one exact vite@<version>>rolldown override',
    )
  const [selector, pinned] = overrides[0]
  const parent = selector.match(selectorPattern)[1]
  const lockOverrides = Object.entries(lock.overrides ?? {}).filter(([key]) =>
    /^vite@.*>rolldown$/u.test(key),
  )
  if (
    lockOverrides.length !== 1 ||
    lockOverrides[0][0] !== selector ||
    lockOverrides[0][1] !== pinned
  )
    fail(
      `pnpm-lock.yaml: override metadata does not match ${selector}: ${pinned}`,
    )
  const packages = Object.keys(lock.packages ?? {}).filter((key) =>
    key.startsWith('vite@'),
  )
  const snapshots = Object.entries(lock.snapshots ?? {}).filter(([key]) =>
    key.startsWith('vite@'),
  )
  if (!packages.length || !snapshots.length)
    fail(`pnpm-lock.yaml: missing Vite packages or snapshots for ${selector}`)
  for (const key of [
    ...packages,
    ...snapshots.map(([snapshotKey]) => snapshotKey),
  ]) {
    if (withoutPeers(key) !== `vite@${parent}`)
      fail(`pnpm-lock.yaml: ${key} does not match ${selector}`)
  }
  for (const [key, snapshot] of snapshots) {
    const edge = snapshot?.dependencies?.rolldown
    if (typeof edge !== 'string' || !edge)
      fail(`pnpm-lock.yaml: ${key} is missing its rolldown dependency edge`)
    const version = withoutPeers(edge)
    if (version === '1.2.15')
      fail(
        `pnpm-lock.yaml: ${key} resolves broken rolldown@${version} (${selector})`,
      )
    if (version !== pinned)
      fail(
        `pnpm-lock.yaml: ${key} resolves rolldown@${version}, expected ${selector}: ${pinned}`,
      )
  }
  return `Dependency overrides check ok: ${selector}: ${pinned}, ${snapshots.length} Vite snapshots`
}

export function checkDependencyOverrides(inputRoot = root) {
  const read = (filename) => {
    try {
      return readFileSync(resolve(inputRoot, filename), 'utf8')
    } catch (error) {
      throw new Error(
        `${filename}: restore a readable input file (${error.code})`,
      )
    }
  }
  return analyzeDependencyOverrides(
    read('pnpm-workspace.yaml'),
    read('pnpm-lock.yaml'),
  )
}

if (import.meta.main) {
  try {
    console.log(checkDependencyOverrides(process.argv[2] ?? root))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
