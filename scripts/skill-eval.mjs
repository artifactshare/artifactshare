import { readFile, mkdir, rm, mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { plan, publicPlan } from './lib/skill-eval/plan.mjs'
import {
  overlay,
  createRun,
  privateFile,
  inventory,
  observe,
} from './lib/skill-eval/environment.mjs'
import { runProcess } from './lib/skill-eval/process.mjs'
import { parseStream, score, markdown } from './lib/skill-eval/records.mjs'
import { redact } from './lib/skill-eval/launcher.mjs'
import { signIn, serverClient } from './lib/skill-eval/server.mjs'
import { closeAppFetch } from './lib/dev-sign-in.mjs'
import {
  scenarios,
  initialHtml,
  expectedContent,
  commentText,
  siteFiles,
} from './lib/skill-eval/scenarios.mjs'

export { initialHtml, expectedContent, commentText }
export function promptFor(scenario, url) {
  return scenarios[scenario].prompt({ url })
}
export async function actionsAt(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: '', actions: [], errors: [] }
    throw error
  }
  const actions = [],
    errors = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      const action = JSON.parse(line)
      if (!action || typeof action !== 'object' || Array.isArray(action))
        throw new Error('Invalid action')
      actions.push(action)
    } catch {
      errors.push({ line: index + 1, code: 'invalid_action_record' })
    }
  }
  return { raw, actions, errors }
}

