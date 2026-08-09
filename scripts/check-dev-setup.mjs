import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configArgs } from './dev-setup.mjs'

const persistTo = mkdtempSync(join(tmpdir(), 'artifactshare-dev-setup-check-'))
const seed = `INSERT INTO workspaces (id, name, created_at) VALUES ('check-workspace', 'check', '2026-01-01T00:00:00.000Z');
INSERT INTO users (id, email, created_at, updated_at, workspace_id) VALUES ('check-user', 'check@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'check-workspace');`
const app = join(resolve(import.meta.dirname, '..'), 'apps/web')

function run(command, args, cwd = process.cwd(), wrangler = false) {
  try {
    return execFileSync(command, args, {
      cwd,
      env: wrangler
        ? { ...process.env, WRANGLER_LOG_PATH: '../../.wrangler/logs' }
        : process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const commandLine = [command, ...args].join(' ')
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('')
    throw new Error(
      `Command failed (exit code ${error?.status ?? 'unknown'}): ${commandLine}\n${output}`,
      { cause: error },
    )
  }
}

function seedDatabase() {
  const common = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--local',
    ...configArgs('app', persistTo),
  ]
  run('pnpm', [...common, '--command', seed], app, true)
  const output = run(
    'pnpm',
    [...common, '--command', 'select count(*) as count from users', '--json'],
    app,
    true,
  )
  const rows = JSON.parse(output).flatMap(
    (item) => item.results ?? item.result ?? [],
  )
  if (Number(rows[0]?.count ?? 0) !== 1)
    throw new Error(
      `Seed failed: users contains ${rows[0]?.count ?? 0} rows, expected 1`,
    )
}

function setup(args) {
  return run('pnpm', ['dev:setup', ...args])
}

function main() {
  try {
    console.log('START empty state schema application')
    setup(['--persist-to', persistTo])
    console.log('PASS empty state schema application')
    console.log('START populated state reset (first run)')
    seedDatabase()
    setup(['--reset', '--persist-to', persistTo])
    console.log('PASS populated state reset (first run)')
    console.log('START populated state reset (second run)')
    // Seed again because the first reset removes the rows; an empty database cannot test dependency order.
    seedDatabase()
    setup(['--reset', '--persist-to', persistTo])
    console.log('PASS populated state reset (second run)')
  } finally {
    rmSync(persistTo, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
