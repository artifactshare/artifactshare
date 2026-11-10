import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { suiteCommand, execute } from './flaky-runs.mjs'
import { normalizeReport, normalizeFile, firstLine } from './flaky-report.mjs'

export const REPETITION_TIMEOUT_MS = 600_000
export const MAX_PAIRS = 15

export function validateRepetitions(value = '5') {
  if (typeof value !== 'string' || !/^(?:[1-9]|10)$/.test(value))
    throw new Error('REPETITIONS must be an integer string from 1 to 10')
  return Number(value)
}

export function selectFiles(text) {
  const tokens = text.split('\0')
  if (tokens.pop() !== '')
    throw new Error('Expected NUL-delimited Git statuses')
  const files = new Set()
  while (tokens.length) {
    const status = tokens.shift()
    const file = tokens.shift()
    if (!status || !file) throw new Error('Incomplete Git status record')
    if (/^[RC]/.test(status)) {
      if (!tokens.shift()) throw new Error('Incomplete rename/copy record')
      continue
    }
    if (
      /^[AM]$/.test(status) &&
      /^apps\/web\/.+\.behavior\.browser\.test\.tsx$/s.test(file)
    )
      files.add(file)
  }
  const eligible = [...files].sort()
  return {
    total: eligible.length,
    selected: eligible.slice(0, 10),
    omitted: eligible.slice(10),
  }
}

function fixedDiff({ base, head, root = process.cwd(), full = false }) {
  if (!base || !head) throw new Error('Both base and head SHAs are required')
  // Resolve commits first: missing refs fail and option-like inputs cannot reach diff.
  const commit = (ref) =>
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { cwd: root, encoding: 'utf8' },
    ).trim()
  base = commit(base)
  head = commit(head)
  const diff = execFileSync(
    'git',
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      ...(full ? [] : ['--diff-filter=AM']),
      `${base}...${head}`,
      '--',
    ],
    { cwd: root, encoding: 'utf8' },
  )
  return { diff, base, head }
}

export function selectChanges(options) {
  const { diff, base, head } = fixedDiff(options)
  return { ...selectFiles(diff), base, head }
}

export async function discoverProjects(root, exclude = []) {
  const workspace = path.join(root, 'apps/web')
  const require = createRequire(path.join(workspace, 'package.json'))
  const { createVitest } = await import(
    pathToFileURL(require.resolve('vitest/node')).href
  )
  const { configDefaults } = await import(
    pathToFileURL(require.resolve('vitest/config')).href
  )
  const ctx = await createVitest(
    'test',
    {
      root: workspace,
      config: path.join(workspace, 'vitest.behavior.browser.config.ts'),
      watch: false,
      cliExclude: exclude,
      // Discovery needs project configuration and globs, not an API listener.
      api: false,
    },
    {
      plugins: [
        {
          name: 'isolate-discovery-exclusions',
          enforce: 'pre',
          config(config) {
            config.test ??= {}
            // Vitest appends CLI exclusions in place; keep contexts independent.
            config.test.exclude = [
              ...(config.test.exclude ?? configDefaults.exclude),
            ]
          },
        },
      ],
    },
  )
  return {
    async specifications(filters = [], exclusions = []) {
      if (exclusions.length) {
        const filtered = await discoverProjects(root, exclusions)
        try {
          return await filtered.specifications(filters)
        } finally {
          await filtered.close()
        }
      }
      return (await ctx.globTestSpecifications(filters)).map((spec) => ({
        file: path.relative(root, spec.moduleId).split(path.sep).join('/'),
        project: spec.project.name,
      }))
    },
    async related(inputs) {
      ctx.config.related = inputs.map((file) => path.resolve(root, file))
      try {
        return (await ctx.getRelevantTestSpecifications()).map((spec) => ({
          file: path.relative(root, spec.moduleId).split(path.sep).join('/'),
          project: spec.project.name,
        }))
      } finally {
        ctx.config.related = undefined
      }
    },
    close: () => ctx.close(),
  }
}

