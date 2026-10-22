import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const webRoot = new URL('../..', import.meta.url).pathname

// Cloudflare also writes .wrangler/deploy/config.json and React Router writes
// generated metadata beneath the project root. Own that root as well as output
// so the test cannot replace a normal build's deployment redirect or metadata.
export async function buildUsercontentApp(directory: string): Promise<void> {
  const project = join(directory, 'apps/web')
  await mkdir(join(directory, 'apps'), { recursive: true })
  await cp(webRoot, project, {
    recursive: true,
    filter: (source) =>
      ![
        'node_modules',
        'build',
        '.wrangler',
        '.react-router',
        '.vite',
      ].includes(basename(source)),
  })
  await symlink(join(webRoot, 'node_modules'), join(project, 'node_modules'))
  await symlink(
    resolve(webRoot, '../../node_modules'),
    join(directory, 'node_modules'),
  )
  await symlink(resolve(webRoot, '../../packages'), join(directory, 'packages'))
  await symlink(resolve(webRoot, '../../scripts'), join(directory, 'scripts'))
  // The behavior command already builds the contract package. Only compile the
  // copied app here; never rebuild shared package output from browser instances.
  await run('pnpm', ['exec', 'react-router', 'build'], {
    cwd: project,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(directory, 'logs'),
      ARTIFACTSHARE_TEST_BUILD_DIRECTORY: join(directory, 'build'),
    },
  })
}

// Concurrent engines share one immutable build. The last consumer removes it;
// an unsuccessful build is removed too, without leaving a rejected cache entry.
export function sharedUsercontentBuild(
  build: (directory: string) => Promise<void>,
) {
  let current: { ready: Promise<string>; users: number } | undefined
  return async () => {
    const state = (current ??= {
      users: 0,
      ready: (async () => {
        const directory = await mkdtemp(join(tmpdir(), 'usercontent-build-'))
        try {
          await build(directory)
          return directory
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          throw error
        }
      })(),
    })
    state.users++
    let released = false
    const release = async () => {
      if (released) return
      released = true
      if (--state.users === 0) {
        current = undefined
        const directory = await state.ready.catch(() => undefined)
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
    try {
      return { directory: await state.ready, release }
    } catch (error) {
      await release()
      throw error
    }
  }
}

export const acquireUsercontentBuild =
  sharedUsercontentBuild(buildUsercontentApp)
