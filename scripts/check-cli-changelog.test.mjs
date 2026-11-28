import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  LOOSE_HEADING,
  VERSION_HEADING,
  checkCliChangelogAtRoot,
  findVersionHeadings,
  validateCliChangelog,
  validateCliRelease,
} from './check-cli-changelog.mjs'

const codeAndVersion = ({ code, version }) => ({ code, version })

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
  assert.deepEqual(
    validateCliChangelog('0.7.0', SAMPLE_CHANGELOG).map(codeAndVersion),
    [{ code: 'missing-heading', version: '0.7.0' }],
  )
})

test('validateCliChangelog fails when the current version heading is duplicated', () => {
  const content = `${SAMPLE_CHANGELOG}
## 0.6.0 - 2026-07-12

- Duplicate heading
`
  assert.deepEqual(
    validateCliChangelog('0.6.0', content).map(({ code, version, count }) => ({
      code,
      version,
      count,
    })),
    [{ code: 'duplicate-heading', version: '0.6.0', count: 2 }],
  )
})

test('validateCliChangelog fails when the heading date is not YYYY-MM-DD', () => {
  const content = `# Changelog

## 0.6.0 - 2026-7-11

- Bad date
`
  assert.deepEqual(validateCliChangelog('0.6.0', content).map(codeAndVersion), [
    { code: 'loose-heading', version: '0.6.0' },
  ])
})

test('validateCliChangelog fails on trailing characters after the date', () => {
  const content = `# Changelog

## 0.6.0 - 2026-07-11${' '}

- Trailing space
`
  assert.deepEqual(validateCliChangelog('0.6.0', content).map(codeAndVersion), [
    { code: 'loose-heading', version: '0.6.0' },
  ])
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
  assert.deepEqual(
    validateCliChangelog('0.6.0', content).map(({ code, version, count }) => ({
      code,
      version,
      count,
    })),
    [{ code: 'duplicate-heading', version: '0.5.2', count: 2 }],
  )
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
  assert.deepEqual(errors.map(codeAndVersion), [
    { code: 'repository-url', version: undefined },
    { code: 'repository-directory', version: undefined },
    { code: 'reference-version', version: '1.2.2' },
  ])
})

test('preflight rejects non-release versions and missing changelog entries', () => {
  const errors = validateCliRelease({
    ...VALID_RELEASE,
    packageJson: { ...VALID_RELEASE.packageJson, version: '1.2.3-next.1' },
  })
  assert.deepEqual(errors.map(codeAndVersion), [
    { code: 'package-version', version: undefined },
    { code: 'reference-version', version: '1.2.3' },
    { code: 'missing-heading', version: '1.2.3-next.1' },
  ])
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

  assert.deepEqual(
    checkCliChangelogAtRoot(pathToFileURL(`${tempRoot}/`)).map(codeAndVersion),
    [{ code: 'missing-heading', version: '9.9.9' }],
  )
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

test('the heading pattern is the CLI parser pattern, and the loose net covers it', () => {
  const parser = readFileSync(
    new URL('../packages/cli/src/changelog.ts', import.meta.url),
    'utf8',
  )
  assert.ok(parser.includes(`/${VERSION_HEADING.source}/`))
  const accepted = ['## 1.2.3 - 2026-06-01', '## 0.0.0-rc.1 - 2026-12-31']
  for (const line of accepted) {
    assert.ok(VERSION_HEADING.test(line), line)
    assert.ok(LOOSE_HEADING.test(line), line)
  }
  // Negative control: the loose net still reports a heading with a bad date.
  assert.equal(VERSION_HEADING.test('## 1.2.3 - June 2026'), false)
  assert.ok(LOOSE_HEADING.test('## 1.2.3 - June 2026'))
})