export async function executeCase(
  item,
  options,
  version,
  selectedOverlay,
  client,
  token,
  output,
  signal,
  runtime = { createRun, runProcess },
) {
  const result = {
    ...item,
    id: randomUUID(),
    status: 'infrastructure-error',
    skills: { files: [], errors: [], complete: true, contaminated: false },
    server: {},
    cleanup: { artifacts: [], temporary: false },
  }
  const agent = item.combination.split(':')[0]
  const scenario = scenarios[item.scenario]
  let run,
    timer,
    inspection = Promise.resolve(),
    beforeList,
    seededId
  const owned = new Map()
  const secrets = [token, encodeURIComponent(token)]
  const raw = {
    stdout: join(output, `${result.id}.stdout.jsonl`),
    stderr: join(output, `${result.id}.stderr.txt`),
    actions: join(output, `${result.id}.actions.jsonl`),
  }
  result.raw = raw
  try {
    run = await runtime.createRun({
      agent,
      version,
      selectedOverlay,
      baseUrl: options.baseUrl,
      token,
    })
    result.temporaryRoot = run.root
    result.overlay = {
      fingerprint: version.fingerprint,
      derivedCompanion: selectedOverlay.derivedCompanion,
    }
    await privateFile(join(run.workdir, 'report.html'), initialHtml)
    const files = {
      ...(scenario.seed.includes('site') ? siteFiles : {}),
      ...scenario.files,
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(run.workdir, path)), { recursive: true })
      await privateFile(join(run.workdir, path), text)
    }
    beforeList = await client.list()
    if (scenario.commands.includes('projects'))
      result.projects = {
        before: await projectList(run, runtime, options, signal),
      }
    if (scenario.seed.some((step) => ['artifact', 'site'].includes(step))) {
      const setup = await runtime.runProcess({
        command: [
          join(run.root, 'bin/artifactshare'),
          'share',
          scenario.seed.includes('site') ? 'site' : 'report.html',
          '--visibility',
          'private',
          '--json',
        ],
        cwd: run.workdir,
        env: run.env.agent,
        timeoutMs: options.timeoutMs,
        signal,
      })
      result.setup = {
        status: setup.status,
        stdout: redact(setup.stdout, secrets),
        stderr: redact(setup.stderr, secrets),
      }
      if (setup.status !== 'completed') {
        let detail = setup.stderr.trim() || setup.error || setup.status
        try {
          const error = JSON.parse(setup.stderr).error
          if (error?.code && error?.message)
            detail = `${error.code}: ${error.message}`
        } catch {
          /* Non-JSON failures retain the process diagnostic. */
        }
        throw new Error(
          `${item.scenario === 'comments' ? 'Comments' : 'Update'} artifact seed failed: ${detail}`,
        )
      }
      const body = JSON.parse(setup.stdout)
      seededId = body.data?.artifact?.id
      if (!seededId || beforeList.some((artifact) => artifact.id === seededId))
        throw new Error('Could not seed an owned update artifact')
      owned.set(seededId, 'setup-cli-response')
      beforeList = await client.list()
      // Static sites cannot be read as one source, so their listing is the
      // server evidence.
      result.server.before = scenario.seed.includes('site')
        ? beforeList.find((artifact) => artifact.id === seededId)
        : await client.get(seededId)
      if (scenario.seed.includes('comment')) {
        const post = await runtime.runProcess({
          command: [
            join(run.root, 'bin/artifactshare'),
            'comments',
            'post',
            result.server.before.share_url,
            '--body',
            commentText,
            '--json',
          ],
          cwd: run.workdir,
          env: run.env.agent,
          timeoutMs: options.timeoutMs,
          signal,
        })
        result.commentSetup = {
          status: post.status,
          stdout: redact(post.stdout, secrets),
          stderr: redact(post.stderr, secrets),
        }
        if (post.status !== 'completed') {
          let detail = post.stderr.trim() || post.error || post.status
          for (const diagnostic of [post.stderr, post.stdout]) {
            try {
              const error = JSON.parse(diagnostic).error
              if (error?.code) detail = `${error.code}: ${error.message ?? ''}`
            } catch {
              /* Retain the process diagnostic for non-JSON errors. */
            }
          }
          throw new Error(`Comment post failed: ${detail}`)
        }
      }
    }
    await privateFile(run.config.log, '')
    observe(result.skills, await inventory(run.root, selectedOverlay.files))
    timer = setInterval(() => {
      inspection = inspection.then(async () =>
        observe(
          result.skills,
          await inventory(run.root, selectedOverlay.files, { live: true }),
        ),
      )
    }, 100)
    const processResult = await runtime.runProcess({
      command: item.command,
      cwd: run.workdir,
      env: run.env.agent,
      prompt: scenario.prompt({ url: result.server.before?.share_url }),
      timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns,
      agent,
      signal,
    })
    result.status = processResult.status
    await privateFile(raw.stdout, redact(processResult.stdout, secrets))
    await privateFile(raw.stderr, redact(processResult.stderr, secrets))
    result.record = parseStream(
      agent,
      redact(processResult.stdout, secrets),
      run.workdir,
    )
    result.exitCode = processResult.exitCode
    if (result.status === 'completed' && !result.record.complete)
      result.status = result.record.errors.some(
        (error) => error.type !== 'tool_error',
      )
        ? 'infrastructure-error'
        : 'incomplete'
    if (result.record.errors.some((error) => error.type?.includes('max_turns')))
      result.status = 'turn-limit'
  } catch (error) {
    result.error = redact(error.message, secrets)
    if (signal.aborted) result.status = 'interrupted'
  } finally {
    clearInterval(timer)
    await inspection
    if (run) {
      try {
        const actionLog = await actionsAt(run.config.log)
        result.actions = actionLog.actions
        result.actionLogErrors = actionLog.errors
        await privateFile(raw.actions, redact(actionLog.raw, secrets))
        if (actionLog.errors.length && result.status === 'completed')
          result.status = 'incomplete'
        for (const action of result.actions) {
          if (action.skills) observe(result.skills, action.skills)
          try {
            const response = JSON.parse(action.stdout)
            const id = response.data?.artifact?.id
            if (
              (response.command === 'share' ||
                (!response.command && action.argv?.[0] === 'share')) &&
              action.exitCode === 0 &&
              id &&
              beforeList &&
              !beforeList.some((artifact) => artifact.id === id)
            )
              owned.set(id, 'agent-cli-response')
          } catch {
            /* Unparseable CLI output stays in evidence. */
          }
        }
        observe(result.skills, await inventory(run.root, selectedOverlay.files))
      } catch {
        result.skills.complete = false
        result.skills.errors.push({ code: 'inspection_failed' })
      }
      try {
        const afterList = await client.list()
        if (beforeList)
          result.server.createdIds = [
            ...new Set([
              ...afterList.map((artifact) => artifact.id),
              ...owned.keys(),
            ]),
          ].filter((id) => !beforeList.some((before) => before.id === id))
        const id = seededId ?? [...owned.keys()][0]
        const present = afterList.find((artifact) => artifact.id === id)
        // A legacy run keeps reading an artifact the agent deleted, so the
        // missing source is reported as a server error.
        if (present || (id && scenario.legacy)) {
          result.server.listItem = present
          result.server.after =
            present?.artifact_kind === 'static_site'
              ? present
              : await client.get(id)
        }
        result.server.created = afterList.filter((artifact) =>
          result.server.createdIds?.includes(artifact.id),
        )
        result.server.afterIds = afterList.map((artifact) => artifact.id)
        result.cleanup.unattributedArtifactIds =
          result.server.createdIds?.filter(
            (createdId) => !owned.has(createdId),
          ) ?? []
        result.server.expectedContent =
          item.scenario === 'share' ? 'Draft schedule' : expectedContent
      } catch (error) {
        result.server.error = redact(error.message, secrets)
      }
      if (result.projects)
        try {
          result.projects.after = await projectList(
            run,
            runtime,
            options,
            signal,
          )
          result.projects.created = result.projects.after.filter(
            (project) =>
              !result.projects.before.some(
                (before) => before.id === project.id,
              ),
          )
        } catch (error) {
          result.projects.error = redact(error.message, secrets)
        }
      if (scenario.probe)
        try {
          result.probe = await scenario.probe({
            workdir: run.workdir,
            cli: async (args) =>
              (
                await runtime.runProcess({
                  command: [join(run.root, 'bin/artifactshare'), ...args],
                  cwd: run.workdir,
                  env: run.env.agent,
                  timeoutMs: options.timeoutMs,
                  signal,
                })
              ).stdout,
          })
        } catch (error) {
          result.probe = { error: redact(error.message, secrets) }
        }
      for (const project of result.projects?.created ?? [])
        await runtime.runProcess({
          command: [
            join(run.root, 'bin/artifactshare'),
            'projects',
            'edit',
            project.id,
            '--archive',
            '--json',
          ],
          cwd: run.workdir,
          env: run.env.agent,
          timeoutMs: options.timeoutMs,
          signal,
        })
      for (const [id, source] of owned) {
        if (
          !scenario.legacy &&
          result.server.afterIds &&
          !result.server.afterIds.includes(id)
        ) {
          result.cleanup.artifacts.push({
            id,
            source,
            deleted: 'before-cleanup',
          })
          continue
        }
        try {
          await client.delete(id)
          result.cleanup.artifacts.push({ id, source, deleted: true })
        } catch {
          result.cleanup.artifacts.push({ id, source, deleted: false })
        }
      }
      try {
        await run.cleanup()
        result.cleanup.temporary = true
      } catch {
        result.cleanup.temporary = false
      }
    }
  }
  result.record ??= parseStream(agent, '')
  if (result.skills.contaminated) result.status = 'contaminated'
  else if (!result.skills.complete && result.status === 'completed')
    result.status = 'incomplete'
  if (item.scenario === 'comments')
    result.comments = commentObservations(result.actions ?? [])
  result.checks = scenarioChecks(result, scenario, options.email)
  return result
}
async function projectList(run, runtime, options, signal) {
  const listed = await runtime.runProcess({
    command: [
      join(run.root, 'bin/artifactshare'),
      'projects',
      'list',
      '--json',
    ],
    cwd: run.workdir,
    env: run.env.agent,
    timeoutMs: options.timeoutMs,
    signal,
  })
  const projects = JSON.parse(listed.stdout).data?.projects
  if (!Array.isArray(projects)) throw new Error('Invalid project list evidence')
  return projects
}
// Legacy scenarios keep their server checks; the others are judged by their
// own task check. Every scenario reports whether the skill and the expected
// reference were read, separately from whether the task succeeded.
export function scenarioChecks(result, scenario, email) {
  const all = score(result)
  const eligible = result.record.complete && result.status === 'completed'
  const checks = scenario.legacy
    ? all
    : { json: all.json, recovery: all.recovery }
  checks.skill = {
    status: result.record.skillLoaded ? 'pass' : 'fail',
    evidence: result.record.skillInvocations.length
      ? result.record.skillInvocations
      : result.record.reads
          .map((item) => item.path)
          .filter((path) => path.includes('artifactshare')),
  }
  checks.reference = scenario.reference
    ? {
        status: result.record.referencesRead.some((path) =>
          path.endsWith(`/references/${scenario.reference}`),
        )
          ? 'pass'
          : 'fail',
        evidence: {
          expected: scenario.reference,
          read: result.record.referencesRead,
        },
      }
    : { status: 'not-applicable', evidence: 'SKILL.md covers this task' }
  if (!scenario.legacy) {
    const created = result.server.created
    const expected =
      scenario.commands.includes('share') && !scenario.seed.length ? 1 : 0
    checks.created = created
      ? {
          status: created.length === expected ? 'pass' : 'fail',
          evidence: created.map((artifact) => artifact.id),
        }
      : { status: 'unknown', evidence: 'Missing artifact inventory' }
    checks.task = scenario.verify({
      before: result.server.before,
      after: result.server.after,
      listItem: result.server.listItem,
      afterList: result.server.afterIds?.map((id) => ({ id })),
      created,
      projects: result.projects,
      record: result.record,
      email,
      ...result.probe,
    })
  }
  if (!eligible)
    for (const [name, check] of Object.entries(checks))
      if (check.status === 'pass')
        checks[name] = {
          status: 'unknown',
          evidence: 'Incomplete run cannot establish a pass',
        }
  return checks
}
// `artifacts get --include comments` reads feedback as well as `comments list`.
export function commentObservations(actions) {
  const positional = (action) =>
    action.argv?.filter((arg) => !arg.startsWith('--')) ?? []
  const includesComments = (argv) =>
    argv.some(
      (arg, index) =>
        arg === '--include=comments' ||
        (arg === '--include' && argv[index + 1] === 'comments'),
    )
  const comments = actions.filter((action) => {
    const [command, subcommand] = positional(action)
    return (
      command === 'comments' ||
      (command === 'artifacts' &&
        subcommand === 'get' &&
        includesComments(action.argv))
    )
  })
  const succeeded = (action, command) => {
    if (action.exitCode !== 0) return false
    try {
      const response = JSON.parse(action.stdout)
      return response.ok === true && response.command === command
        ? response
        : false
    } catch {
      return false
    }
  }
  return {
    read: comments.some((action) => {
      const [command, subcommand] = positional(action)
      return command === 'artifacts' || subcommand === 'list'
    }),
    resolved: comments.some((action) => succeeded(action, 'comments resolve')),
    replied: comments.some(
      (action) => succeeded(action, 'comments post')?.data?.reply === true,
    ),
    commands: comments.map((action) => action.argv),
  }
}
export async function main(argv = process.argv.slice(2)) {
  const options = await plan(argv)
  if (options.help) {
    console.log(options.help)
    return
  }
  if (options.dryRun) {
    console.log(JSON.stringify(publicPlan(options), null, 2))
    return
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const result = { schemaVersion: 1, ...publicPlan(options), runs: [] }
  let output, selectedOverlay
  try {
    // Build/loader validation precedes authentication; dry-run never reaches it.
    selectedOverlay = await overlay(options.versions[0])
    await rm(selectedOverlay.root, { recursive: true, force: true })
    selectedOverlay = null
    await mkdir(options.outputDir, { recursive: true, mode: 0o700 })
    output = await mkdtemp(join(options.outputDir, 'evaluation-'))
    const token = await signIn(options.baseUrl, options.persona)
    const client = serverClient(options.baseUrl, token)
    options.email = (await client.whoami()).user?.email
    for (const version of options.versions) {
      selectedOverlay = await overlay(version)
      for (const item of options.matrix.filter(
        (entry) => entry.version === version.label,
      )) {
        if (controller.signal.aborted) break
        result.runs.push(
          await executeCase(
            item,
            options,
            version,
            selectedOverlay,
            client,
            token,
            output,
            controller.signal,
          ),
        )
        await privateFile(
          join(output, 'results.json'),
          JSON.stringify(result, null, 2),
        )
        await privateFile(join(output, 'summary.md'), markdown(result))
      }
      await rm(selectedOverlay.root, { recursive: true, force: true })
      selectedOverlay = null
      if (controller.signal.aborted) break
    }
    console.log(`Evaluation results: ${output}`)
    if (result.runs.some((run) => run.status !== 'completed'))
      process.exitCode = 1
  } catch (error) {
    if (output) {
      result.error = 'Execution preflight failed; no credentials retained'
      await privateFile(
        join(output, 'results.json'),
        JSON.stringify(result, null, 2),
      )
      await privateFile(join(output, 'summary.md'), markdown(result))
    }
    throw error
  } finally {
    if (selectedOverlay)
      await rm(selectedOverlay.root, { recursive: true, force: true })
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await closeAppFetch()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
