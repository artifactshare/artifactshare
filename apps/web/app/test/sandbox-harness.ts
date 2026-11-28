import { fileURLToPath } from 'node:url'
import { applyBrowserFixtureSchema } from './browser-fixture-schema'

const webRoot = fileURLToPath(new URL('../..', import.meta.url))

async function startSandboxWorker(secret: string) {
  const { createTestHarness } = await import('wrangler')
  const harness = createTestHarness({
    root: webRoot,
    workers: [
      {
        configPath: 'wrangler.sandbox.jsonc',
        secrets: { BETTER_AUTH_SECRET: secret },
      },
    ],
  })
  try {
    const worker = harness.getWorker<{ DB: D1Database; BUCKET: R2Bucket }>()
    await harness.listen()
    await applyBrowserFixtureSchema((await worker.getEnv()).DB)
    return { harness, worker }
  } catch (error) {
    await harness.close()
    throw error
  }
}

const started = new Map<string, ReturnType<typeof startSandboxWorker>>()

// Starts the real sandbox Worker (wrangler.sandbox.jsonc) with the current
// schema once per secret and keeps it until closeSandboxWorkers runs when
// Vitest closes. Every scenario seeds its own workspace, artifact and version
// under random ids and reaches them through its own signed hostname, so
// scenarios share the Worker and its storage without reading each other's rows.
export async function sandboxWorker(secret: string) {
  let start = started.get(secret)
  if (!start) {
    start = startSandboxWorker(secret)
    started.set(secret, start)
    start.catch(() => started.delete(secret))
  }
  return (await start).worker
}

export async function closeSandboxWorkers() {
  const starts = [...started.values()]
  started.clear()
  await Promise.allSettled(
    starts.map(async (start) => (await start).harness.close()),
  )
}
