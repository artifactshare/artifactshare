import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const compiler = join(
  dirname(require.resolve('typescript/package.json')),
  'bin/tsc',
)

test('the bridge guard requires an explicit policy for a new authority kind', () => {
  // Compile the production declarations in isolation, without loading Workers
  // or generated route types. Do not duplicate the union or guard in a fixture.
  const authoritySource = readFileSync(
    new URL('../services/cli-authority.server.ts', import.meta.url),
    'utf8',
  )
  const policySource = readFileSync(
    new URL('../lib/cli-authority-policy.ts', import.meta.url),
    'utf8',
  )
  const authority = authoritySource.match(
    /export type CliAuthority =[\s\S]*?(?=\n\/\*\*)/,
  )?.[0]
  const guard = policySource.match(
    /export function bridgeCliAuthority\([\s\S]*?(?=\nexport function|$)/,
  )?.[0]
  expect(authority).toBeDefined()
  expect(guard).toBeDefined()

  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-bridge-types-'))
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        files: ['guard.ts'],
      }),
    )
    const compile = (union: string) => {
      writeFileSync(join(directory, 'guard.ts'), `${union}\n${guard}`)
      return spawnSync(
        process.execPath,
        [compiler, '-p', directory, '--pretty', 'false'],
        {
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
    }
    const recognized = compile(authority!)
    expect(recognized.error).toBeUndefined()
    expect(recognized.status, recognized.stdout + recognized.stderr).toBe(0)

    const expanded = compile(`${authority} | { kind: 'future' }`)
    expect(expanded.error).toBeUndefined()
    expect(expanded.status).not.toBe(0)
    expect(expanded.stdout).toContain('error TS2322:')
    expect(expanded.stdout).toContain(
      "Type '{ kind: \"future\"; }' is not assignable to type 'never'.",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
