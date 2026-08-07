import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  resolveDefaultVisibility,
  resolveHomeVisibility,
  resolveVisibility,
  type ProjectConfigResolution,
} from './destination.js'

test.each([
  [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'workspace',
    'product_default',
  ],
  [
    undefined,
    'private',
    'not-a-visibility',
    'workspace',
    'private',
    'private',
    'repository',
  ],
  [
    undefined,
    undefined,
    'private',
    'workspace',
    'private',
    'private',
    'repository',
  ],
  [undefined, undefined, undefined, 'private', 'workspace', 'private', 'user'],
  [undefined, undefined, undefined, undefined, 'private', 'private', 'user'],
] as const)(
  'resolves home audience in new-over-legacy five-level order',
  (
    explicit,
    repositoryHome,
    repositoryLegacy,
    userHome,
    userLegacy,
    expected,
    source,
  ) => {
    assert.deepEqual(
      resolveHomeVisibility(
        explicit,
        repositoryHome,
        repositoryLegacy,
        userHome,
        userLegacy,
      ),
      { value: expected, source },
    )
  },
)

test('home audience rejects an invalid selected value without falling back', () => {
  assert.deepEqual(
    resolveHomeVisibility(undefined, 'bad', 'private', 'workspace', 'private'),
    { invalid: 'repository' },
  )
  assert.deepEqual(
    resolveHomeVisibility(undefined, undefined, undefined, 'bad', 'private'),
    { invalid: 'user' },
  )
})

test.each([
  [undefined, undefined, 'workspace', 'product_default'],
  ['workspace', undefined, 'workspace', 'repository'],
  ['private', undefined, 'private', 'repository'],
  [undefined, 'workspace', 'workspace', 'user'],
  [undefined, 'private', 'private', 'user'],
  ['workspace', 'private', 'workspace', 'repository'],
  ['private', 'workspace', 'private', 'repository'],
  ['workspace', 'workspace', 'workspace', 'repository'],
  ['private', 'private', 'private', 'repository'],
] as const)(
  'resolves repository over user over product default',
  (repository, user, expected, source) => {
    assert.deepEqual(resolveVisibility(undefined, repository, user), {
      value: expected,
      source,
    })
  },
)

test('repository visibility short-circuits unreadable lower-priority user config', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-visibility-config-'),
  )
  const originalConfigHome = process.env.ARTIFACTSHARE_CONFIG_HOME
  process.env.ARTIFACTSHARE_CONFIG_HOME = configHome
  await writeFile(join(configHome, 'config.json'), '{invalid')

  const repositoryConfig = (value: unknown): ProjectConfigResolution => ({
    config: { default_project_visibility: value } as never,
    raw: { default_project_visibility: value },
    kind: 'shared',
    path: '.artifactshare/config.json',
    directory: process.cwd(),
  })

  try {
    assert.deepEqual(
      await resolveDefaultVisibility(
        'default_project_visibility',
        repositoryConfig('private'),
      ),
      { value: 'private', source: 'repository' },
    )
    const invalid = await resolveDefaultVisibility(
      'default_project_visibility',
      repositoryConfig('public'),
    )
    assert.ok('error' in invalid)
    assert.match(invalid.error.message, /Repository/)
  } finally {
    if (originalConfigHome === undefined) {
      delete process.env.ARTIFACTSHARE_CONFIG_HOME
    } else {
      process.env.ARTIFACTSHARE_CONFIG_HOME = originalConfigHome
    }
    await rm(configHome, { recursive: true, force: true })
  }
})

const defaultVisibilityCases = [
  [undefined, undefined],
  ['workspace', undefined],
  ['private', undefined],
  [undefined, 'workspace'],
  [undefined, 'private'],
  ['workspace', 'private'],
  ['private', 'workspace'],
  ['workspace', 'workspace'],
  ['private', 'private'],
] as const

test.each(
  defaultVisibilityCases.flatMap(([repository, user]) => [
    ['workspace', repository, user, 'workspace'],
    ['private', repository, user, 'private'],
  ]),
)(
  'explicit visibility overrides defaults',
  (explicit, repository, user, expected) => {
    assert.deepEqual(resolveVisibility(explicit, repository, user), {
      value: expected,
      source: 'explicit',
    })
  },
)

test.each([
  ['explicit', 'public', undefined, undefined],
  ['repository', undefined, 'public', undefined],
  ['user', undefined, undefined, 'public'],
] as const)(
  'rejects invalid visibility at the first populated scope',
  (scope, explicit, repository, user) => {
    assert.deepEqual(resolveVisibility(explicit, repository, user), {
      invalid: scope,
    })
  },
)