async function exactPair(discovery, root, file, project) {
  const filter = path.resolve(root, file)
  let matches = (await discovery.specifications([filter])).filter(
    (spec) => spec.project === project,
  )
  // Vitest also compares absolute filters as relative, case-insensitive
  // substrings. Exclude collisions literally, then verify discovery again.
  const exclude = [
    ...new Set(
      matches
        .filter((spec) => spec.file !== file)
        .map((spec) =>
          spec.file
            .slice('apps/web/'.length)
            .replace(/[\\*?{}()[\]!+@]/g, '\\$&'),
        ),
    ),
  ]
  if (exclude.length)
    matches = (await discovery.specifications([filter], exclude)).filter(
      (spec) => spec.project === project,
    )
  if (matches.length !== 1 || matches[0].file !== file)
    throw new Error(`Ambiguous file filter for ${file} / ${project}`)
  const pair = { file, project, filter, exclude }
  return pair
}

export async function buildPlan(
  selection,
  { root = process.cwd(), discover = discoverProjects, repetitions = '5' } = {},
) {
  const count = validateRepetitions(repetitions)
  const plan = {
    ...selection,
    repetitions: count,
    pairs: [],
    skippedPairs: [],
    excluded: [],
    projects: [],
  }
  if (!selection.selected.length) return plan
  const discovery = await discover(root)
  try {
    const specifications = await discovery.specifications()
    for (const file of [...selection.selected].sort()) {
      const projects = [
        ...new Set(
          specifications
            .filter((spec) => spec.file === file)
            .map((spec) => spec.project),
        ),
      ].sort()
      if (!projects.length) plan.excluded.push(file)
      for (const project of projects) {
        if (plan.pairs.length >= MAX_PAIRS) {
          plan.skippedPairs.push({ file, project })
          continue
        }
        const pair = await exactPair(discovery, root, file, project)
        plan.pairs.push(pair)
      }
    }
    plan.projects = [...new Set(plan.pairs.map((pair) => pair.project))].sort()
    if (
      plan.projects.some(
        (project) => !['chromium', 'firefox', 'webkit'].includes(project),
      )
    )
      throw new Error('Unsupported browser project')
    return plan
  } finally {
    await discovery.close()
  }
}

const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const runDirectory = (results, index, repetition) =>
  path.join(results, String(index), String(repetition))

export function planForProject(plan, project) {
  if (project === undefined) return plan
  if (!['chromium', 'firefox', 'webkit'].includes(project))
    throw new Error('Unsupported browser project')
  // Partition only after discovery and the global pair cap. Applying the cap
  // independently in each lane would silently expand the requested work.
  const pairs = plan.pairs.filter((pair) => pair.project === project)
  return {
    ...plan,
    project,
    pairs,
    projects: pairs.length ? [project] : [],
  }
}

