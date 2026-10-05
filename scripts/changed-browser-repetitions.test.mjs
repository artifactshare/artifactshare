import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  main,
  selectFiles,
  selectChanges,
  validateRepetitions,
  buildPlan,
  discoverProjects,
  runPlan,
  summarize,
} from './ci/changed-browser-repetitions.mjs'

const file = 'apps/web/app/routes/a.$id/example.behavior.browser.test.tsx'
const anchor = 'apps/web/app/lib/example-anchor.behavior.browser.test.tsx'
const selected = (files = [file]) => ({
  selected: files,
  total: files.length,
  omitted: [],
  head: 'abc123def4',
})
const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-browser-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const fixtureDiscovery = (specifications) => () => ({
  specifications: (filters = []) =>
    specifications.filter(
      (spec) => !filters.length || spec.file.includes(filters[0]),
    ),
  close: async () => {},
})
const passing = (pair) => ({
  schemaVersion: 1,
  reason: 'passed',
  unhandledErrors: [],
  modules: [
    {
      moduleId: pair.file,
      project: pair.project,
      state: 'passed',
      errors: [],
      suites: [],
      tests: [{ namePath: ['example'], state: 'passed', errors: [] }],
    },
  ],
})

test('selects only added/modified literal paths from NUL records, sorted and capped', () => {
  const unusual = 'apps/web/app/a $;`|\n.behavior.browser.test.tsx'
  const diff = [
    'M',
    file,
    'A',
    anchor,
    'M',
    file,
    'A',
    unusual,
    'D',
    file,
    'R075',
    anchor,
    'apps/web/app/renamed.behavior.browser.test.tsx',
    'R100',
    file,
    'apps/web/app/moved.behavior.browser.test.tsx',
    'C100',
    file,
    'apps/web/app/copied.behavior.browser.test.tsx',
    'A',
    'other/app/example.behavior.browser.test.tsx',
    'M',
    'apps/web/app/example.test.tsx',
    'T',
    file,
    '',
  ].join('\0')
  assert.deepEqual(selectFiles(diff), {
    total: 3,
    selected: [file, anchor, unusual].sort(),
    omitted: [],
  })
  assert.deepEqual(selectFiles(''), { total: 0, selected: [], omitted: [] })
  assert.throws(() => selectFiles(`A\0${file}`), /NUL/)
  assert.throws(() => selectFiles('R100\0old\0'), /rename/)
  const files = Array.from(
    { length: 12 },
    (_, i) =>
      `apps/web/app/${String(i).padStart(2, '0')}.behavior.browser.test.tsx`,
  )
  assert.deepEqual(
    selectFiles(
      files
        .toReversed()
        .flatMap((name) => ['A', name, 'M', name])
        .join('\0') + '\0',
    ),
    { total: 12, selected: files.slice(0, 10), omitted: files.slice(10) },
  )
})

test('uses fixed base/head merge base, excludes modified renames and fails missing refs', (t) => {
  const root = temporary(t)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Example')
  git('config', 'user.email', 'test@example.test')
  fs.mkdirSync(path.join(root, 'apps/web/app'), { recursive: true })
  const original = 'apps/web/app/old.behavior.browser.test.tsx'
  const renamed = 'apps/web/app/new.behavior.browser.test.tsx'
  fs.writeFileSync(
    path.join(root, original),
    Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
  )
  git('add', '.')
  git('commit', '-m', 'base')
  git('checkout', '-b', 'head')
  git('mv', original, renamed)
  fs.appendFileSync(path.join(root, renamed), '\nsmall edit')
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), 'example')
  git('add', '.')
  git('commit', '-m', 'head')
  const head = git('rev-parse', 'HEAD')
  git('checkout', 'main')
  const baseOnly = 'apps/web/app/base.behavior.browser.test.tsx'
  fs.writeFileSync(path.join(root, baseOnly), 'base only')
  git('add', '.')
  git('commit', '-m', 'advance base')
  const base = git('rev-parse', 'HEAD')
  assert.deepEqual(selectChanges({ root, base, head }).selected, [file])
  assert.throws(() => selectChanges({ root, base: 'missing', head }))
  assert.throws(() => selectChanges({ root, head }), /required/)
})

test('validates bounded integer strings', () => {
  for (const count of ['1', '5', '10'])
    assert.equal(validateRepetitions(count), Number(count))
  assert.equal(validateRepetitions(), 5)
  for (const invalid of ['0', '11', '-1', '1.5', ' 5', '5 ', '05', 'x', '', 5])
    assert.throws(() => validateRepetitions(invalid), /1 to 10/)
})

