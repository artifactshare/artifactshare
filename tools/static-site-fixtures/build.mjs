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

async function main() {
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })

  await run(bin('vite'), [
    'build',
    '--config',
    path.join(
      repoRoot,
      'tools/static-site-fixtures/builders/react-spa/vite.config.mjs',
    ),
  ])

  await rm(builder('react-router-prerender/build'), {
    recursive: true,
    force: true,
  })
  await run(bin('react-router'), ['build'], {
    cwd: builder('react-router-prerender'),
  })
  await cp(
    builder('react-router-prerender/build/client'),
    path.join(outputRoot, 'react-router-prerender'),
    { recursive: true },
  )

  await rm(builder('next-export/.next'), { recursive: true, force: true })
  await rm(builder('next-export/out'), { recursive: true, force: true })
  await run(bin('next'), ['build'], {
    cwd: builder('next-export'),
    NEXT_TELEMETRY_DISABLED: '1',
  })
  await cp(builder('next-export/out'), path.join(outputRoot, 'next-export'), {
    recursive: true,
  })
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

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
