import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test('routes both client and server output to the harness-owned build directory', async () => {
  vi.stubEnv(
    'ARTIFACTSHARE_TEST_BUILD_DIRECTORY',
    '/tmp/usercontent-example/build',
  )
  const { default: config } = await import(
    new URL('../../react-router.config.ts', import.meta.url).href
  )
  expect(config.buildDirectory).toBe('/tmp/usercontent-example/build')
})

test('ordinary builds keep the existing output directory', async () => {
  vi.stubEnv('ARTIFACTSHARE_TEST_BUILD_DIRECTORY', undefined)
  const { default: config } = await import(
    new URL('../../react-router.config.ts', import.meta.url).href
  )
  expect(config.buildDirectory).toBe('build')
})
