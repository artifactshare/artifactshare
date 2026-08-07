import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { scan } from './public-export-scan.mjs'

const temp = (name) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `public-scan-${name}-`))
const receiptEntry = (directory, relative) => ({
  path: relative,
  sha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(directory, relative)))
    .digest('hex'),
})
const writeReceipt = (directory, files) =>
  fs.writeFileSync(
    path.join(directory, 'PUBLIC-EXPORT-RECEIPT.json'),
    JSON.stringify({
      manifest_version: '3',
      files: files.map((file) => receiptEntry(directory, file)),
    }),
  )

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
  writeReceipt(directory, [])
  execFileSync(
    'git',
    ['add', 'apps/build/tracked.txt', 'PUBLIC-EXPORT-RECEIPT.json'],
    {
      cwd: directory,
    },
  )
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

test('uses export receipt inside an enclosing git worktree', () => {
  const repo = temp('enclosing-repo')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const directory = path.join(repo, 'untracked-export')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'AKIA1234567890ABCDEF')
  writeReceipt(directory, ['fixture.txt'])
  assert.equal(scan(directory).length, 1)
})

test('verifies the receipt when an enclosing worktree tracks the export path', () => {
  const repo = temp('tracked-enclosing-repo')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const directory = path.join(repo, 'export')
  fs.mkdirSync(directory)
  const fixture = path.join(directory, 'fixture.txt')
  fs.writeFileSync(fixture, 'before')
  writeReceipt(directory, ['fixture.txt'])
  execFileSync('git', ['add', 'export'], { cwd: repo })
  fs.writeFileSync(fixture, 'after')
  assert.throws(() => scan(directory), /sha256 mismatch: fixture\.txt/)
})

test('rejects files absent from a fresh export receipt', () => {
  const directory = temp('unexpected-file')
  fs.writeFileSync(path.join(directory, 'unexpected.txt'), 'not in receipt')
  writeReceipt(directory, [])
  assert.throws(() => scan(directory), /absent from receipt/)
})

test('rejects symlinks absent from a fresh export receipt', () => {
  const directory = temp('unexpected-symlink')
  fs.symlinkSync('missing.txt', path.join(directory, 'unexpected.txt'))
  writeReceipt(directory, [])
  assert.throws(() => scan(directory), /unexpected\.txt/)
})

test('ignores generated type artifacts absent from a fresh export receipt', () => {
  const directory = temp('generated-types')
  fs.mkdirSync(path.join(directory, 'apps', 'web'), { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'apps', 'web', 'tsconfig.tsbuildinfo'),
    '',
  )
  fs.writeFileSync(
    path.join(directory, 'apps', 'web', 'worker-configuration.d.ts'),
    '',
  )
  writeReceipt(directory, [])
  assert.deepEqual(scan(directory), [])
})

test('ignores documented local outputs absent from a fresh export receipt', () => {
  const directory = temp('local-outputs')
  for (const relative of [
    '.DS_Store',
    'apps/web/.vitest-attachments/result.json',
    'apps/web/__screenshots__/result.png',
  ]) {
    const file = path.join(directory, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  }
  writeReceipt(directory, [])
  assert.deepEqual(scan(directory), [])
})

test('rejects local secret files absent from a fresh export receipt', () => {
  for (const relative of [
    '.env',
    '.dev.vars',
    '.dev.vars.local',
    '.secrets.local',
  ]) {
    const directory = temp('local-secret')
    fs.writeFileSync(path.join(directory, relative), 'sk_live_not_public')
    writeReceipt(directory, [])
    assert.throws(() => scan(directory), /absent from receipt/)
  }
})

test('does not ignore similarly named source files absent from receipt', () => {
  const directory = temp('generated-types-near-miss')
  fs.writeFileSync(path.join(directory, 'worker-configuration.ts'), '')
  writeReceipt(directory, [])
  assert.throws(() => scan(directory), /worker-configuration\.ts/)
})

test('rejects a receipt file modified after export', () => {
  const directory = temp('modified-receipt-file')
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'before')
  writeReceipt(directory, ['fixture.txt'])
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'after')
  assert.throws(() => scan(directory), /sha256 mismatch: fixture\.txt/)
})

test('rejects a receipt file removed after export', () => {
  const directory = temp('missing-receipt-file')
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'before')
  writeReceipt(directory, ['fixture.txt'])
  fs.unlinkSync(path.join(directory, 'fixture.txt'))
  assert.throws(() => scan(directory), /file missing: fixture\.txt/)
})

test('rejects malformed receipt paths, hashes, and duplicates', () => {
  for (const [name, files, pattern] of [
    [
      'path',
      [{ path: '../fixture.txt', sha256: '0'.repeat(64) }],
      /invalid export receipt path/,
    ],
    [
      'hash',
      [{ path: 'fixture.txt', sha256: 'invalid' }],
      /invalid export receipt sha256/,
    ],
    [
      'duplicate',
      [
        { path: 'fixture.txt', sha256: '0'.repeat(64) },
        { path: 'fixture.txt', sha256: '0'.repeat(64) },
      ],
      /duplicate export receipt path/,
    ],
  ]) {
    const directory = temp(`invalid-${name}`)
    fs.writeFileSync(
      path.join(directory, 'PUBLIC-EXPORT-RECEIPT.json'),
      JSON.stringify({ manifest_version: '3', files }),
    )
    assert.throws(() => scan(directory), pattern)
  }
})

test('rejects a receipt from another manifest version', () => {
  const directory = temp('manifest-version')
  fs.writeFileSync(
    path.join(directory, 'PUBLIC-EXPORT-RECEIPT.json'),
    JSON.stringify({ manifest_version: '2', files: [] }),
  )
  assert.throws(() => scan(directory), /manifest version mismatch/)
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
  writeReceipt(directory, [source, fixture])
  const findings = scan(directory).filter(
    (finding) => finding.category === 'private-reference',
  )
  assert.deepEqual(
    findings.map((finding) => finding.path),
    [source, fixture],
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
  writeReceipt(directory, [relative])
  assert.ok(
    scan(directory).some((finding) => finding.category === 'private-reference'),
  )
})
