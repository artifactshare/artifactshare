import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import {
  assertSafeCaptureOutput,
  createCaptureOutput,
  removeCaptureOutput,
  screenCaptureOutputDirectory,
  screenCaptureOutputRoot,
} from './screen-capture-output.mjs'
import {
  captureRetries,
  shouldRetryCapture,
  captureScreenImages,
  writeCaptureReviewOutput,
  fileName,
} from './screen-capture.mjs'

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'capture-output-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const primary = join(base, 'primary')
  mkdirSync(primary)
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(primary, ['init', '--quiet'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  ])
  return { base, primary, git }
}

test('primary and linked worktrees write to distinct deterministic roots outside each checkout', (t) => {
  const { base, primary, git } = fixture(t)
  const linked = join(base, 'linked')
  git(primary, ['worktree', 'add', '--quiet', '--detach', linked])
  const roots = [primary, linked].map((checkout) => {
    const run = (file, args) => {
      assert.equal(file, 'git')
      return git(checkout, args)
    }
    const root = screenCaptureOutputRoot(run)
    const gitDir = git(checkout, ['rev-parse', '--absolute-git-dir'])
    assert.equal(
      root,
      join(
        dirname(checkout),
        `.${basename(checkout)}-screen-captures`,
        createHash('sha256').update(gitDir).digest('hex'),
      ),
    )
    assert.equal(screenCaptureOutputRoot(run), root)
    assert.ok(relative(checkout, root).startsWith(`..${sep}`))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'capture.png'), 'capture')
    assert.equal(
      git(checkout, ['status', '--porcelain', '--untracked-files=all']),
      '',
    )
    return root
  })
  assert.notEqual(roots[0], roots[1])
})

test('legacy captures remain intact and ignored after updating the ignore rules', (t) => {
  const { primary, git } = fixture(t)
  copyFileSync(
    new URL('../.gitignore', import.meta.url),
    join(primary, '.gitignore'),
  )
  git(primary, ['add', '.gitignore'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'current ignore rules',
  ])
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    mkdirSync(join(primary, legacy))
    writeFileSync(join(primary, legacy, 'evidence.json'), 'legacy evidence')
  }
  const root = screenCaptureOutputRoot((_file, args) => git(primary, args))
  mkdirSync(join(root, 'new-label'), { recursive: true })
  writeFileSync(join(root, 'new-label', 'evidence.json'), 'new evidence')
  assert.equal(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    '',
  )
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    assert.equal(
      readFileSync(join(primary, legacy, 'evidence.json'), 'utf8'),
      'legacy evidence',
    )
    assert.equal(
      git(primary, ['check-ignore', `${legacy}/evidence.json`]),
      `${legacy}/evidence.json`,
    )
  }
  // Compatibility is restricted to the two old root-level directories.
  mkdirSync(join(primary, 'nested', 'screen-captures'), { recursive: true })
  writeFileSync(
    join(primary, 'nested', 'screen-captures', 'evidence.json'),
    'visible',
  )
  assert.match(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    /nested\/screen-captures\/evidence.json/,
  )
})

test('rejects a checkout at the filesystem root', () => {
  assert.throws(
    () =>
      screenCaptureOutputRoot((_file, args) =>
        args.includes('--show-toplevel') ? '/' : '/.git',
      ),
    /filesystem root/,
  )
})

test('preserves an explicitly injected screen capture output root', () => {
  assert.equal(
    screenCaptureOutputDirectory('before', '/tmp/explicit-captures'),
    join('/tmp/explicit-captures', 'before'),
  )
})

test('reads the retry budget from the environment', () => {
  assert.equal(captureRetries({}), 2)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '0' }), 0)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '3' }), 3)
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '-1' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: 'many' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '1e3' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '11' }))
})

test('retries only readiness timeouts within the budget', () => {
  const timeout = { kind: 'readiness_timeout' }
  assert.equal(shouldRetryCapture(timeout, 0, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 1, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 2, 2, true), false)
  assert.equal(shouldRetryCapture(timeout, 0, 0, true), false)
  assert.equal(shouldRetryCapture({ kind: 'navigation' }, 0, 2, true), false)
  // A readiness timeout after an interaction is the interaction's fault.
  assert.equal(shouldRetryCapture(timeout, 0, 2, false), false)
})

