import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUiFile, parseArgs, ready } from './pr-ready.mjs'

const head = 'a'.repeat(40)

/** Never the checkout's own ledger: a test that wrote there would discharge a
 * real deferral, which is the loss this record exists to prevent. */
const tempLedger = () => join(tmpdir(), `pr-ready-ledger-${randomUUID()}.json`)

function harness({
  remoteHead = head,
  draft = true,
  base = 'main',
  dirty = false,
  changedFiles = [],
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'topic\n'
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'git' && args[0] === 'status') return dirty ? ' M file' : ''
    if (file === 'git' && args[0] === 'diff') return changedFiles.join('\n')
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify([
        {
          number: 56,
          isDraft: draft,
          baseRefName: base,
          headRefName: 'topic',
          headRefOid: remoteHead,
        },
      ])
    return ''
  }
  return { calls, exec }
}

test('needs no reviewer SHA arguments', () => {
  assert.deepEqual(parseArgs([]), {
    deferred: [],
    deferredFile: undefined,
    dryRun: false,
    uiGateComplete: false,
    noDeferred: false,
  })
  assert.deepEqual(
    parseArgs(['--', '--dry-run', '--ui-gate-complete', '--no-deferred']),
    {
      deferred: [],
      deferredFile: undefined,
      dryRun: true,
      uiGateComplete: true,
      noDeferred: true,
    },
  )
  assert.deepEqual(parseArgs(['--deferred', 'aria label on the select']), {
    deferred: ['aria label on the select'],
    deferredFile: undefined,
    dryRun: false,
    uiGateComplete: false,
    noDeferred: false,
  })
  assert.throws(() => parseArgs(['--codex-go', head]), /Usage/u)
})

test('classifies user-visible web files without treating tests or API routes as UI', () => {
  for (const file of [
    'apps/web/app/components/button.tsx',
    'apps/web/app/components/app/landing-styles.ts',
    'apps/web/app/hooks/use-hydrated.ts',
    'apps/web/app/routes/pricing.tsx',
    'apps/web/app/routes/_home/+components/home-view.ts',
    'apps/web/app/app.css',
    'apps/web/app/lib/app-theme.ts',
    'apps/web/app/lib/markdown-render.ts',
    'apps/web/app/lib/mermaid-render.client.ts',
    'apps/web/app/i18n/ja.json',
    'apps/web/app/guides/workspace-owner.en.md',
    'apps/web/app/legal/privacy.ja.md',
    'apps/web/app/updates/entries/example.en.md',
    'apps/web/public/landing/hero.svg',
  ])
    assert.equal(isUiFile(file), true, file)

  for (const file of [
    'apps/web/app/components/button.test.tsx',
    'apps/web/app/components/catalog.test.ts',
    'apps/web/app/routes/api.artifacts.tsx',
    'apps/web/app/services/project.server.ts',
    'apps/web/app/lib/app-theme.server.ts',
    'packages/cli/src/index.ts',
  ])
    assert.equal(isUiFile(file), false, file)
})

test('blocks UI changes until capture and source-based critique are confirmed', () => {
  const h = harness({ changedFiles: ['apps/web/app/routes/pricing.tsx'] })
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, uiGateComplete: false },
        ledger: tempLedger(),
      }),
    (error) => {
      assert.match(
        error.message,
        /Every affected screen state and registered task has been captured at desktop and mobile/u,
      )
      assert.match(error.message, /relevant source/u)
      assert.match(error.message, /walkthrough evidence/u)
      assert.match(error.message, /task\/persona context/u)
      assert.match(error.message, /captures alone are not sufficient/u)
      assert.match(error.message, /recapture and repeat the critique/u)
      return true
    },
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('allows confirmed UI changes and does not gate non-UI changes', () => {
  for (const [changedFiles, uiGateComplete] of [
    [['apps/web/app/components/button.tsx'], true],
    [['packages/cli/src/index.ts'], false],
  ]) {
    const h = harness({ changedFiles })
    ready({
      exec: h.exec,
      parsed: { dryRun: false, uiGateComplete, deferred: [], noDeferred: true },
      ledger: tempLedger(),
    })
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      true,
    )
  }
})

test('checks required status then makes the pushed Draft ready', () => {
  const h = harness()
  assert.deepEqual(
    ready({
      exec: h.exec,
      parsed: { dryRun: false, deferred: [], noDeferred: true },
      ledger: tempLedger(),
    }),
    { number: 56, head, dryRun: false, deferred: 0 },
  )
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(
    commands.indexOf('gh pr checks 56 --required') <
      commands.indexOf('gh pr ready 56'),
  )
})

test('rejects dirty, stale, non-Draft, and wrong-base state before Ready', () => {
  for (const options of [
    { dirty: true },
    { remoteHead: 'b'.repeat(40) },
    { draft: false },
    { base: 'release' },
  ]) {
    const h = harness(options)
    assert.throws(() =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('does not attempt repository-specific rollback after Ready', () => {
  const h = harness()
  h.exec = (file, args) => {
    if (file === 'gh' && args[1] === 'ready') throw new Error('GitHub failed')
    return harness().exec(file, args)
  }
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
    /GitHub failed/u,
  )
})

test('a corrupt ledger leaves Ready unchanged rather than overwriting it', () => {
  const path = join(tmpdir(), `pr-ready-corrupt-${randomUUID()}.json`)
  writeFileSync(path, '{ truncated')
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: ['something'], noDeferred: false },
        ledger: path,
      }),
    /could not be read/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})
