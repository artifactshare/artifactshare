import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { scan } from './public-repository-scan.mjs'

const temp = (name) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `public-scan-${name}-`))
const writeReceipt = (directory, files) =>
  execFileSync('git', ['add', '--', ...files], { cwd: directory })

function init(directory) {
  execFileSync('git', ['init', '-q'], { cwd: directory })
}

for (const [category, value, relative = 'fixture.txt'] of [
  ['credential', 'AKIA1234567890ABCDEF'],
  ['credential', 'rk_live_1234567890abcdef'],
  ['credential', 'whsec_1234567890abcdef'],
  ['credential', 'GOCSPX-1234567890abcdef'],
  ['credential', 'CLOUDFLARE_API_TOKEN=1234567890abcdef'],
  ['personal-data', 'person@customer.invalid'],
  ['private-network', '10.1.2.3'],
  ['private-reference', 'docs/operations/runbook.md'],
  ['private-reference', 'packages/cli/CLAUDE.md'],
  ['private-reference', 'issue context #1462'],
  ['production-resource', 'prod-d1-ABC12345'],
  ['production-resource', 'G-SCANNER01'],
  ['production-resource', 'price_1ScannerFixture000'],
  [
    'production-resource',
    '"database_id": "12345678-1234-4abc-8abc-123456789abc"',
  ],
  [
    'public-ci-reachability',
    'secrets.DEPLOY_TOKEN',
    '.github/workflows/ci.yml',
  ],
])
  test(`detects ${category}`, () => {
    const directory = temp(category)
    const file = path.join(directory, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    init(directory)
    writeReceipt(directory, [relative])
    assert.ok(scan(directory).some((finding) => finding.category === category))
  })

test('uses git tracked files for generated directory names', () => {
  const directory = temp('tracked-generated')
  execFileSync('git', ['init', '-q'], { cwd: directory })
  const generated = path.join(directory, 'apps', 'build')
  fs.mkdirSync(generated, { recursive: true })
  fs.writeFileSync(path.join(generated, 'tracked.txt'), 'AKIA1234567890ABCDEF')
  fs.writeFileSync(
    path.join(generated, 'untracked.txt'),
    'AKIA1234567890ABCDEG',
  )
  execFileSync('git', ['add', 'apps/build/tracked.txt'], { cwd: directory })
  assert.equal(
    scan(directory).filter((finding) => finding.category === 'credential')
      .length,
    1,
  )
})

test('rejects a tracked symlink in git-worktree mode', () => {
  const directory = temp('tracked-symlink')
  execFileSync('git', ['init', '-q'], { cwd: directory })
  fs.symlinkSync('missing.txt', path.join(directory, 'link.txt'))
  execFileSync('git', ['add', 'link.txt'], { cwd: directory })
  assert.throws(() => scan(directory), /tracked scan file is not regular/)
})

test('detects a private decision reference outside public reference docs', () => {
  const directory = temp('private-decision-reference')
  const relative = 'apps/web/app/source.ts'
  fs.mkdirSync(path.dirname(path.join(directory, relative)), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(directory, relative),
    '// See docs/decisions/private.md',
  )
  init(directory)
  writeReceipt(directory, [relative])
  assert.ok(
    scan(directory).some((finding) => finding.category === 'private-reference'),
  )
})

test('does not blanket-allow artifact URLs in automated tests', () => {
  const directory = temp('synthetic-artifact-url')
  const source = 'apps/web/app/source.ts'
  const fixture = 'apps/web/app/source.test.ts'
  fs.mkdirSync(path.dirname(path.join(directory, source)), { recursive: true })
  fs.writeFileSync(
    path.join(directory, source),
    'https://artifactshare.com/a/sensitive-spec',
  )
  fs.writeFileSync(
    path.join(directory, fixture),
    'https://artifactshare.com/a/customer-spec',
  )
  init(directory)
  writeReceipt(directory, [source, fixture])
  const findings = scan(directory).filter(
    (finding) => finding.category === 'private-reference',
  )
  assert.deepEqual(
    findings.map((finding) => finding.path).sort(),
    [source, fixture].sort(),
  )
})

test('allows only the permanent demos in the Markdown viewer announcement', () => {
  const directory = temp('markdown-viewer-demos')
  const artifactUrl = (id) => `https://artifactshare.com/${'a'}/${id}`
  const english =
    'apps/web/app/updates/entries/2026-08-14-markdown-viewer.en.md'
  const japanese =
    'apps/web/app/updates/entries/2026-08-14-markdown-viewer.ja.md'
  fs.mkdirSync(path.dirname(path.join(directory, english)), { recursive: true })
  fs.writeFileSync(path.join(directory, english), artifactUrl('p1vn8dm6kr'))
  fs.writeFileSync(
    path.join(directory, japanese),
    [artifactUrl('mhck26ttxt'), artifactUrl('unapproved-demo')].join('\n'),
  )
  init(directory)
  writeReceipt(directory, [english, japanese])
  assert.deepEqual(
    scan(directory)
      .filter((finding) => finding.category === 'private-reference')
      .map((finding) => finding.path),
    [japanese],
  )
})

test('does not allow real email domains or synthetic-looking artifact prefixes', () => {
  const directory = temp('allowlist-near-misses')
  const relative = 'apps/web/app/source.test.ts'
  const file = path.join(directory, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'scanner-negative-control@gmail.com',
      'ceo@acme.test.com',
      'https://artifactshare.com/a/md3k9x2p1q',
    ].join('\n'),
  )
  init(directory)
  writeReceipt(directory, [relative])
  assert.deepEqual(
    scan(directory).map((finding) => finding.category),
    ['personal-data', 'personal-data', 'private-reference'],
  )
})

test('public reference allowlist requires the complete matched path', () => {
  const directory = temp('public-reference-prefix')
  const relative = 'apps/web/app/source.ts'
  fs.mkdirSync(path.dirname(path.join(directory, relative)), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(directory, relative),
    'docs/reference/glossary.md.internal',
  )
  init(directory)
  writeReceipt(directory, [relative])
  assert.ok(
    scan(directory).some((finding) => finding.category === 'private-reference'),
  )
})