test('plans injected authoritative specifications, exclusions and changed includes; closes discovery', async () => {
  const specs = [
    { file, project: 'chromium' },
    ...['chromium', 'firefox', 'webkit'].map((project) => ({
      file: anchor,
      project,
    })),
  ]
  let closed = 0
  const discovery = await fixtureDiscovery(specs)()
  discovery.close = () => {
    closed++
  }
  const excluded = 'apps/web/outside.behavior.browser.test.tsx'
  const plan = await buildPlan(selected([file, anchor, excluded]), {
    discover: () => discovery,
    repetitions: '1',
  })
  assert.deepEqual(
    plan.pairs.map(({ file: name, project }) => ({ file: name, project })),
    [...specs].sort((a, b) =>
      a.file < b.file
        ? -1
        : a.file > b.file
          ? 1
          : a.project.localeCompare(b.project),
    ),
  )
  assert.deepEqual(plan.excluded, [excluded])
  assert.equal(closed, 1)
  const changed = await buildPlan(selected([file, anchor]), {
    discover: fixtureDiscovery(
      specs.filter((spec) => spec.project === 'webkit'),
    ),
  })
  assert.deepEqual(
    changed.pairs.map((pair) => pair.project),
    ['webkit'],
  )
  assert.deepEqual(changed.excluded, [file])
  assert.equal(
    (
      await buildPlan(selected([]), {
        discover: () => assert.fail('empty selection loaded config'),
      })
    ).pairs.length,
    0,
  )
  await assert.rejects(
    buildPlan(selected(), {
      discover: () => {
        throw new Error('config failed')
      },
    }),
    /config failed/,
  )
  const ambiguous = await fixtureDiscovery([
    ...specs,
    { file: `apps/web/duplicate/${file.slice(9)}`, project: 'chromium' },
  ])()
  ambiguous.close = () => {
    closed++
  }
  await assert.rejects(
    buildPlan(selected(), { discover: () => ambiguous }),
    /Ambiguous/,
  )
  assert.equal(closed, 2)
})

test('real config discovery respects inherited includes, browser overrides and excludes without launching browsers', async (t) => {
  const discovery = await discoverProjects(process.cwd())
  try {
    const specs = await discovery.specifications()
    const general = specs.find(
      (spec) =>
        !specs.some(
          (other) => other.file === spec.file && other.project !== 'chromium',
        ),
    )
    assert.ok(general)
    const common = specs.find(
      (spec) => spec.project === 'webkit' && spec.file.includes('anchor'),
    )
    assert.ok(common)
    assert.deepEqual(
      specs
        .filter((spec) => spec.file === common.file)
        .map((spec) => spec.project)
        .sort(),
      ['chromium', 'firefox', 'webkit'],
    )
    const plan = await buildPlan(
      selected([
        general.file,
        common.file,
        'apps/web/outside.behavior.browser.test.tsx',
      ]),
      { repetitions: '1' },
    )
    for (const [files, projects] of [
      [[general.file], 'chromium'],
      [[common.file], 'chromium firefox webkit'],
      [[], ''],
    ]) {
      const results = temporary(t)
      const output = path.join(results, 'output')
      fs.writeFileSync(
        path.join(results, 'selection.json'),
        JSON.stringify(selected(files)),
      )
      assert.equal(
        await main('plan', {
          RESULTS_DIR: results,
          GITHUB_OUTPUT: output,
          REPETITIONS: '1',
        }),
        0,
      )
      assert.equal(
        fs.readFileSync(output, 'utf8'),
        `has_pairs=${Boolean(projects)}\nprojects=${projects}\nhas_webkit=${projects.includes('webkit')}\n`,
      )
    }
    assert.equal(plan.pairs.length, 4)
    assert.equal(plan.excluded.length, 1)
    assert.deepEqual(
      await discovery.specifications([
        'node_modules/missing.behavior.browser.test.tsx',
      ]),
      [],
    )
  } finally {
    await discovery.close()
  }
})

