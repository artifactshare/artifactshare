import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CliOptions, OutputMode, ParsedArgs } from '../types.js'

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  requestConfig: vi.fn(),
  resolveCredential: vi.fn(),
  runAuthenticatedApi: vi.fn(),
  writeFailure: vi.fn(),
  writeSuccess: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('../api.js', () => ({
  apiGet: vi.fn(),
  apiPost: mocks.apiPost,
  requestConfig: mocks.requestConfig,
}))
vi.mock('../credentials.js', () => ({
  resolveCredential: mocks.resolveCredential,
}))
vi.mock('../output.js', () => ({
  writeFailure: mocks.writeFailure,
  writeSuccess: mocks.writeSuccess,
  writeText: mocks.writeText,
}))
vi.mock('./auto-login.js', () => ({
  runAuthenticatedApi: mocks.runAuthenticatedApi,
}))

import { runProjectsCreate } from './projects.js'

const mode: OutputMode = { json: true }
let workDir: string
let configHome: string
let originalCwd: string
let originalConfigHome: string | undefined

beforeEach(async () => {
  originalCwd = process.cwd()
  originalConfigHome = process.env.ARTIFACTSHARE_CONFIG_HOME
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-projects-contract-'))
  configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-projects-contract-config-'),
  )
  process.env.ARTIFACTSHARE_CONFIG_HOME = configHome
  vi.clearAllMocks()
  mocks.requestConfig.mockReturnValue({ init: {} })
  mocks.resolveCredential.mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'env',
  })
  mocks.runAuthenticatedApi.mockImplementation(
    async (
      credential: { token: string },
      _options: CliOptions,
      request: (current: { token: string }) => Promise<unknown>,
    ) => await request(credential),
  )
  mocks.apiPost.mockResolvedValue({
    body: {
      project: {
        id: 'prj_created',
        name: 'Client reports',
        description: null,
        base_visibility: 'private',
      },
    },
  })
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (originalConfigHome === undefined) {
    delete process.env.ARTIFACTSHARE_CONFIG_HOME
  } else {
    process.env.ARTIFACTSHARE_CONFIG_HOME = originalConfigHome
  }
  await rm(workDir, { recursive: true, force: true })
  await rm(configHome, { recursive: true, force: true })
})

function parsed(options: CliOptions = {}): ParsedArgs {
  return {
    command: 'projects create',
    options,
    positionals: ['Client reports'],
  }
}

async function runCreate(options: CliOptions, repositoryVisibility?: string) {
  process.chdir(workDir)
  if (repositoryVisibility) {
    await mkdir(join(workDir, '.artifactshare'))
    await writeFile(
      join(workDir, '.artifactshare/config.json'),
      JSON.stringify({ default_project_visibility: repositoryVisibility }),
    )
  }
  await runProjectsCreate(parsed(options), mode)
}

describe('runProjectsCreate visibility contract', () => {
  test('maps repository default visibility to the API request and response', async () => {
    await writeFile(
      join(configHome, 'config.json'),
      JSON.stringify({ default_project_visibility: 'workspace' }),
    )

    await runCreate({}, 'private')

    expect(mocks.requestConfig).toHaveBeenCalledWith({})
    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/cli/projects',
      'test-token',
      {
        name: 'Client reports',
        description: null,
        base_visibility: 'private',
      },
      {},
      {},
      { credentialSource: 'env' },
    )
    expect(mocks.writeSuccess).toHaveBeenCalledWith(
      'projects create',
      {
        project: {
          id: 'prj_created',
          name: 'Client reports',
          description: null,
          base_visibility: 'private',
        },
        next_command:
          'npx --yes @artifactshare/cli share <path> --project-id prj_created --json',
      },
      mode,
    )
  })

  test('maps explicit visibility instead of reading the default config', async () => {
    await writeFile(
      join(configHome, 'config.json'),
      JSON.stringify({ default_project_visibility: 'private' }),
    )

    await runCreate({ visibility: 'workspace' })

    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/cli/projects',
      'test-token',
      {
        name: 'Client reports',
        description: null,
        base_visibility: 'workspace',
      },
      { visibility: 'workspace' },
      {},
      { credentialSource: 'env' },
    )
    expect(mocks.resolveCredential).toHaveBeenCalledTimes(1)
  })
})
