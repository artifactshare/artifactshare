import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'artifactshare-cli-package-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
    cwd: packageDir,
    stdio: 'inherit',
  })
  const tarballs = readdirSync(temporary).filter((name) =>
    name.endsWith('.tgz'),
  )
  assert.equal(tarballs.length, 1)
  execFileSync(
    'npm',
    [
      'install',
      join(temporary, tarballs[0]),
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: temporary,
      stdio: 'inherit',
    },
  )
  const installed = join(temporary, 'node_modules/@artifactshare/cli')
  const manifest = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8'),
  )
  assert.equal(manifest.dependencies?.['@artifactshare/contract'], undefined)
  assert.equal(
    existsSync(join(temporary, 'node_modules/@artifactshare/contract')),
    false,
  )
  const entry = join(temporary, 'node_modules/.bin/artifactshare')
  const version = execFileSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
  })
  assert.ok(version.includes(`artifactshare v${manifest.version}`))
  execFileSync(process.execPath, [entry, '--help'], { stdio: 'pipe' })
  console.log(
    'CLI pack/install smoke passed without workspace runtime dependencies.',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
