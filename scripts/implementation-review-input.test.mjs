import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertImplementationContext,
  dispositionsContract,
  implementationReviewInstructions,
  readImplementationContext,
  reviewContract,
} from './implementation-review-input.mjs'

test('requires a Dispositions section in the review context', () => {
  assert.throws(
    () => assertImplementationContext('# Purpose\n\nShip it.'),
    /Dispositions/u,
  )
  assert.throws(() => assertImplementationContext('   \n'), /nonempty/u)
  for (const heading of [
    '## Dispositions',
    '### First coordinated review (commit abc) dispositions',
    '## Disposition',
  ]) {
    const context = `# Purpose\n\n${heading}\n\nNone yet\n`
    assert.equal(assertImplementationContext(context), context)
  }
})

test('reads a context file through the same check', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-context-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const valid = join(dir, 'valid.md')
  writeFileSync(valid, '# Purpose\n\n## Dispositions\n\nNone yet\n')
  assert.match(readImplementationContext(valid), /None yet/u)
  const invalid = join(dir, 'invalid.md')
  writeFileSync(invalid, '# Purpose only\n')
  assert.throws(() => readImplementationContext(invalid), /Dispositions/u)
  assert.equal(readImplementationContext(''), '')
})

test('tells reviewers not to re-raise dispositioned findings when a context carries them', () => {
  assert.doesNotMatch(reviewContract, /Dispositions section/u)
  const text = implementationReviewInstructions({
    context: '## Dispositions\n\nNone yet',
    base: 'b',
    expectedHead: 'h',
  })
  assert.match(text, /Do not re-raise a dispositioned finding/u)
  assert.match(text, /unless you supply a new failure scenario/u)
  assert.match(text, /CURRENT CHANGE CONTEXT/u)
  assert.ok(text.includes(dispositionsContract))
  assert.match(text, /reversal of a previous round's accepted fix/u)
  for (const context of ['', '# Purpose only\n\nno section']) {
    const withoutSection = implementationReviewInstructions({
      context,
      base: 'b',
      expectedHead: 'h',
    })
    assert.ok(!withoutSection.includes(dispositionsContract))
  }
})
