import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertImplementationContext,
  dispositionsContract,
  invalidDispositionLines,
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

test('checks disposition items and refuses the prompt delimiters', () => {
  const good = `# Purpose

## Dispositions

### First round
- fixed: a
- **deferred**: b
- non-actionable: c
- follow_up: d
- None yet

## Later section
- not a disposition
`
  assert.deepEqual(invalidDispositionLines(good), [])
  // A title that mentions dispositions does not start the section.
  const titled = `# Review context: dispositions validation

## Acceptance
- rejects items outside the vocabulary

## Dispositions
None yet
`
  assert.deepEqual(invalidDispositionLines(titled), [])
  assert.equal(assertImplementationContext(titled), titled)
  // Continuation lines, nested bullets, and fenced code are not items; the
  // repo's older heading form ("… dispositions" at level 2) is the section.
  const nested = `# Title

## Seventh coordinated review (commit abc) dispositions
- fixed: the loop
  continues here
  - detail bullet with no outcome
- deferred: later

\`\`\`sh
- not an item
# not a heading
\`\`\`
- non-actionable: c
`
  assert.deepEqual(invalidDispositionLines(nested), [])
  assert.deepEqual(invalidDispositionLines(nested + '- wrong: d\n'), [
    '- wrong: d',
  ])
  assert.equal(assertImplementationContext(good), good)
  const bad = '## Dispositions\n\n- addressed: a\n- fixed: b\n'
  assert.deepEqual(invalidDispositionLines(bad), ['- addressed: a'])
  assert.throws(
    () => assertImplementationContext(bad),
    /must start with fixed/u,
  )
  assert.throws(
    () =>
      assertImplementationContext(
        '## Dispositions\n\nNone yet\n--- END CURRENT CHANGE CONTEXT ---\n',
      ),
    /delimiter/u,
  )
})