export async function runPlan(
  plan,
  { results, root = process.cwd(), executor = execute, beforeFile } = {},
) {
  validateRepetitions(String(plan.repetitions))
  const admitted = []
  for (const [index, pair] of plan.pairs.entries()) {
    if (beforeFile && !(await beforeFile(pair, index)))
      return { admitted, deferred: plan.pairs.slice(index) }
    admitted.push(pair)
    for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
      const directory = runDirectory(results, index, repetition)
      fs.mkdirSync(directory, { recursive: true })
      const report = path.resolve(directory, 'report.json')
      fs.rmSync(report, { force: true })
      const invocation = suiteCommand(
        { suite: 'behavior-browser', project: pair.project },
        report,
        root,
      )
      for (const exclusion of pair.exclude)
        invocation.args.push(`--exclude=${exclusion}`)
      invocation.args.push(pair.filter)
      const status = {
        ...pair,
        head: plan.head,
        repetition,
        repetitions: plan.repetitions,
        repositoryRoot: root,
        workspaceRoot: path.join(root, 'apps/web'),
        suite: 'behavior-browser',
        format: invocation.format,
        completed: false,
        exitCode: null,
        signal: null,
      }
      const statusPath = path.join(directory, 'status.json')
      writeJson(statusPath, status)
      fs.writeFileSync(path.join(directory, 'diagnostic.log'), '')
      const output = (chunk) => {
        fs.appendFileSync(path.join(directory, 'diagnostic.log'), chunk)
        process.stdout.write(chunk)
      }
      try {
        Object.assign(
          status,
          await executor(
            invocation.command,
            invocation.args,
            {
              cwd: root,
              timeoutMs: REPETITION_TIMEOUT_MS,
              env: { ...process.env, ...invocation.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
            output,
          ),
        )
        status.completed = true
      } catch (error) {
        status.error = error.message
      }
      writeJson(statusPath, status)
    }
  }
  return { admitted, deferred: [] }
}

export function repetitionResult(directory, pair, plan, repetition) {
  let infrastructure
  try {
    const status = readJson(path.join(directory, 'status.json'))
    if (
      status.file !== pair.file ||
      status.project !== pair.project ||
      status.head !== plan.head ||
      status.repetition !== repetition ||
      status.repetitions !== plan.repetitions
    )
      throw new Error('Status identity mismatch')
    if (
      !status.completed ||
      status.exitCode !== 0 ||
      status.signal ||
      status.timedOut ||
      status.error
    )
      infrastructure = status.timedOut
        ? 'Repetition timed out'
        : status.error ||
          (!status.completed
            ? 'Repetition did not complete'
            : `Process exited ${status.exitCode}, signal ${status.signal ?? 'none'}`)
    if (status.timedOut)
      return { passed: false, error: firstLine(infrastructure) }
    const text = fs.readFileSync(path.join(directory, 'report.json'), 'utf8')
    const rows = normalizeReport(text, status)
    const report = JSON.parse(text)
    const failure = rows.find(
      (row) => row.status === 'failed' || row.status === 'absent' || row.error,
    )
    if (failure)
      return {
        passed: false,
        error: firstLine(failure.error || 'Incomplete assertion results'),
      }
    if (
      report.modules.length !== 1 ||
      normalizeFile(report.modules[0].moduleId, status) !== pair.file
    )
      throw new Error('Unexpected or absent module identity')
    if (infrastructure)
      return { passed: false, error: firstLine(infrastructure) }
    if (
      report.reason !== 'passed' ||
      report.modules[0].state !== 'passed' ||
      report.modules[0].suites.some(
        (suite) => !['passed', 'skipped'].includes(suite.state),
      ) ||
      !rows.some((row) => row.status === 'passed' && !row.diagnosticKind)
    )
      throw new Error('Absent passing assertions or incomplete results')
    return { passed: true }
  } catch (error) {
    return {
      passed: false,
      error: firstLine(
        infrastructure ||
          `Missing or invalid result: ${error.code ?? error.message}`,
      ),
    }
  }
}

const cell = (value) =>
  stripVTControlCharacters(String(value))
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(
      /[&<>|\\`*_[\]{}()#!~]/g,
      (character) => `&#${character.codePointAt(0)};`,
    )

export function summarize(plan, { results, setupError } = {}) {
  const lines = ['## Changed browser behavior repetitions', '']
  let failed = Boolean(setupError)
  if (setupError)
    lines.push(`Setup failed or incomplete: ${cell(firstLine(setupError))}`, '')
  if (!plan)
    return {
      failed: true,
      markdown: [
        ...lines,
        'Selection or plan unavailable; no success can be established.',
        '',
      ].join('\n'),
    }
  lines.push(
    `Eligible files: ${plan.total}. Selected: ${plan.selected.length}.`,
    '',
  )
  if (!plan.total)
    lines.push(
      'No added or modified browser behavior test files (renames, copies and deletions are not repeated).',
      '',
    )
  if (plan.omitted.length)
    lines.push(
      'File cap: 10. Omitted paths:',
      ...plan.omitted.map((file) => `- ${cell(file)}`),
      '',
    )
  if (plan.excluded?.length)
    lines.push(
      'Excluded by effective config includes/excludes:',
      ...plan.excluded.map((file) => `- ${cell(file)}`),
      '',
    )
  if (plan.skippedPairs?.length)
    lines.push(
      `Skipped file/project pairs (pair cap: ${MAX_PAIRS}; not repeated):`,
      ...plan.skippedPairs.map(
        ({ file, project }) => `- ${cell(file)} / ${cell(project)}`,
      ),
      '',
    )
  if (plan.total && plan.pairs?.length === 0)
    lines.push(
      plan.project
        ? `No selected pairs for ${plan.project} after the global pair cap.`
        : 'No selected files belong to a browser project.',
      '',
    )
  if (plan.pairs?.length) {
    lines.push(
      '| File | Project | Passes / repetitions | Failed repetitions: first error |',
      '| --- | --- | --- | --- |',
    )
    for (const [index, pair] of plan.pairs.entries()) {
      const runs = Array.from({ length: plan.repetitions }, (_, offset) =>
        repetitionResult(
          runDirectory(results, index, offset + 1),
          pair,
          plan,
          offset + 1,
        ),
      )
      const errors = runs.flatMap((run, offset) =>
        run.passed ? [] : [`${offset + 1}: ${cell(run.error)}`],
      )
      failed ||= errors.length > 0
      lines.push(
        `| ${cell(pair.file)} | ${cell(pair.project)} | ${runs.filter((run) => run.passed).length}/${plan.repetitions} | ${errors.join('<br>') || '—'} |`,
      )
    }
  } else if (plan.total && !plan.pairs) {
    failed = true
    lines.push('Project planning did not complete; results unavailable.', '')
  }
  return { failed, markdown: [...lines, ''].join('\n') }
}

export const SOURCE_BUDGET_MS = 180_000

// Known documentation and A/M behavior-browser tests do not trigger this lane.
// Other application Markdown/assets and renamed/copied/deleted tests remain inputs.
export function selectSourceFiles(text) {
  const tokens = text.split('\0')
  if (tokens.pop() !== '')
    throw new Error('Expected NUL-delimited Git statuses')
  const paths = new Map()
  while (tokens.length) {
    const status = tokens.shift()
    if (!/^(?:[ADMTUXB]|[RC]\d{1,3})$/.test(status ?? ''))
      throw new Error('Invalid Git status record')
    for (let i = 0; i < (/^[RC]/.test(status) ? 2 : 1); i++) {
      const file = tokens.shift()
      if (!file) throw new Error('Incomplete Git status record')
      const documentation =
        /^(?:(?:docs|proposals)\/.*\.(?:md|txt)|(?:README|CONTRIBUTING|SECURITY|AGENTS|CLAUDE)\.md|LICENSE)$/s.test(
          file,
        ) ||
        file === 'apps/web/PRODUCT.md' ||
        file === 'apps/web/DESIGN.md'
      const repetitionTest =
        /^[AM]$/.test(status) &&
        /^apps\/web\/.+\.behavior\.browser\.test\.tsx$/s.test(file)
      paths.set(file, {
        file,
        status,
        trigger: !documentation && !repetitionTest,
        reason: documentation
          ? 'Repository documentation/metadata'
          : repetitionTest
            ? 'Added/modified behavior-browser test; repetition lane selection applies'
            : 'Potential runtime input (conservative)',
      })
    }
  }
  const changes = [...paths.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  )
  return {
    changes,
    inputs: changes
      .filter((change) => change.trigger)
      .map((change) => change.file),
  }
}

export function selectSourceChanges(options) {
  const { diff, base, head } = fixedDiff({ ...options, full: true })
  return { ...selectSourceFiles(diff), changed: selectFiles(diff), base, head }
}

export async function buildSourcePlan(
  selection,
  { root = process.cwd(), discover = discoverProjects } = {},
) {
  const plan = {
    ...selection,
    repetitions: 1,
    pairs: [],
    delegated: [],
    candidates: [],
    related: [],
    fallback: [],
  }
  if (!selection.inputs.length) return plan
  const discovery = await discover(root)
  try {
    const specs = await discovery.specifications()
    plan.candidates = [
      ...new Set(
        specs
          .filter((spec) => spec.project === 'chromium')
          .map((spec) => spec.file),
      ),
    ].sort()
    if (!plan.candidates.length)
      throw new Error('No effective Chromium specifications discovered')
    // Use exactly the repetition lane's global file/pair caps and effective
    // config. This shared context remains open until this plan is complete.
    const global = await buildPlan(selection.changed, {
      root,
      discover: () => ({
        specifications: (...args) => discovery.specifications(...args),
        close: async () => {},
      }),
    })
    plan.delegated = global.pairs.filter((pair) => pair.project === 'chromium')
    // The import graph is never a completeness proof: browser commands, schema
    // and compiled Worker/application inputs can have invisible edges.
    plan.fallback.push(
      'Graph is ordering only; Node commands, schema and compiled inputs can have missing edges. All candidates retained before delegation.',
    )
    if (
      selection.changes.some(
        (change) => change.trigger && /^[DRC]/.test(change.status),
      )
    )
      plan.fallback.push(
        'Deleted/renamed/copied inputs cannot be fully resolved against the head graph.',
      )
    if (
      selection.inputs.some(
        (file) =>
          !file.startsWith('apps/web/app/') || !/\.[cm]?[jt]sx?$/.test(file),
      )
    )
      plan.fallback.push(
        'Inputs outside known application import coverage; retain the full candidate queue.',
      )
    try {
      const related = await discovery.related(selection.inputs)
      const known = new Set(plan.candidates)
      plan.related = [
        ...new Set(
          related
            .filter(
              (spec) => spec.project === 'chromium' && known.has(spec.file),
            )
            .map((spec) => spec.file),
        ),
      ].sort()
      if (!plan.related.length)
        plan.fallback.push(
          'Related discovery returned no known Chromium files; use deterministic candidate order.',
        )
    } catch (error) {
      plan.fallback.push(
        `Related discovery failed; retain all candidates: ${firstLine(error.message)}`,
      )
    }
    const prioritized = new Set(plan.related)
    const delegated = new Set(plan.delegated.map((pair) => pair.file))
    for (const file of [
      ...plan.related,
      ...plan.candidates.filter((candidate) => !prioritized.has(candidate)),
    ]) {
      if (!delegated.has(file))
        plan.pairs.push(await exactPair(discovery, root, file, 'chromium'))
    }
    return plan
  } finally {
    await discovery.close()
  }
}

export async function runSourcePlan(
  plan,
  {
    results,
    root = process.cwd(),
    executor = execute,
    budgetMs = SOURCE_BUDGET_MS,
    clock = () => performance.now(),
    save = () => {},
  } = {},
) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0)
    throw new Error(
      'Admission budget must be a positive integer in milliseconds',
    )
  plan.execution = {
    admitted: 0,
    deferred: [],
    completed: false,
    budgetMs,
    elapsedMs: 0,
  }
  save(plan)
  const start = clock()
  const partition = await runPlan(plan, {
    results,
    root,
    executor,
    beforeFile: (_pair, index) => {
      plan.execution.elapsedMs = clock() - start
      if (plan.execution.elapsedMs >= budgetMs) return false
      // Record admission before launch. An interrupted/missing report can
      // never turn started work into queue-deferred work.
      plan.execution.admitted = index + 1
      save(plan)
      return true
    },
  })
  plan.execution.deferred = partition.deferred.map((pair) => pair.file)
  plan.execution.elapsedMs = clock() - start
  plan.execution.completed = true
  save(plan)
  return partition
}