test('each pair receives 1/5/10 independent invocations with literal filters and isolated reports', async (t) => {
  for (const repetitions of ['1', '5', '10']) {
    const results = temporary(t)
    const plan = await buildPlan(selected([file, anchor]), {
      repetitions,
      discover: fixtureDiscovery([
        { file, project: 'chromium' },
        { file: anchor, project: 'webkit' },
      ]),
    })
    const reports = new Set()
    await runPlan(plan, {
      results,
      executor: (command, args, options) => {
        assert.equal(command, 'pnpm')
        assert.equal(options.timeoutMs, 60_000)
        assert.equal(options.env.DEBUG, 'pw:browser')
        const pair = plan.pairs.find(
          (candidate) => candidate.filter === args.at(-1),
        )
        assert.ok(pair)
        assert.ok(args.includes(`--project=${pair.project}`))
        assert.ok(
          args.some((arg) =>
            arg.endsWith('/scripts/ci/vitest-flaky-reporter.mjs'),
          ),
        )
        const report = args
          .find((arg) => arg.startsWith('--outputFile='))
          .slice(13)
        reports.add(report)
        assert.equal(fs.existsSync(report), false)
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(path.dirname(report), 'status.json')),
          ).completed,
          false,
        )
        fs.writeFileSync(report, JSON.stringify(passing(pair)))
        return { exitCode: 0, signal: null }
      },
    })
    assert.equal(reports.size, Number(repetitions) * plan.pairs.length)
    const summary = summarize(plan, { results })
    assert.equal(summary.failed, false)
    assert.equal(
      summary.markdown.split(`| ${repetitions}/${repetitions} |`).length,
      plan.pairs.length + 1,
    )
  }
})

