import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import {
  CLI_UPDATES_URL,
  changelogDataFromContent,
  extractChangelogSection,
} from './changelog.js'
import { expectSuccess, run } from './test/helpers.js'

test('extractChangelogSection returns the matching version section body', () => {
  const content = `# Changelog

## 0.6.0 - 2026-07-11

- Cursor user-scope skills

## 0.5.0 - 2026-06-23

- logout command
`

  assert.deepEqual(extractChangelogSection(content, '0.6.0'), {
    version: '0.6.0',
    date: '2026-07-11',
    body: '- Cursor user-scope skills',
  })
})

test('extractChangelogSection stops at the next heading', () => {
  const content = `## 0.6.0 - 2026-07-11

- first bullet
- second bullet

## 0.5.0 - 2026-06-23

- later release
`

  assert.equal(
    extractChangelogSection(content, '0.6.0')?.body,
    '- first bullet\n- second bullet',
  )
})

test('extractChangelogSection uses the first duplicate heading', () => {
  const content = `## 0.6.0 - 2026-07-11

- first section

## 0.6.0 - 2026-07-12

- duplicate section
`

  assert.equal(
    extractChangelogSection(content, '0.6.0')?.body,
    '- first section',
  )
})

test('extractChangelogSection returns null when the version is missing', () => {
  const content = `## 0.5.0 - 2026-06-23

- logout command
`

  assert.equal(extractChangelogSection(content, '0.6.0'), null)
})

test('extractChangelogSection trims leading and trailing blank lines', () => {
  const content = `## 0.6.0 - 2026-07-11


- spaced bullet


## 0.5.0 - 2026-06-23
`

  assert.equal(
    extractChangelogSection(content, '0.6.0')?.body,
    '- spaced bullet',
  )
})

test('changelogDataFromContent returns latest null when changelog content is missing', () => {
  assert.deepEqual(changelogDataFromContent('0.6.0', null), {
    version: '0.6.0',
    updates_url: CLI_UPDATES_URL,
    latest: null,
  })
})

test('changelogDataFromContent returns latest null when the version section is missing', () => {
  const content = `## 0.5.0 - 2026-06-23

- logout command
`

  assert.deepEqual(changelogDataFromContent('0.6.0', content), {
    version: '0.6.0',
    updates_url: CLI_UPDATES_URL,
    latest: null,
  })
})

test('changelog --json returns version, updates_url, and latest section', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }

  const result = run(['changelog', '--json'])
  const payload = expectSuccess(result, 'changelog')

  assert.equal(payload.data.version, pkg.version)
  assert.equal(payload.data.updates_url, CLI_UPDATES_URL)
  assert.deepEqual(payload.data.latest, {
    version: pkg.version,
    date: '2026-08-08',
    body: '- Publish the first npm release covered by the Artifact Share source-available license.',
  })
})

test('changelog exits 0 with version and URL when the current section is missing', () => {
  const result = run(['changelog', '--json'])
  const payload = expectSuccess(result, 'changelog')

  assert.equal(typeof payload.data.version, 'string')
  assert.equal(payload.data.updates_url, CLI_UPDATES_URL)
  assert.ok(
    payload.data.latest === null || typeof payload.data.latest === 'object',
  )
})