export function summarizeSource(plan, { results, setupError } = {}) {
  const lines = ['## Maintainer PR Chromium source feedback', '']
  let failed = Boolean(setupError)
  if (setupError)
    lines.push(
      `Setup failed or interrupted: ${cell(firstLine(setupError))}`,
      '',
    )
  if (!plan)
    return {
      failed: true,
      markdown: [
        ...lines,
        'Selection unavailable; no success established.',
        '',
      ].join('\n'),
    }
  lines.push(
    `Fixed diff: ${cell(plan.base)}...${cell(plan.head)}`,
    '',
    'Input paths and reasons:',
    ...plan.changes.map(
      (change) =>
        `- ${cell(change.status)} ${cell(change.file)}: ${cell(change.reason)}`,
    ),
    '',
  )
  if (!plan.inputs.length) {
    lines.push(
      'No runtime inputs; no dependencies or Vitest configuration loaded.',
      '',
    )
    return { failed, markdown: lines.join('\n') }
  }
  if (!plan.candidates)
    return {
      failed: true,
      markdown: [
        ...lines,
        'Planning incomplete; no success established.',
        '',
      ].join('\n'),
    }
  lines.push(
    `Effective Chromium candidates before delegation: ${plan.candidates.length}.`,
    'Related files prioritized (remaining candidates follow in path order):',
    ...plan.related.map((file) => `- ${cell(file)}`),
    '',
    ...plan.fallback.map((reason) => `Fallback: ${cell(reason)}`),
    '',
    'Requested/delegated to changed-browser repetitions (not passes):',
    ...plan.delegated.map((pair) => `- ${cell(pair.file)}`),
    '',
  )
  const execution = plan.execution
  if (plan.pairs.length && !execution?.completed) {
    failed = true
    lines.push(
      'Execution incomplete; unstarted work is not established as budget-deferred.',
      '',
    )
  }
  if (execution) {
    lines.push(
      `Observed execution: ${cell(execution.elapsedMs)} ms. Soft admission budget: ${cell(execution.budgetMs)} ms; per-file deadline: ${REPETITION_TIMEOUT_MS} ms.`,
      '',
      '| Admitted file | Outcome | First error |',
      '| --- | --- | --- |',
    )
    for (const [index, pair] of plan.pairs
      .slice(0, execution.admitted)
      .entries()) {
      const result = repetitionResult(
        runDirectory(results, index, 1),
        pair,
        plan,
        1,
      )
      failed ||= !result.passed
      lines.push(
        `| ${cell(pair.file)} | ${result.passed ? 'passed' : 'failed'} | ${cell(result.error ?? '—')} |`,
      )
    }
    lines.push(
      '',
      'Queue-deferred by admission budget (not passes):',
      ...execution.deferred.map((file) => `- ${cell(file)}`),
      '',
    )
  }
  lines.push(
    'Partial feedback only. Merge queue remains the source of full validation.',
    '',
  )
  return { failed, markdown: lines.join('\n') }
}