test('rejects output roots overlapping a registered worktree before removal or creation', async (t) => {
  const { base, primary, git } = fixture(t)
  mkdirSync(join(primary, 'docs'))
  writeFileSync(join(primary, 'docs', 'tracked.txt'), 'preserve')
  git(primary, ['add', 'docs'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'tracked fixture',
  ])
  const run = (_file, args) => git(primary, args)
  const root = screenCaptureOutputRoot(run)
  assert.doesNotThrow(() => assertSafeCaptureOutput([root], run))
  // Register the collision after resolving/preflighting the deterministic root.
  git(primary, ['worktree', 'add', '--quiet', '--detach', root])
  const alias = join(base, 'alias')
  symlinkSync(root, alias)
  for (const candidate of [
    root,
    dirname(root),
    join(root, 'docs'),
    alias,
    primary,
  ]) {
    const target = join(candidate, 'docs')
    await assert.rejects(
      removeCaptureOutput(candidate, target, run),
      /overlaps a registered worktree/,
    )
    await assert.rejects(
      createCaptureOutput(candidate, join(candidate, 'new-output'), run),
      /overlaps a registered worktree/,
    )
  }
  // A cleanup target can independently alias a worktree under a safe root.
  const safeRoot = join(base, 'safe-output')
  mkdirSync(safeRoot)
  const cleanupAlias = join(safeRoot, 'docs')
  symlinkSync(root, cleanupAlias)
  await assert.rejects(
    removeCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  await assert.rejects(
    createCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  assert.equal(
    readFileSync(join(root, 'docs', 'tracked.txt'), 'utf8'),
    'preserve',
  )
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(git(primary, ['status', '--porcelain']), '')
  // Explicit external injection and label-scoped replacement still work.
  await createCaptureOutput(safeRoot, join(safeRoot, 'before'), run)
  writeFileSync(join(safeRoot, 'before', 'keep.txt'), 'keep')
  await createCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  await removeCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  assert.equal(
    readFileSync(join(safeRoot, 'before', 'keep.txt'), 'utf8'),
    'keep',
  )
})

function sectionPage({ height = 900, targets = {}, failFull = false } = {}) {
  const shots = []
  const queries = []
  return {
    shots,
    queries,
    viewportSize: () => ({ width: 1440, height }),
    evaluate: (fn) => {
      // Exercise the actual browser callback with a scrolled viewport.
      const previous = globalThis.window
      globalThis.window = { scrollX: 5, scrollY: 1200 }
      try {
        return fn()
      } finally {
        if (previous === undefined) delete globalThis.window
        else globalThis.window = previous
      }
    },
    locator: (selector) => {
      queries.push(selector)
      const target = targets[selector] ?? {}
      return {
        count: () => target.count ?? 1,
        isVisible: () => target.visible ?? true,
        boundingBox: () =>
          target.box ?? { x: 20, y: 3800, width: 320, height: 4000 },
      }
    },
    screenshot: (options) => {
      shots.push(options)
      if (failFull && !options.clip) throw new Error('full-page failed')
    },
  }
}

function captureEntry(viewport = 'desktop', theme = 'light', locale = 'en') {
  return {
    status: 'success',
    screen: 'guides-cli',
    state: 'default',
    viewport,
    theme,
    locale,
    file: fileName(
      { id: 'guides-cli' },
      { id: 'default' },
      viewport,
      theme,
      locale,
    ),
    url: `https://localhost/${locale}/guides/cli?theme=${theme}`,
    head: 'a'.repeat(40),
    attempts: 2,
  }
}

test('captures full-page then four bounded crops for all eight guide combinations', async () => {
  const sections = ['introduction', 'basics', 'commands', 'recovery'].map(
    (id) => ({ id, selector: `#${id}` }),
  )
  const manifest = []
  for (const [viewport, height] of [
    ['desktop', 900],
    ['mobile', 844],
  ])
    for (const theme of ['light', 'dark'])
      for (const locale of ['en', 'ja']) {
        const page = sectionPage({
          height,
          targets: {
            '#introduction': {
              box: { x: 20, y: -1000, width: 320, height: 400 },
            },
          },
        })
        let audits = 0
        const gapAudit = { result: 'passed', findings: [] }
        const entry = captureEntry(viewport, theme, locale)
        const entries = await captureScreenImages({
          page,
          entry,
          sections,
          outDir: '/tmp/crops',
          afterFullCapture: () => {
            audits++
            return { gapAudit }
          },
        })
        assert.equal(audits, 1)
        assert.deepEqual(entries[0], { ...entry, gapAudit })
        assert.deepEqual(page.shots[0], {
          path: join('/tmp/crops', entry.file),
          fullPage: true,
        })
        assert.deepEqual(
          page.queries,
          sections.map((section) => section.selector),
        )
        assert.equal(page.shots.length, 5)
        for (const [index, section] of sections.entries()) {
          const file = `guides-cli--default--${viewport}--${theme}--${locale}--section-${section.id}.png`
          assert.deepEqual(entries[index + 1], {
            ...entry,
            gapAudit,
            file,
            section: section.id,
          })
          assert.deepEqual(page.shots[index + 1], {
            path: join('/tmp/crops', file),
            fullPage: true,
            clip: {
              x: 25,
              y: index === 0 ? 200 : 5000,
              width: 320,
              height: index === 0 ? 400 : height * 2,
            },
          })
        }
        manifest.push(...entries)
      }
  assert.equal(
    manifest.filter((entry) => entry.section === undefined).length,
    8,
  )
  assert.equal(
    manifest.filter((entry) => entry.section !== undefined).length,
    32,
  )
})

for (const [reason, target] of [
  ['found 0', { count: 0 }],
  ['found 2', { count: 2 }],
  ['invisible', { visible: false }],
  ['positive-area', { box: { x: 0, y: 0, width: 0, height: 20 } }],
]) {
  test(`section failure (${reason}) preserves full-page and subsequent crops without retry`, async () => {
    const page = sectionPage({ targets: { '#missing': target } })
    const messages = []
    const entries = await captureScreenImages({
      page,
      entry: captureEntry(),
      outDir: '/tmp/crops',
      sections: [
        { id: 'missing', selector: '#missing' },
        { id: 'recovery', selector: '#recovery' },
      ],
      reportFailure: (message) => messages.push(message),
    })
    assert.deepEqual(
      entries.map((entry) => [entry.section, entry.status]),
      [
        [undefined, 'success'],
        ['missing', 'failed'],
        ['recovery', 'success'],
      ],
    )
    assert.equal(entries[1].file, undefined)
    assert.equal(entries[1].failure.selector, '#missing')
    assert.equal(entries[1].failure.condition, 'section: missing')
    assert.match(entries[1].failure.message, new RegExp(reason))
    assert.match(
      messages[0],
      /guides-cli\/default\/desktop\/light\/en\/section-missing/,
    )
    assert.equal(shouldRetryCapture(entries[1].failure, 0, 2, true), false)
    assert.equal(page.shots.length, 2)
  })
}

test('omitted and empty sections preserve full-page calls and manifest shape', async () => {
  for (const sections of [undefined, []]) {
    const page = sectionPage()
    const entry = captureEntry()
    assert.deepEqual(
      await captureScreenImages({
        page,
        entry,
        sections,
        outDir: '/tmp/crops',
      }),
      [entry],
    )
    assert.deepEqual(page.queries, [])
    assert.deepEqual(page.shots, [
      { path: join('/tmp/crops', entry.file), fullPage: true },
    ])
  }
})

test('full-page failure never attempts sections', async () => {
  const page = sectionPage({ failFull: true })
  await assert.rejects(
    captureScreenImages({
      page,
      entry: captureEntry(),
      outDir: '/tmp/crops',
      sections: [{ id: 'intro', selector: '#intro' }],
    }),
    /full-page failed/,
  )
  assert.deepEqual(page.queries, [])
  assert.equal(page.shots.length, 1)
})

test('review output preserves ordered section failures, stamps HEAD and fails after writing', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'section-output-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const entries = await captureScreenImages({
    page: sectionPage({ targets: { '#missing': { count: 0 } } }),
    entry: { ...captureEntry(), order: 0 },
    outDir,
    sections: [
      { id: 'missing', selector: '#missing' },
      { id: 'recovery', selector: '#recovery' },
    ],
    reportFailure: () => {},
  })
  const later = { ...captureEntry('mobile'), order: 1 }
  const head = 'b'.repeat(40)
  await assert.rejects(
    writeCaptureReviewOutput({
      manifest: [later, ...entries],
      head,
      selected: [{ id: 'guides-cli' }],
      outDir,
      label: 'sections',
    }),
    /1 capture\(s\) failed/,
  )
  const manifest = JSON.parse(
    readFileSync(join(outDir, 'manifest.json'), 'utf8'),
  )
  assert.deepEqual(
    manifest.map((entry) => [entry.viewport, entry.section, entry.status]),
    [
      ['desktop', undefined, 'success'],
      ['desktop', 'missing', 'failed'],
      ['desktop', 'recovery', 'success'],
      ['mobile', undefined, 'success'],
    ],
  )
  for (const entry of manifest) {
    assert.equal(entry.head, head)
    assert.equal(Object.hasOwn(entry, 'order'), false)
  }
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  assert.match(html, /section: missing · failed: section_capture_failure/)
  assert.match(html, /section: recovery/)
  assert.ok(html.includes(entries[0].file))
  assert.ok(html.includes(entries[2].file))
})