const failures = {
  assertion: (r) => {
    r.modules[0].tests[0] = {
      namePath: ['example'],
      state: 'failed',
      errors: [{ message: '\u001b[31mfirst | *error*\nsecond line' }],
    }
  },
  hook: (r) => {
    r.modules[0].suites.push({
      namePath: ['suite'],
      state: 'failed',
      errors: [{ message: 'hook failed' }],
    })
  },
  module: (r) => {
    r.modules[0].errors.push({ message: 'module failed' })
  },
  unhandled: (r) => {
    r.unhandledErrors.push({
      moduleId: null,
      error: { message: 'unhandled failed' },
    })
  },
  pending: (r) => {
    r.modules[0].tests[0].state = 'pending'
  },
  suitePending: (r) => {
    r.modules[0].suites.push({
      namePath: ['suite'],
      state: 'queued',
      errors: [],
    })
  },
  skipped: (r) => {
    r.modules[0].tests[0].state = 'skipped'
  },
  absent: (r) => {
    r.modules[0].tests = []
  },
  interrupted: (r) => {
    r.reason = 'interrupted'
  },
  wrongProject: (r) => {
    r.modules[0].project = 'firefox'
  },
  wrongFile: (r) => {
    r.modules[0].moduleId = anchor
  },
  extraFile: (r) => {
    r.modules.push({ ...r.modules[0], moduleId: anchor })
  },
  noModules: (r) => {
    r.modules = []
  },
  failedReason: (r) => {
    r.reason = 'failed'
  },
}
for (const kind of [
  ...Object.keys(failures),
  'spawn',
  'signal',
  'timeout',
  'exit',
  'missing',
  'malformed',
]) {
  test(`continues all repetitions after ${kind}, then fails summary`, async (t) => {
    const results = temporary(t)
    const plan = await buildPlan(selected(), {
      discover: fixtureDiscovery([{ file, project: 'chromium' }]),
    })
    let calls = 0
    const executor = (command, args) => {
      calls++
      const report = args
        .find((arg) => arg.startsWith('--outputFile='))
        .slice(13)
      const payload = passing(plan.pairs[0])
      if (calls === 1 || calls === 5) {
        if (kind === 'spawn') throw new Error('spawn failed')
        failures[kind]?.(payload)
        if (kind === 'timeout') failures.assertion(payload)
        if (kind !== 'missing')
          fs.writeFileSync(
            report,
            kind === 'malformed' ? '{' : JSON.stringify(payload),
          )
        return {
          exitCode: kind === 'exit' ? 1 : 0,
          signal: kind === 'signal' ? 'SIGTERM' : null,
          timedOut: kind === 'timeout',
        }
      }
      fs.writeFileSync(report, JSON.stringify(payload))
      return { exitCode: 0 }
    }
    await runPlan(plan, { results, executor })
    assert.equal(calls, 5)
    const summary = summarize(plan, { results })
    assert.equal(summary.failed, true)
    assert.match(summary.markdown, /3\/5/)
    assert.match(summary.markdown, /1: .+<br>5: /)
    if (kind === 'timeout')
      assert.match(summary.markdown, /Repetition timed out/)
    if (kind === 'assertion') {
      assert.match(summary.markdown, /first &#124; &#42;error&#42;/)
      assert.doesNotMatch(summary.markdown, /second line/)
      assert.equal(summary.markdown.includes(String.fromCharCode(27)), false)
    }
  })
}

test('summaries distinguish empty, excluded, capped, absent and setup outcomes', async (t) => {
  assert.match(
    summarize(selected([])).markdown,
    /No added or modified browser behavior test files \(renames, copies and deletions are not repeated\)\./,
  )
  assert.doesNotMatch(summarize(selected([])).markdown, /renamed\/copied/)
  assert.equal(summarize(selected([])).failed, false)
  const excluded = await buildPlan(selected(), {
    discover: fixtureDiscovery([]),
  })
  assert.match(summarize(excluded).markdown, /Excluded by effective config/)
  assert.match(summarize(excluded).markdown, /No selected files belong/)
  assert.equal(summarize(excluded).failed, false)
  const plan = await buildPlan(selected(), {
    discover: fixtureDiscovery([{ file, project: 'chromium' }]),
  })
  plan.total = 11
  plan.omitted = ['apps/web/app/<bad>|*`\n.behavior.browser.test.tsx']
  const report = summarize(plan, {
    results: temporary(t),
    setupError: 'install failed\nmore',
  })
  assert.equal(report.failed, true)
  assert.match(report.markdown, /Eligible files: 11. Selected: 1/)
  assert.match(report.markdown, /File cap: 10/)
  assert.match(report.markdown, /&#60;bad&#62;&#124;&#42;&#96; /)
  assert.match(report.markdown, /0\/5/)
  assert.match(report.markdown, /Missing or invalid result/)
  assert.match(report.markdown, /Setup failed or incomplete: install failed/)
  assert.equal(summarize(undefined).failed, true)
})

for (const command of ['select', 'plan']) {
  test(`CLI ${command} failure and report write one summary heading and exit nonzero`, (t) => {
    const results = temporary(t)
    const summary = path.join(results, 'summary.md')
    const cli = (step, extra = {}) =>
      spawnSync(
        process.execPath,
        ['scripts/ci/changed-browser-repetitions.mjs', step],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            RESULTS_DIR: results,
            GITHUB_STEP_SUMMARY: summary,
            ...extra,
          },
        },
      )
    if (command === 'plan')
      fs.writeFileSync(
        path.join(results, 'selection.json'),
        JSON.stringify(selected()),
      )
    assert.equal(cli(command, { REPETITIONS: '11' }).status, 1)
    assert.match(fs.readFileSync(summary, 'utf8'), /REPETITIONS/)
    assert.equal(cli('report', { SETUP_FAILED: 'true' }).status, 1)
    const markdown = fs.readFileSync(summary, 'utf8')
    assert.equal(
      markdown.match(/^## Changed browser behavior repetitions$/gm)?.length,
      1,
    )
    assert.match(markdown, /REPETITIONS must be an integer string from 1 to 10/)
    assert.match(markdown, /Setup failed or incomplete/)
    assert.match(
      markdown,
      command === 'select'
        ? /Selection or plan unavailable/
        : /Project planning did not complete/,
    )
  })
}

test('removes stale reports, rejects unfinished statuses, and retains structured collection errors', async (t) => {
  const results = temporary(t)
  const plan = await buildPlan(selected(), {
    repetitions: '1',
    discover: fixtureDiscovery([{ file, project: 'chromium' }]),
  })
  const directory = path.join(results, '0', '1')
  fs.mkdirSync(directory, { recursive: true })
  const reportPath = path.join(directory, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(passing(plan.pairs[0])))
  await runPlan(plan, { results, executor: () => ({ exitCode: 0 }) })
  assert.equal(summarize(plan, { results }).failed, true)
  assert.equal(fs.existsSync(reportPath), false)
  fs.writeFileSync(reportPath, JSON.stringify(passing(plan.pairs[0])))
  const statusPath = path.join(directory, 'status.json')
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  status.completed = false
  fs.writeFileSync(statusPath, JSON.stringify(status))
  assert.match(summarize(plan, { results }).markdown, /did not complete/)
  status.completed = true
  status.head = 'different'
  fs.writeFileSync(statusPath, JSON.stringify(status))
  assert.match(
    summarize(plan, { results }).markdown,
    /Status identity mismatch/,
  )
  status.head = plan.head
  fs.writeFileSync(statusPath, JSON.stringify(status))
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      schemaVersion: 1,
      reason: 'failed',
      modules: [],
      unhandledErrors: [
        { moduleId: null, error: { message: 'collection failed\nstack' } },
      ],
    }),
  )
  assert.match(summarize(plan, { results }).markdown, /1: collection failed/)
})