export async function main(command, env = process.env) {
  const source = command?.startsWith('source-')
  if (source) command = command.slice('source-'.length)
  const render = source ? summarizeSource : summarize
  const selectionPath = path.join(env.RESULTS_DIR, 'selection.json')
  const planPath = path.join(env.RESULTS_DIR, 'plan.json')
  const output = (key, value) => {
    if (env.GITHUB_OUTPUT)
      fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  const summary = (value) => {
    if (env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, value)
    else process.stdout.write(value)
  }
  fs.mkdirSync(env.RESULTS_DIR, { recursive: true })
  try {
    if (command === 'select') {
      validateRepetitions(env.REPETITIONS ?? '5')
      const selection = (source ? selectSourceChanges : selectChanges)({
        base: env.PUBLIC_PR_BASE,
        head: env.PUBLIC_PR_HEAD,
      })
      writeJson(selectionPath, selection)
      const hasFiles = source
        ? selection.inputs.length > 0
        : selection.selected.length > 0
      output('has_files', hasFiles)
      if (!hasFiles) summary(render(selection).markdown)
    } else if (command === 'plan') {
      const plan = source
        ? await buildSourcePlan(readJson(selectionPath))
        : planForProject(
            await buildPlan(readJson(selectionPath), {
              repetitions: env.REPETITIONS ?? '5',
            }),
            env.BROWSER_PROJECT,
          )
      writeJson(planPath, plan)
      output('has_pairs', plan.pairs.length > 0)
      output(
        'projects',
        source
          ? plan.pairs.length
            ? 'chromium'
            : ''
          : plan.projects.join(' '),
      )
      output('has_webkit', source ? false : plan.projects.includes('webkit'))
    } else if (command === 'run') {
      const plan = readJson(planPath)
      if (source)
        await runSourcePlan(plan, {
          results: env.RESULTS_DIR,
          save: (value) => writeJson(planPath, value),
        })
      else await runPlan(plan, { results: env.RESULTS_DIR })
      return render(plan, { results: env.RESULTS_DIR }).failed ? 1 : 0
    } else if (command === 'report') {
      let plan
      try {
        plan = readJson(planPath)
      } catch {
        /* Setup may have failed before discovery. */
      }
      if (!plan) {
        try {
          plan = readJson(selectionPath)
        } catch {
          /* Selection itself may have failed. */
        }
      }
      const report = render(plan, {
        results: env.RESULTS_DIR,
        setupError:
          env.INTERRUPTED === 'true'
            ? 'Job cancelled or interrupted; results may be incomplete.'
            : env.SETUP_FAILED === 'true'
              ? 'See the failed setup/selection step.'
              : undefined,
      })
      summary(report.markdown)
      return report.failed ? 1 : 0
    } else throw new Error('Expected select, plan, run, or report')
    return 0
  } catch (error) {
    // The report step owns the heading after a failed selection or plan.
    summary(`${cell(firstLine(error.message))}\n\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv[2])
