import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { loadBoundaryManifest } from './public-development-guard.mjs'

test('content-origin decision records cookie support and the rejected path capability', () => {
  const decisionPaths = loadBoundaryManifest().canonical.filter((file) =>
    file.endsWith('/link-share-domain.md'),
  )
  assert.equal(
    decisionPaths.length,
    1,
    'Expected one public content-origin decision',
  )
  const decision = fs
    .readFileSync(decisionPaths[0], 'utf8')
    .replace(/\s+/gu, ' ')
  for (const policy of [
    'Chromium with third-party cookie restriction',
    'Safari 26.2 or later (and 18.4)',
    'Safari 18.5 through 26.1',
    'cross-site cookies show the explanation page for private static sites',
    'The automated suite detects partitioned-cookie support per engine',
    'Firefox default Total Cookie Protection',
    'network.cookie.cookieBehavior=5',
    'network.cookie.cookieBehavior=1',
    'unsupported for private static sites',
  ]) {
    assert.ok(decision.includes(policy), `Missing cookie policy: ${policy}`)
  }
  assert.doesNotMatch(decision, /WebKit\/Safari ITP/u)
  assert.match(
    decision,
    /ordinary parent-domain cookies and inflate sibling request headers/u,
  )
  assert.match(decision, /availability-only risk is accepted/u)
  assert.match(
    decision,
    /host-prefixed authority cookies keep authority isolated/u,
  )
  assert.match(
    decision,
    /No Public Suffix List submission is planned for `artifactshareusercontent\.com`/u,
  )
  assert.doesNotMatch(decision, /submission is a follow-up/u)
  assert.doesNotMatch(decision, /the owner chose/iu)
  assert.match(decision, /URL-path capabilities are rejected/u)
  assert.match(decision, /pathname-based SPA routing/u)
  assert.match(decision, /import maps/u)
  assert.match(decision, /Subresource Integrity \(SRI\)/u)
})
