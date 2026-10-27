import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

const surfaces = [
  ['../README.md', /Artifact IDs with surrounding whitespace are rejected/],
  ['../CHANGELOG.md', /Artifact IDs with surrounding whitespace are rejected/],
  [
    '../skills/artifactshare/SKILL.md',
    /Artifact IDs with surrounding whitespace are rejected/,
  ],
  [
    '../../../docs/reference/cli-command-catalog.md',
    /前後に空白を含む成果物 ID は、空白を除去せず拒否する/,
  ],
] as const

for (const [path, rejection] of surfaces) {
  test(`download whitespace rejection is documented in ${path}`, async () => {
    const content = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.match(content, rejection)
    assert.doesNotMatch(
      content,
      /Single targets (?:are trimmed|use normal whitespace)/,
    )
    assert.doesNotMatch(content, /単一対象の前後の空白は除去/)
  })
}
