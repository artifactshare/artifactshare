import { describe, expect, test } from 'vitest'
import type { CspViolationMessage } from '~/lib/csp-reporter'
import { retainCspViolation } from './csp-violation-retention'

const origin = 'https://sandbox.example.com'
const report = (
  sourceFile: string | null,
  sample: string,
): CspViolationMessage => ({
  source: 'artifactshare',
  kind: 'csp-violation',
  directive: 'script-src',
  blockedURI: 'eval',
  sourceFile,
  lineNumber: 1,
  sample,
})

describe('retainCspViolation', () => {
  test('environment floods preserve same-origin and pending CDN reports', () => {
    const inline = report(origin, 'inline')
    const cdn = report('https://cdn.jsdelivr.net/app.js', 'cdn')
    let entries = [inline, cdn]
    for (let index = 0; index < 200; index++) {
      entries = retainCspViolation(
        entries,
        report(null, `noise-${index}`),
        origin,
        null,
      )
    }
    expect(entries).toHaveLength(102)
    expect(entries).toContain(inline)
    expect(entries).toContain(cdn)
    expect(entries[2]?.sample).toBe('noise-100')
    expect(entries.at(-1)?.sample).toBe('noise-199')
  })

  test('bounds both groups independently and preserves arrival order', () => {
    let entries: CspViolationMessage[] = []
    for (let index = 0; index < 200; index++) {
      entries = retainCspViolation(
        entries,
        report(origin, `artifact-${index}`),
        origin,
        null,
      )
      entries = retainCspViolation(
        entries,
        report(null, `environment-${index}`),
        origin,
        null,
      )
    }
    expect(entries).toHaveLength(200)
    expect(entries.slice(0, 2).map((entry) => entry.sample)).toEqual([
      'artifact-100',
      'environment-100',
    ])
    expect(entries.slice(-2).map((entry) => entry.sample)).toEqual([
      'artifact-199',
      'environment-199',
    ])
  })

  test.each(['markdown', null])(
    'CDN noise cannot evict an inline report when the initial type is %s',
    (initialType) => {
      const inline = report(origin, 'inline')
      let entries = [inline]
      for (let index = 0; index < 200; index++) {
        entries = retainCspViolation(
          entries,
          report('https://cdn.jsdelivr.net/app.js', `cdn-${index}`),
          origin,
          initialType,
        )
      }
      expect(entries).toContain(inline)
      expect(entries).toHaveLength(101)
      // Pending sources become environment diagnostics once Markdown is known.
      entries = retainCspViolation(
        entries,
        report(null, 'environment'),
        origin,
        'markdown',
      )
      expect(entries).toContain(inline)
      expect(entries).toHaveLength(101)
      expect(entries.at(-1)?.sample).toBe('environment')
    },
  )
})
