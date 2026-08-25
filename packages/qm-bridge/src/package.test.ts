import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('..', import.meta.url).pathname
const cliPath = join(packageRoot, 'dist', 'cli.js')

describe('package boundaries', () => {
  it('exports the discriminants required to handle public result types', () => {
    const declaration = readFileSync(
      join(packageRoot, 'dist', 'index.d.ts'),
      'utf8',
    )
    expect(declaration).toMatch(/BridgeErrorCode/)
    expect(declaration).toMatch(/ContentKind/)
  })

  it('keeps published declarations compatible with non-generic typed arrays', () => {
    const declarations = readdirSync(join(packageRoot, 'dist')).filter((name) =>
      name.endsWith('.d.ts'),
    )
    for (const name of declarations) {
      const declaration = readFileSync(join(packageRoot, 'dist', name), 'utf8')
      expect(declaration).not.toMatch(/Uint8Array</)
    }
  })

  it('keeps root, client, and testing output free of Node imports', () => {
    const pending = ['index.js', 'client.js', 'testing.js']
    const seen = new Set<string>()
    while (pending.length > 0) {
      const name = pending.pop()!
      if (seen.has(name)) continue
      seen.add(name)
      const source = readFileSync(join(packageRoot, 'dist', name), 'utf8')
      expect(source).not.toMatch(/(?:from|import\s*)\s*['"]node:/)
      for (const match of source.matchAll(/from\s*['"]\.\/([^'"]+\.js)['"]/g)) {
        pending.push(match[1]!)
      }
    }
    expect(
      [...seen].some(
        (name) => !['index.js', 'client.js', 'testing.js'].includes(name),
      ),
    ).toBe(true)
  })

  it('ships a license scoped to the bridge package', () => {
    const license = readFileSync(join(packageRoot, 'LICENSE'), 'utf8')
    expect(license).toContain('@artifactshare/qm-bridge')
    expect(license).not.toContain('@artifactshare/cli')
  })

  it('returns a machine-readable usage error when --json is missing', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'check', '--config', 'x'],
      {
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_cli_usage' },
    })
  })

  it('checks config without exposing or requiring the credential value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qm-bridge-'))
    const configPath = join(directory, 'bridge.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        base_url: 'https://artifactshare.com',
        source: {
          kind: 'qm',
          installation_id: 'install-1',
          external_workspace_id: 'workspace-1',
        },
        allowed_conversations: [
          { kind: 'private_channel', current_id: 'channel-1' },
        ],
      }),
    )
    const stdout = execFileSync(
      process.execPath,
      [cliPath, 'check', '--config', configPath, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, ARTIFACTSHARE_BRIDGE_TOKEN: 'secret' },
      },
    )
    expect(stdout).not.toContain('secret')
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: { credential: { present: true } },
    })
  })
})