test('CLI empty diff succeeds with explicit summary before loading dependencies', (t) => {
  const root = temporary(t)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init')
  git('config', 'user.name', 'Example')
  git('config', 'user.email', 'test@example.test')
  git('commit', '--allow-empty', '-m', 'empty')
  const sha = git('rev-parse', 'HEAD')
  const results = path.join(root, 'results')
  const summary = path.join(root, 'summary.md')
  const output = path.join(root, 'output')
  const cli = path.resolve('scripts/ci/changed-browser-repetitions.mjs')
  const env = {
    ...process.env,
    RESULTS_DIR: results,
    PUBLIC_PR_BASE: sha,
    PUBLIC_PR_HEAD: sha,
    REPETITIONS: '5',
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  }
  const result = spawnSync(process.execPath, [cli, 'select'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(output, 'utf8'), 'has_files=false\n')
  assert.match(fs.readFileSync(summary, 'utf8'), /No added or modified browser/)
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
  const planned = spawnSync(process.execPath, [cli, 'plan'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  assert.equal(planned.status, 0, planned.stderr)
  assert.match(fs.readFileSync(output, 'utf8'), /has_pairs=false/)
})

test('executes every selected pair in sorted order within the 300-invocation bound', async (t) => {
  const files = Array.from(
    { length: 10 },
    (_, i) => `apps/web/app/${i}.behavior.browser.test.tsx`,
  )
  const specs = files.flatMap((name) =>
    ['webkit', 'firefox', 'chromium'].map((project) => ({
      file: name,
      project,
    })),
  )
  for (const repetitions of ['1', '5', '10']) {
    const plan = await buildPlan(selected(files.toReversed()), {
      repetitions,
      discover: fixtureDiscovery(specs),
    })
    assert.equal(plan.pairs.length, 30)
    assert.deepEqual(
      plan.pairs.map(({ file: name, project }) => ({
        file: name,
        project,
      })),
      files.flatMap((name) =>
        ['chromium', 'firefox', 'webkit'].map((project) => ({
          file: name,
          project,
        })),
      ),
    )
    assert.deepEqual(plan.projects, ['chromium', 'firefox', 'webkit'])
    let calls = 0
    const results = temporary(t)
    await runPlan(plan, {
      results,
      executor: () => {
        calls++
        return { exitCode: 1 }
      },
    })
    assert.equal(calls, plan.pairs.length * Number(repetitions))
    assert.equal(calls, 30 * Number(repetitions))
    assert.ok(calls <= 300)
    const summary = summarize(plan, { results })
    assert.equal(summary.failed, true)
    for (const pair of plan.pairs)
      assert.ok(
        summary.markdown.includes(
          `| ${pair.file} | ${pair.project} | 0/${repetitions} |`,
        ),
      )
    assert.doesNotMatch(summary.markdown, /Skipped file\/project pairs/)
  }
})

test('report fails interrupted jobs even with passing completed reports', async (t) => {
  const results = temporary(t)
  const plan = await buildPlan(selected(), {
    repetitions: '1',
    discover: fixtureDiscovery([{ file, project: 'chromium' }]),
  })
  await runPlan(plan, {
    results,
    executor: (command, args) => {
      fs.writeFileSync(
        args.find((arg) => arg.startsWith('--outputFile=')).slice(13),
        JSON.stringify(passing(plan.pairs[0])),
      )
      return { exitCode: 0 }
    },
  })
  fs.writeFileSync(path.join(results, 'plan.json'), JSON.stringify(plan))
  const summary = path.join(results, 'summary.md')
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/changed-browser-repetitions.mjs', 'report'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RESULTS_DIR: results,
        GITHUB_STEP_SUMMARY: summary,
        INTERRUPTED: 'true',
      },
    },
  )
  assert.equal(result.status, 1)
  assert.match(fs.readFileSync(summary, 'utf8'), /cancelled or interrupted/)
})
