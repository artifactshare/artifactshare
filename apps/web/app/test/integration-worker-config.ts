import { dirname, resolve } from 'node:path'

// Keep the compiled modules and assets, but use the harness's resource identity.
// Production and preview builds can both precede local integration tests.
export function integrationWorkerConfig(
  built: Record<string, unknown>,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...built }
  for (const key of [
    'name',
    'vars',
    'services',
    'tail_consumers',
    'd1_databases',
    'r2_buckets',
    'kv_namespaces',
    'workflows',
  ]) {
    if (runtime[key] === undefined) delete config[key]
    else config[key] = runtime[key]
  }
  // The generated config lives in build/server, but migration paths belong
  // to the source runtime config. Resolve them before dropping that location.
  if (Array.isArray(config.d1_databases) && config.d1_databases.length) {
    if (typeof runtime.configPath !== 'string') {
      throw new Error('Integration D1 bindings require the source config path')
    }
    const sourceDirectory = dirname(runtime.configPath)
    config.d1_databases = config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: resolve(
        sourceDirectory,
        database.migrations_dir ?? 'migrations',
      ),
    }))
  }
  delete config.configPath
  delete config.userConfigPath
  // These bindings have no local simulator and start a remote proxy.
  delete config.ai
  delete config.flagship
  return localBindings(config) as Record<string, unknown>
}

function localBindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localBindings)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'remote' ? false : localBindings(child),
    ]),
  )
}
