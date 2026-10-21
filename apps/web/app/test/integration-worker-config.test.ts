import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { integrationWorkerConfig } from './integration-worker-config'

const readConfig = (file: string) => ({
  ...unstable_readConfig(
    { config: new URL(`../../${file}`, import.meta.url).pathname },
    { hideWarnings: true },
  ),
})

test.each(['wrangler.jsonc', 'wrangler.production.jsonc'])(
  'runs a %s build with the public harness service and storage identities',
  (file) => {
    const built = {
      ...readConfig(file),
      main: 'index.js',
      assets: { directory: '../client' },
    }
    const runtime = readConfig('wrangler.jsonc')
    const config = integrationWorkerConfig(built, runtime)
    const og = readConfig('wrangler.og-image.jsonc')
    const alerts = readConfig('wrangler.alerts.jsonc')
    const sandbox = readConfig('wrangler.sandbox.jsonc')
    expect(config.services).toEqual([
      { binding: 'OG_IMAGE_WORKER', service: og.name },
    ])
    expect(config.tail_consumers).toEqual([{ service: alerts.name }])
    const migrationDirectory = fileURLToPath(
      new URL('../../db/migrations', import.meta.url),
    )
    expect(config.d1_databases).toEqual(
      sandbox.d1_databases.map((database: Record<string, unknown>) => ({
        ...database,
        migrations_dir: migrationDirectory,
      })),
    )
    // Wrangler resolves this field relative to the generated config directory.
    // It must still reach the repository migrations, not build/server/db.
    const databases = config.d1_databases as Array<{ migrations_dir: string }>
    for (const database of databases) {
      expect(isAbsolute(database.migrations_dir)).toBe(true)
      const directory = resolve(
        fileURLToPath(new URL('../../build/server', import.meta.url)),
        database.migrations_dir,
      )
      expect(directory).toBe(migrationDirectory)
      expect(readdirSync(directory).some((name) => name.endsWith('.sql'))).toBe(
        true,
      )
    }
    expect(config.r2_buckets).toEqual(
      expect.arrayContaining(sandbox.r2_buckets),
    )
    expect(config.name).toBe(runtime.name)
    expect(config.vars).toEqual(runtime.vars)
    expect(config.main).toBe('index.js')
    expect(config.assets).toEqual({ directory: '../client' })
    expect(config.ai).toBeUndefined()
    expect(config.flagship).toBeUndefined()
    expect(config.configPath).toBeUndefined()
    expect(config.userConfigPath).toBeUndefined()
    expect(built.name).toBe(readConfig(file).name)
  },
)

test('disables remote bindings without changing either input', () => {
  const built = { custom: { remote: true }, ai: { binding: 'AI' } }
  const runtime = {
    services: [{ binding: 'LOCAL', service: 'fixture', remote: true }],
  }
  expect(integrationWorkerConfig(built, runtime)).toEqual({
    custom: { remote: false },
    services: [{ binding: 'LOCAL', service: 'fixture', remote: false }],
  })
  expect(built.custom.remote).toBe(true)
  expect(runtime.services[0].remote).toBe(true)
})

test('preserves absolute migration directories and the source config', () => {
  const source = {
    configPath: '/tmp/integration-example/wrangler.jsonc',
    d1_databases: [
      { binding: 'DB', migrations_dir: '/tmp/integration-example/schema' },
    ],
  }
  expect(integrationWorkerConfig({}, source).d1_databases).toEqual(
    source.d1_databases,
  )
  expect(source.d1_databases[0].migrations_dir).toBe(
    '/tmp/integration-example/schema',
  )
})

test('resolves the default migration directory against the source config', () => {
  expect(
    integrationWorkerConfig(
      {},
      {
        configPath: '/tmp/integration-example/wrangler.jsonc',
        d1_databases: [{ binding: 'DB' }],
      },
    ).d1_databases,
  ).toEqual([
    { binding: 'DB', migrations_dir: '/tmp/integration-example/migrations' },
  ])
  expect(() =>
    integrationWorkerConfig({}, { d1_databases: [{ binding: 'DB' }] }),
  ).toThrow('source config path')
})
