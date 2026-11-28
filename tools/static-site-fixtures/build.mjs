import { execFile } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const packageRoot = path.join(repoRoot, 'tools/static-site-fixtures')
const buildersRoot = path.join(packageRoot, 'builders')
const outputRoot = path.join(repoRoot, 'fixtures/static-sites')

// Each framework writes its output its own way, so the steps stay per fixture.
// What is shared is the output name, and this table is where it is declared:
// one entry per directory this script leaves under fixtures/static-sites/.
// Anything that needs to know which fixtures exist reads `staticSiteFixtureNames`
// from here rather than listing builders/, which holds the inputs and carries
// a README beside them.
export const staticSiteFixtures = [
  {
    name: 'react-spa',
    // The Vite config writes straight into the output directory.
    async build() {
      await run(bin('vite'), [
        'build',
        '--config',
        builder('react-spa/vite.config.mjs'),
      ])
    },
  },
  {
    name: 'react-router-prerender',
    async build(output) {
      await rm(builder('react-router-prerender/build'), {
        recursive: true,
        force: true,
      })
      await run(bin('react-router'), ['build'], {
        cwd: builder('react-router-prerender'),
      })
      await cp(builder('react-router-prerender/build/client'), output, {
        recursive: true,
      })
    },
  },
  {
    name: 'next-export',
    async build(output) {
      await rm(builder('next-export/.next'), { recursive: true, force: true })
      await rm(builder('next-export/out'), { recursive: true, force: true })
      await run(bin('next'), ['build'], {
        cwd: builder('next-export'),
        NEXT_TELEMETRY_DISABLED: '1',
      })
      await cp(builder('next-export/out'), output, { recursive: true })
    },
  },
]

export const staticSiteFixtureNames = staticSiteFixtures
  .map((fixture) => fixture.name)
  .sort()

async function main() {
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  for (const fixture of staticSiteFixtures)
    await fixture.build(path.join(outputRoot, fixture.name))
}

function builder(relativePath) {
  return path.join(buildersRoot, relativePath)
}

function bin(command) {
  return path.join(packageRoot, 'node_modules/.bin', command)
}

async function run(command, args, options = {}) {
  const { cwd = repoRoot, ...env } = options
  const result = await execFileAsync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 10,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

// Importing this file must only read the table, so the build runs when the
// file is the entry point and not when dev-setup.mjs reads the names.
// import.meta.main, not a comparison against argv[1]: argv[1] crossing a
// symlink would not match this URL and the build would do nothing, quietly
// and with exit code 0.
if (import.meta.main)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
