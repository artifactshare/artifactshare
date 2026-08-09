import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  checkCliChangelogAtRoot,
  checkCliReleaseAtRoot,
  findVersionHeadings,
  validateCliChangelog,
  validateCliRelease,
} from './check-cli-changelog.mjs'

const SAMPLE_CHANGELOG = `# Changelog

## 0.6.0 - 2026-07-11

- Add example feature

## 0.5.0 - 2026-06-23

- Earlier change
`

test('findVersionHeadings collects version headings with dates', () => {
  assert.deepEqual(findVersionHeadings(SAMPLE_CHANGELOG), [
    {
      version: '0.6.0',
      strict: true,
      line: '## 0.6.0 - 2026-07-11',
    },
    {
      version: '0.5.0',
      strict: true,
      line: '## 0.5.0 - 2026-06-23',
    },
  ])
})

test('validateCliChangelog passes when the current version heading exists', () => {
  assert.deepEqual(validateCliChangelog('0.6.0', SAMPLE_CHANGELOG), [])
})

test('validateCliChangelog fails when the current version heading is missing', () => {
  const errors = validateCliChangelog('0.7.0', SAMPLE_CHANGELOG)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /missing a `## 0\.7\.0 - YYYY-MM-DD` heading/)
})

test('validateCliChangelog fails when the current version heading is duplicated', () => {
  const content = `${SAMPLE_CHANGELOG}
## 0.6.0 - 2026-07-12

- Duplicate heading
`
  const errors = validateCliChangelog('0.6.0', content)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /2 headings for version 0\.6\.0/)
})

test('validateCliChangelog fails when the heading date is not YYYY-MM-DD', () => {
  const content = `# Changelog

## 0.6.0 - 2026-7-11

- Bad date
`
  const errors = validateCliChangelog('0.6.0', content)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /does not match/)
})

test('validateCliChangelog fails on trailing characters after the date', () => {
  const content = `# Changelog

## 0.6.0 - 2026-07-11${' '}

- Trailing space
`
  const errors = validateCliChangelog('0.6.0', content)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /does not match/)
})

test('validateCliChangelog fails on duplicate headings for non-current versions', () => {
  const content = `# Changelog

## 0.6.0 - 2026-07-11

- Current

## 0.5.2 - 2026-07-09

- Older

## 0.5.2 - 2026-07-09

- Duplicate
`
  const errors = validateCliChangelog('0.6.0', content)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /2 headings for version 0\.5\.2/)
})

test('checkCliChangelogAtRoot passes against the repo files', () => {
  assert.deepEqual(checkCliChangelogAtRoot(), [])
})

const VALID_RELEASE = {
  packageJson: {
    name: '@artifactshare/cli',
    version: '1.2.3',
    repository: {
      url: 'git+https://github.com/artifactshare/artifactshare.git',
      directory: 'packages/cli',
    },
    publishConfig: { access: 'public' },
  },
  changelog: '## 1.2.3 - 2026-08-09\n\n- Release\n',
  reference: { package_version: '1.2.3' },
}

test('current CLI release inputs pass preflight', () => {
  assert.deepEqual(checkCliReleaseAtRoot(), [])
})

test('valid release metadata passes', () => {
  assert.deepEqual(validateCliRelease(VALID_RELEASE), [])
})

test('preflight reports provenance and generated-version drift together', () => {
  const errors = validateCliRelease({
    ...VALID_RELEASE,
    packageJson: {
      ...VALID_RELEASE.packageJson,
      repository: undefined,
    },
    reference: { package_version: '1.2.2' },
  })
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /repository\.url/)
  assert.match(errors.join('\n'), /repository\.directory/)
  assert.match(errors.join('\n'), /reference snapshot is for 1\.2\.2/)
})

test('preflight rejects non-release versions and missing changelog entries', () => {
  const errors = validateCliRelease({
    ...VALID_RELEASE,
    packageJson: { ...VALID_RELEASE.packageJson, version: '1.2.3-next.1' },
  })
  assert.match(errors.join('\n'), /exact x\.y\.z/)
  assert.match(errors.join('\n'), /missing a `## 1\.2\.3-next\.1/)
})

test('checkCliChangelogAtRoot fails when package version lacks a changelog heading', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'check-cli-changelog-'))
  const cliDir = join(tempRoot, 'packages/cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify({ version: '9.9.9' }, null, 2),
    'utf8',
  )
  writeFileSync(join(cliDir, 'CHANGELOG.md'), SAMPLE_CHANGELOG, 'utf8')

  const errors = checkCliChangelogAtRoot(pathToFileURL(`${tempRoot}/`))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /missing a `## 9\.9\.9 - YYYY-MM-DD` heading/)
})

test('can be imported without a script argv', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./scripts/check-cli-changelog.mjs').then(() => console.log('ok'))",
    ],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'ok')
  assert.equal(result.stderr, '')
})
