import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  main,
  selectSourceFiles,
  selectSourceChanges,
  buildSourcePlan,
  runSourcePlan,
  summarizeSource,
  MAX_PAIRS,
  REPETITION_TIMEOUT_MS,
  selectFiles,
  selectChanges,
  validateRepetitions,
  buildPlan,
  planForProject,
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

test('browser lanes partition the globally capped plan without dropping or adding pairs', async () => {
  const files = Array.from(
    { length: 8 },
    (_, i) => `apps/web/app/lib/example-${i}.behavior.browser.test.tsx`,
  )
  const projects = ['chromium', 'firefox', 'webkit']
  const plan = await buildPlan(selected(files), {
    discover: fixtureDiscovery(
      files.flatMap((testFile) =>
        projects.map((project) => ({ file: testFile, project })),
      ),
    ),
  })
  assert.equal(plan.pairs.length, MAX_PAIRS)
  assert.equal(plan.skippedPairs.length, 9)
  const lanes = projects.map((project) => planForProject(plan, project))
  assert.deepEqual(
    lanes
      .flatMap((lane) => lane.pairs)
      .sort((a, b) =>
        `${a.file}/${a.project}`.localeCompare(`${b.file}/${b.project}`),
      ),
    plan.pairs,
  )
  for (const [i, lane] of lanes.entries()) {
    assert.deepEqual(lane.projects, [projects[i]])
    assert.equal(lane.repetitions, 5)
    assert.deepEqual(lane.skippedPairs, plan.skippedPairs)
  }
  assert.equal(planForProject(plan), plan)
  for (const invalid of ['', 'Chromium', 'unknown'])
    assert.throws(() => planForProject(plan, invalid), /Unsupported browser/)
  const empty = planForProject({ ...plan, pairs: [] }, 'webkit')
  assert.deepEqual(empty.projects, [])
  assert.match(summarize(empty).markdown, /No selected pairs for webkit/)
})
const fixtureDiscovery = (specifications) => () => ({
  specifications: (filters = [], exclusions = []) =>
    specifications.filter(
      (spec) =>
        (!filters.length ||
          spec.file
            .slice('apps/web/'.length)
            .toLowerCase()
            .includes(
              path.relative(path.resolve('apps/web'), filters[0]).toLowerCase(),
            )) &&
        !exclusions.includes(
          spec.file
            .slice('apps/web/'.length)
            .replace(/[\\*?{}()[\]!+@]/g, '\\$&'),
        ),
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

test('preview browser setup builds missing CLI output once and reuses it', () => {
  const helper = new URL(
    '../apps/web/app/test/preview-security-browser-command.ts',
    import.meta.url,
  )
  const source = fs.readFileSync(helper, 'utf8')
  // Run the actual setup before browser/process creation, with build and disk
  // effects controlled so this regression needs no browser or package install.
  const setup = source
    .slice(
      source.indexOf('  const cli = resolve('),
      source.indexOf('  const dir = mkdtempSync('),
    )
    .replaceAll('import.meta.dirname', 'helperDirectory')
  const helperDirectory = path.dirname(fileURLToPath(helper))
  const cli = path.resolve(
    helperDirectory,
    '../../../../packages/cli/dist/index.js',
  )
  const builds = []
  let built = false
  const context = {
    assert,
    resolve: path.resolve,
    helperDirectory,
    existsSync: (candidate) => {
      assert.equal(candidate, cli)
      return built
    },
    execFileSync: (command, args, options) => {
      builds.push({ command, args: [...args], options: { ...options } })
      built = true
    },
  }
  runInNewContext(setup, { ...context })
  runInNewContext(setup, { ...context })
  assert.deepEqual(builds, [
    {
      command: 'pnpm',
      args: ['--filter', '@artifactshare/cli', 'build'],
      options: {
        cwd: path.resolve(helperDirectory, '../../../..'),
        stdio: 'inherit',
      },
    },
  ])

  built = false
  assert.throws(
    () =>
      runInNewContext(setup, {
        ...context,
        execFileSync: () => {},
      }),
    /Build @artifactshare\/cli before running preview browser tests/,
  )
  const failure = new Error('Build failed')
  assert.throws(
    () =>
      runInNewContext(setup, {
        ...context,
        execFileSync: () => {
          throw failure
        },
      }),
    (error) => error === failure,
  )
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
    { file, project: 'chromium' },
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

test('suffix and case-insensitive collisions execute only the selected file', async (t) => {
  const collision = `apps/web/duplicate/${file.slice(9).toUpperCase()}`
  const specs = [file, collision].flatMap((name) =>
    ['chromium', 'firefox', 'webkit'].map((project) => ({
      file: name,
      project,
    })),
  )
  const discovery = fixtureDiscovery(specs)()
  assert.deepEqual(await discovery.specifications([path.resolve(file)]), specs)
  const plan = await buildPlan(selected([file]), {
    repetitions: '1',
    discover: fixtureDiscovery(specs),
  })
  assert.equal(plan.pairs.length, 3)
  const results = temporary(t)
  const invocations = []
  await runPlan(plan, {
    results,
    executor: async (command, args) => {
      invocations.push({ command, args: [...args] })
      const exclusions = args
        .filter((arg) => arg.startsWith('--exclude='))
        .map((arg) => arg.slice(10))
      const project = args.find((arg) => arg.startsWith('--project=')).slice(10)
      const matches = (
        await discovery.specifications([args.at(-1)], exclusions)
      ).filter((spec) => spec.project === project)
      const report = passing({ file, project })
      report.modules = matches.flatMap((pair) => passing(pair).modules)
      fs.writeFileSync(
        args.find((arg) => arg.startsWith('--outputFile=')).slice(13),
        JSON.stringify(report),
      )
      return { exitCode: 0 }
    },
  })
  assert.equal(invocations.length, 3)
  for (const [index, { command, args }] of invocations.entries()) {
    assert.equal(command, 'pnpm')
    assert.equal(args.at(-1), path.resolve(file))
    assert.ok(args.includes(`--project=${plan.pairs[index].project}`))
    const exclusions = args
      .filter((arg) => arg.startsWith('--exclude='))
      .map((arg) => arg.slice(10))
    assert.deepEqual(exclusions, [collision.slice('apps/web/'.length)])
    const matches = await discovery.specifications([args.at(-1)], exclusions)
    assert.deepEqual([...new Set(matches.map((spec) => spec.file))], [file])
  }
  assert.equal(summarize(plan, { results }).failed, false)
})

test('Vitest discovery isolates suffix and case collisions without browser execution', async (t) => {
  const root = fs.realpathSync(temporary(t))
  const workspace = path.join(root, 'apps/web')
  fs.mkdirSync(workspace, { recursive: true })
  fs.symlinkSync(
    path.resolve('apps/web/node_modules'),
    path.join(workspace, 'node_modules'),
    'dir',
  )
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(
    path.join(workspace, 'vitest.behavior.browser.config.ts'),
    `
    export default { test: {
      include: ['**/*.test.tsx'],
      browser: { enabled: true, instances: [{ browser: 'chromium' }] }
    } }
  `,
  )
  const names = [
    'apps/web/app/example[one].behavior.browser.test.tsx',
    'apps/web/nested/app/example[one].behavior.browser.test.tsx',
    'apps/web/other/APP/EXAMPLE[ONE].behavior.browser.test.tsx',
  ]
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), '')
  }
  const discovery = await discoverProjects(root)
  try {
    assert.equal(
      (await discovery.specifications([path.resolve(root, names[0])])).length,
      3,
    )
  } finally {
    await discovery.close()
  }
  const plan = await buildPlan(selected(names), { root, repetitions: '1' })
  assert.equal(plan.pairs.length, 3)
  for (const pair of plan.pairs) {
    const verified = await discoverProjects(root, pair.exclude)
    try {
      assert.deepEqual(await verified.specifications([pair.filter]), [
        { file: pair.file, project: pair.project },
      ])
    } finally {
      await verified.close()
    }
  }
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
        assert.equal(REPETITION_TIMEOUT_MS, 600_000)
        assert.equal(options.timeoutMs, REPETITION_TIMEOUT_MS)
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

test('caps sorted file/project pairs at 15 and executes at most 150 invocations', async (t) => {
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
    assert.equal(MAX_PAIRS, 15)
    assert.equal(plan.pairs.length, MAX_PAIRS)
    assert.deepEqual(
      plan.pairs.map(({ file: name, project }) => ({
        file: name,
        project,
      })),
      files.slice(0, 5).flatMap((name) =>
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
    assert.equal(calls, 15 * Number(repetitions))
    assert.ok(calls <= 150)
    const summary = summarize(plan, { results })
    assert.equal(summary.failed, true)
    for (const pair of plan.pairs)
      assert.ok(
        summary.markdown.includes(
          `| ${pair.file} | ${pair.project} | 0/${repetitions} |`,
        ),
      )
    const skipped = files.slice(5).flatMap((name) =>
      ['chromium', 'firefox', 'webkit'].map((project) => ({
        file: name,
        project,
      })),
    )
    assert.deepEqual(plan.skippedPairs, skipped)
    assert.match(
      summary.markdown,
      /Skipped file\/project pairs \(pair cap: 15; not repeated\)/,
    )
    for (const pair of skipped) {
      assert.ok(summary.markdown.includes(`- ${pair.file} / ${pair.project}`))
      assert.ok(
        !summary.markdown.includes(`| ${pair.file} | ${pair.project} |`),
      )
    }
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

const sourceSelection = (inputs = ['apps/web/app/lib/viewer-hash.ts']) => ({
  ...selectSourceFiles(inputs.map((name) => `M\0${name}\0`).join('')),
  changed: selectFiles(inputs.map((name) => `M\0${name}\0`).join('')),
  base: 'base',
  head: 'head',
})
const sourceDiscovery =
  (specs, related = []) =>
  () => ({
    ...fixtureDiscovery(specs)(),
    related: () => {
      if (related instanceof Error) throw related
      return related
    },
  })

test('source selection keeps deleted and both renamed endpoints, runtime Markdown/assets and unknown inputs', () => {
  const selection = selectSourceFiles(
    'D\0apps/web/app/deleted.ts\0R100\0apps/web/app/old.ts\0docs/new.md\0M\0apps/web/app/legal/terms.md\0A\0unknown.png\0M\0README.md\0',
  )
  assert.deepEqual(selection.inputs, [
    'apps/web/app/deleted.ts',
    'apps/web/app/legal/terms.md',
    'apps/web/app/old.ts',
    'unknown.png',
  ])
  assert.equal(selection.changes.length, 6)
  for (const malformed of ['M\0file', 'R100\0old\0', 'WHAT\0file\0'])
    assert.throws(() => selectSourceFiles(malformed))
})

test('source selection excludes only A/M configured browser tests and exact context docs', () => {
  const diff = `A\0${file}\0M\0${anchor}\0M\0apps/web/PRODUCT.md\0A\0apps/web/DESIGN.md\0`
  const selection = selectSourceFiles(diff)
  assert.deepEqual(selection.inputs, [])
  assert.equal(selection.changes.length, 4)
  for (const change of selection.changes) {
    assert.equal(change.trigger, false)
    assert.match(
      change.reason,
      change.file.endsWith('.tsx')
        ? /Added\/modified behavior-browser test; repetition lane selection applies/
        : /documentation/,
    )
  }
  assert.deepEqual(selectFiles(diff), {
    total: 2,
    selected: [file, anchor].sort(),
    omitted: [],
  })
  const runtime = [
    'apps/web/app/example.test.tsx',
    'apps/web/app/example.behavior.browser.test.ts',
    'apps/web/app/test/helper.ts',
    'packages/example.behavior.browser.test.tsx',
    'apps/web/app/PRODUCT.md',
    'apps/web/design.md',
    'apps/web/OTHER.md',
    'apps/web/public/icon.svg',
  ].sort()
  assert.deepEqual(sourceSelection(runtime).inputs, runtime)
})

for (const status of ['D', 'R100', 'C100']) {
  test(`source selection preserves ${status} browser test paths`, async () => {
    const diff = `${status}\0${file}\0${status === 'D' ? '' : `${anchor}\0`}`
    const selection = {
      ...selectSourceFiles(diff),
      changed: selectFiles(diff),
    }
    const expected = (status === 'D' ? [file] : [file, anchor]).sort()
    assert.deepEqual(selection.inputs, expected)
    assert.ok(
      selection.changes.every(
        (change) => change.trigger && change.status === status,
      ),
    )
    assert.deepEqual(selection.changed, { total: 0, selected: [], omitted: [] })
    const plan = await buildSourcePlan(selection, {
      discover: sourceDiscovery([{ file: anchor, project: 'chromium' }]),
    })
    assert.deepEqual(plan.delegated, [])
    assert.deepEqual(
      plan.pairs.map((pair) => pair.file),
      [anchor],
    )
    assert.ok(
      plan.fallback.some((reason) => reason.includes('Deleted/renamed/copied')),
    )
  })
}

test('related discovery only orders the complete effective universe, with conservative fallback', async () => {
  const names = [
    'apps/web/app/a.behavior.browser.test.tsx',
    'apps/web/app/b.behavior.browser.test.tsx',
    'apps/web/app/c.behavior.browser.test.tsx',
  ]
  const specs = names.map((name) => ({ file: name, project: 'chromium' }))
  for (const related of [
    [specs[2], specs[1], { file: 'unknown', project: 'chromium' }],
    [],
    new Error('graph unavailable'),
  ]) {
    const plan = await buildSourcePlan(sourceSelection(), {
      discover: sourceDiscovery(specs.toReversed(), related),
    })
    assert.deepEqual(plan.candidates, names)
    assert.deepEqual(
      plan.pairs.map((pair) => pair.file),
      Array.isArray(related) && related.length
        ? [names[1], names[2], names[0]]
        : names,
    )
    assert.equal(plan.delegated.length, 0)
    assert.ok(plan.fallback.length)
  }
  const selection = {
    ...sourceSelection(),
    ...selectSourceFiles(
      'D\0apps/web/app/deleted.ts\0R100\0packages/cli/old.ts\0packages/cli/new.ts\0',
    ),
  }
  const plan = await buildSourcePlan(selection, {
    discover: sourceDiscovery(specs),
  })
  assert.equal(plan.pairs.length, 3)
  assert.ok(plan.fallback.some((reason) => reason.includes('Deleted/renamed')))
  assert.ok(plan.fallback.some((reason) => reason.includes('outside known')))
  await assert.rejects(
    buildSourcePlan(sourceSelection(), { discover: sourceDiscovery([]) }),
    /No effective Chromium/,
  )
  await assert.rejects(
    buildSourcePlan(sourceSelection(), {
      discover: () => {
        throw new Error('config failed')
      },
    }),
    /config failed/,
  )
})

test('source delegation uses actual global caps and keeps both cap tails eligible once', async () => {
  const names = Array.from(
    { length: 12 },
    (_, i) =>
      `apps/web/app/${String(i).padStart(2, '0')}.behavior.browser.test.tsx`,
  )
  const specs = names.flatMap((name) =>
    ['chromium', 'firefox', 'webkit'].map((project) => ({
      file: name,
      project,
    })),
  )
  const selection = sourceSelection([...names, 'apps/web/app/source.ts'])
  assert.deepEqual(selection.inputs, ['apps/web/app/source.ts'])
  assert.equal(selection.changes.length, 13)
  assert.deepEqual(selection.changed, {
    total: 12,
    selected: names.slice(0, 10),
    omitted: names.slice(10),
  })
  const plan = await buildSourcePlan(selection, {
    discover: sourceDiscovery(specs, specs),
  })
  assert.deepEqual(
    plan.delegated.map((pair) => pair.file),
    names.slice(0, 5),
  )
  assert.deepEqual(
    plan.pairs.map((pair) => pair.file),
    names.slice(5),
  )
  assert.equal(
    new Set([...plan.delegated, ...plan.pairs].map((pair) => pair.file)).size,
    12,
  )
})

for (const outcome of [
  'passed',
  'assertion',
  'missing',
  'malformed',
  'pending',
  'timeout',
  'signal',
  'hook',
  'module',
  'unhandled',
  'wrongProject',
]) {
  test(`source admission preserves ${outcome} before budget exhaustion`, async (t) => {
    const results = temporary(t)
    const specs = [file, anchor]
      .sort()
      .map((name) => ({ file: name, project: 'chromium' }))
    const plan = await buildSourcePlan(sourceSelection(), {
      discover: sourceDiscovery(specs),
    })
    let now = 0
    let calls = 0
    const partition = await runSourcePlan(plan, {
      results,
      budgetMs: 100,
      clock: () => now,
      executor: (_command, args, options) => {
        calls++
        assert.equal(plan.execution.admitted, 1)
        assert.equal(options.timeoutMs, 600_000)
        now = 100
        const payload = passing(plan.pairs[0])
        failures[outcome]?.(payload)
        if (outcome !== 'missing')
          fs.writeFileSync(
            args.find((arg) => arg.startsWith('--outputFile=')).slice(13),
            outcome === 'malformed' ? '{' : JSON.stringify(payload),
          )
        return {
          exitCode: 0,
          timedOut: outcome === 'timeout',
          signal: outcome === 'signal' ? 'SIGTERM' : null,
        }
      },
    })
    assert.equal(calls, 1)
    assert.deepEqual(partition.admitted, [plan.pairs[0]])
    assert.deepEqual(partition.deferred, [plan.pairs[1]])
    assert.deepEqual(plan.execution.deferred, [plan.pairs[1].file])
    assert.equal(
      summarizeSource(plan, { results }).failed,
      outcome !== 'passed',
    )
    assert.equal(
      summarizeSource(plan, { results, setupError: 'cancelled' }).failed,
      true,
    )
  })
}

test('source failures continue within budget and incomplete admission cannot succeed', async (t) => {
  const results = temporary(t)
  const plan = await buildSourcePlan(sourceSelection(), {
    discover: sourceDiscovery(
      [file, anchor].map((name) => ({ file: name, project: 'chromium' })),
    ),
  })
  let calls = 0
  await runSourcePlan(plan, {
    results,
    clock: () => 0,
    executor: () => {
      calls++
      return { exitCode: 1 }
    },
  })
  assert.equal(calls, 2)
  assert.deepEqual(plan.execution.deferred, [])
  assert.equal(summarizeSource(plan, { results }).failed, true)
  // Abrupt cancellation after admission leaves the existing plan incomplete,
  // even if a process returned success and its structured report was written.
  plan.execution.completed = false
  assert.equal(summarizeSource(plan, { results }).failed, true)
  assert.equal(
    summarizeSource({ ...plan, execution: undefined }, { results }).failed,
    true,
  )
})

test('source CLI uses fixed merge-base diff and docs-only selection/planning need no dependencies', (t) => {
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
  fs.writeFileSync(path.join(root, 'README.md'), 'before')
  git('add', '.')
  git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(root, 'README.md'), 'after')
  git('add', '.')
  git('commit', '-m', 'docs')
  const head = git('rev-parse', 'HEAD')
  const results = path.join(root, 'results')
  const env = {
    ...process.env,
    RESULTS_DIR: results,
    PUBLIC_PR_BASE: base,
    PUBLIC_PR_HEAD: head,
    GITHUB_OUTPUT: path.join(root, 'output'),
  }
  for (const command of ['source-select', 'source-plan', 'source-report']) {
    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts/ci/changed-browser-repetitions.mjs'), command],
      { cwd: root, env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
  const selection = JSON.parse(
    fs.readFileSync(path.join(results, 'selection.json')),
  )
  assert.deepEqual(selection.inputs, [])
  assert.equal(selection.base, base)
  assert.equal(selection.head, head)
  // A base-side-only commit is excluded by base...head, while head deletion
  // and rename endpoints remain visible to the source selector.
  git('checkout', '-b', 'base-side', base)
  fs.writeFileSync(path.join(root, 'base-only.ts'), '')
  git('add', '.')
  git('commit', '-m', 'base-side')
  const advancedBase = git('rev-parse', 'HEAD')
  git('checkout', '--detach', head)
  git('mv', 'README.md', 'runtime.md')
  git('commit', '-m', 'rename')
  const renamed = git('rev-parse', 'HEAD')
  assert.deepEqual(
    selectSourceChanges({ root, base: advancedBase, head: renamed }).inputs,
    ['runtime.md'],
  )
  git('rm', 'runtime.md')
  git('commit', '-m', 'delete')
  assert.deepEqual(
    selectSourceChanges({ root, base: renamed, head: git('rev-parse', 'HEAD') })
      .inputs,
    ['runtime.md'],
  )
  assert.throws(() => selectSourceChanges({ root, base: 'missing', head }))
})

for (const [label, files] of [
  ['browser tests', [file, anchor]],
  ['context docs', ['apps/web/PRODUCT.md', 'apps/web/DESIGN.md']],
  [
    'tests and context docs',
    [file, anchor, 'apps/web/PRODUCT.md', 'apps/web/DESIGN.md'],
  ],
]) {
  test(`source CLI skips install and discovery for A/M ${label}`, async (t) => {
    const root = temporary(t)
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const write = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      fs.writeFileSync(path.join(root, name), content)
    }
    git('init')
    git('config', 'user.name', 'Example')
    git('config', 'user.email', 'test@example.test')
    files
      .filter((_, index) => index % 2 === 0)
      .forEach((name) => write(name, 'before'))
    git('add', '.')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    files.forEach((name) => write(name, 'after'))
    git('add', '.')
    git('commit', '-m', 'tests and documentation')
    const head = git('rev-parse', 'HEAD')
    const results = path.join(root, 'results')
    const output = path.join(root, 'output')
    const env = {
      ...process.env,
      RESULTS_DIR: results,
      PUBLIC_PR_BASE: base,
      PUBLIC_PR_HEAD: head,
      GITHUB_OUTPUT: output,
    }
    for (const command of ['source-select', 'source-plan', 'source-report']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve('scripts/ci/changed-browser-repetitions.mjs'), command],
        { cwd: root, env, encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
    assert.match(fs.readFileSync(output, 'utf8'), /^has_files=false$/m)
    assert.match(fs.readFileSync(output, 'utf8'), /^has_pairs=false$/m)
    const selection = JSON.parse(
      fs.readFileSync(path.join(results, 'selection.json')),
    )
    assert.deepEqual(selection.inputs, [])
    assert.deepEqual(
      selection.changes.map((change) => change.file),
      [...files].sort(),
    )
    assert.deepEqual(
      [...new Set(selection.changes.map((change) => change.status))].sort(),
      ['A', 'M'],
    )
    assert.deepEqual(selection.changed, {
      total: files.filter((name) => name.endsWith('.tsx')).length,
      selected: files.filter((name) => name.endsWith('.tsx')).sort(),
      omitted: [],
    })
    const plan = await buildSourcePlan(selection, {
      discover: () => {
        throw new Error('Non-runtime changes must not load Vitest')
      },
    })
    assert.deepEqual(plan.changed, selection.changed)
    assert.deepEqual(plan.pairs, [])
    assert.deepEqual(plan.delegated, [])
  })
}

test('Vitest related imports prioritize without execution and preserve effective excludes', async (t) => {
  const root = fs.realpathSync(temporary(t))
  const workspace = path.join(root, 'apps/web')
  fs.mkdirSync(workspace, { recursive: true })
  fs.symlinkSync(
    path.resolve('apps/web/node_modules'),
    path.join(workspace, 'node_modules'),
    'dir',
  )
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(
    path.join(workspace, 'vitest.behavior.browser.config.ts'),
    `export default { test: {
    include: ['*.test.tsx'], exclude: ['excluded.test.tsx'],
    browser: { enabled: true, instances: [{ browser: 'chromium' }] }
  } }`,
  )
  fs.writeFileSync(path.join(workspace, 'source.ts'), 'export const value = 1')
  fs.writeFileSync(
    path.join(workspace, 'a.test.tsx'),
    'throw new Error("must not execute")',
  )
  fs.writeFileSync(
    path.join(workspace, 'z.test.tsx'),
    'import { value } from "./source"; throw new Error("must not execute " + value)',
  )
  fs.writeFileSync(
    path.join(workspace, 'excluded.test.tsx'),
    'import "./source"',
  )
  const plan = await buildSourcePlan(sourceSelection(['apps/web/source.ts']), {
    root,
  })
  assert.deepEqual(plan.related, ['apps/web/z.test.tsx'])
  assert.deepEqual(
    plan.pairs.map((pair) => pair.file),
    ['apps/web/z.test.tsx', 'apps/web/a.test.tsx'],
  )
  assert.deepEqual(plan.delegated, [])
})

test('source report cannot pass cancellation even after all admitted assertions pass', async (t) => {
  const results = temporary(t)
  const plan = await buildSourcePlan(sourceSelection(), {
    discover: sourceDiscovery([{ file, project: 'chromium' }]),
  })
  await runSourcePlan(plan, {
    results,
    executor: (_command, args) => {
      fs.writeFileSync(
        args.find((arg) => arg.startsWith('--outputFile=')).slice(13),
        JSON.stringify(passing(plan.pairs[0])),
      )
      return { exitCode: 0 }
    },
    save: (value) =>
      fs.writeFileSync(path.join(results, 'plan.json'), JSON.stringify(value)),
  })
  assert.equal(summarizeSource(plan, { results }).failed, false)
  const env = {
    RESULTS_DIR: results,
    GITHUB_STEP_SUMMARY: path.join(results, 'summary.md'),
  }
  assert.equal(await main('source-report', { ...env, INTERRUPTED: 'true' }), 1)
  assert.equal(await main('source-report', { ...env, SETUP_FAILED: 'true' }), 1)
  fs.rmSync(path.join(results, '0', '1', 'status.json'))
  assert.equal(await main('source-report', env), 1)
})

test('repetition and source summaries retain native recovered retries and unknown durations', async (t) => {
  const plan = await buildPlan(selected(), {
    discover: fixtureDiscovery([{ file, project: 'chromium' }]),
    repetitions: '1',
  })
  const source = await buildSourcePlan(sourceSelection(), {
    discover: sourceDiscovery([{ file, project: 'chromium' }]),
  })
  for (const [candidate, execute, render] of [
    [plan, runPlan, summarize],
    [source, runSourcePlan, summarizeSource],
  ]) {
    for (const execution of [
      { durationMs: 12, retryCount: 1, repeatCount: 0, flaky: true },
      { durationMs: null, retryCount: null, repeatCount: null, flaky: null },
      undefined,
    ]) {
      const results = temporary(t)
      await execute(candidate, {
        results,
        clock: () => 0,
        executor: (_command, args) => {
          const payload = passing(candidate.pairs[0])
          if (execution !== undefined)
            payload.modules[0].tests[0].execution = execution
          fs.writeFileSync(
            args.find((arg) => arg.startsWith('--outputFile=')).slice(13),
            JSON.stringify(payload),
          )
          return { exitCode: 0 }
        },
      })
      const summary = render(candidate, { results })
      assert.equal(summary.failed, false)
      assert.match(
        summary.markdown,
        execution?.durationMs === 12 ? /12.0 ms.*1 recovered/u : /unknown/u,
      )
      if (execution?.durationMs === null)
        assert.match(summary.markdown, /duration 0\/1/u)
    }
  }
})

test('resolved dependency and harness configuration inputs retain conservative source coverage', () => {
  const inputs = [
    'pnpm-lock.yaml',
    'package.json',
    'apps/web/package.json',
    'pnpm-workspace.yaml',
    'apps/web/vitest.behavior.browser.config.ts',
    'apps/web/wrangler.sandbox.jsonc',
  ]
  assert.deepEqual(
    selectSourceFiles(inputs.map((input) => `M\0${input}\0`).join('')).inputs,
    inputs.toSorted(),
  )
})
