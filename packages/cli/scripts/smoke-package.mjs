import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
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
  assert.ok(version.includes(manifest.version))
  execFileSync(process.execPath, [entry, '--help'], { stdio: 'pipe' })
  const oldNode = join(temporary, 'old-node.cjs')
  writeFileSync(
    oldNode,
    "Object.defineProperty(process.versions, 'node', { value: '20.19.0' })",
  )
  for (const bin of ['cli', 'artifactshare']) {
    const result = spawnSync(
      process.execPath,
      [
        join(temporary, 'node_modules/.bin', bin),
        'whoami',
        '--bogus-flag',
        'x',
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(JSON.parse(result.stderr).error.code, 'unknown_option')
    const unsupported = spawnSync(
      process.execPath,
      [
        '--require',
        oldNode,
        join(temporary, 'node_modules/.bin', bin),
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(unsupported.status, 1)
    assert.equal(unsupported.stdout, '')
    assert.equal(
      JSON.parse(unsupported.stderr).error.code,
      'unsupported_node_version',
    )
  }
  const updateHelp = execFileSync(
    process.execPath,
    [entry, 'update', '--help'],
    { encoding: 'utf8' },
  )
  assert.match(updateHelp, /--label/)
  for (const path of ['README.md', 'skills/artifactshare/SKILL.md']) {
    let document = readFileSync(join(installed, path), 'utf8')
    if (path.endsWith('SKILL.md')) {
      assert.match(document, /\(references\/version-labels\.md\)/)
      document += readFileSync(
        join(installed, 'skills/artifactshare/references/version-labels.md'),
        'utf8',
      )
    }
    assert.match(document, /--label/)
    assert.match(document, /1–80 Unicode code points/)
  }
  assert.equal(
    existsSync(join(installed, 'skills/artifactshare/artifactshare.mdc')),
    false,
  )
  // Compare every packaged reference, including arbitrarily nested files.
  const sourceSkill = join(packageDir, 'skills/artifactshare')
  for (const relative of readdirSync(sourceSkill, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!relative.isFile()) continue
    const source = join(relative.parentPath, relative.name)
    const suffix = source.slice(sourceSkill.length + 1)
    assert.deepEqual(
      readFileSync(join(installed, 'skills/artifactshare', suffix)),
      readFileSync(source),
    )
  }
  // Exercise folder loading even before the production prose is split.
  const overlay = join(temporary, 'folder-overlay')
  cpSync(installed, overlay, { recursive: true })
  const nested = 'references/nested/detail.txt'
  mkdirSync(join(overlay, 'skills/artifactshare/references/nested'), {
    recursive: true,
  })
  writeFileSync(
    join(overlay, 'skills/artifactshare', nested),
    'synthetic nested reference\n',
  )
  const work = join(temporary, 'skill-work')
  const home = join(temporary, 'skill-home')
  mkdirSync(work)
  mkdirSync(home)
  execFileSync(
    process.execPath,
    [
      join(overlay, 'dist/index.js'),
      'skills',
      'install',
      '--tool',
      'cursor',
      '--scope',
      'project',
      '--json',
    ],
    {
      cwd: work,
      env: {
        ...process.env,
        HOME: home,
        ARTIFACTSHARE_CONFIG_HOME: home,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      stdio: 'pipe',
    },
  )
  assert.equal(
    readFileSync(join(work, '.cursor/skills/artifactshare', nested), 'utf8'),
    'synthetic nested reference\n',
  )
  assert.equal(existsSync(join(work, '.cursor/rules/artifactshare.mdc')), false)
  console.log(
    'CLI pack/install smoke passed without workspace runtime dependencies.',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
