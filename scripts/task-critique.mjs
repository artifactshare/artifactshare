import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { personas, taskFlowPhases, tasks } from './task-ledger.mjs'

const timeoutMs = 1_800_000
const layers = [
  { id: 'visual', model: 'opus', effort: 'high' },
  { id: 'task', model: 'fable', effort: 'low' },
]

function usage() {
  return `Usage:
  pnpm critique:tasks -- --walkthrough-root <path> --source <path> [--source <path>...] [--task <id>...] [--screen-root <path>...] [--dry-run]`
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const options = {
    walkthroughRoot: undefined,
    sources: [],
    taskIds: [],
    screenRoots: [],
    dryRun: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (
      !['--walkthrough-root', '--source', '--task', '--screen-root'].includes(
        arg,
      )
    )
      throw new Error(`${usage()}\n\nUnknown option: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--walkthrough-root') options.walkthroughRoot = value
    if (arg === '--source') options.sources.push(value)
    if (arg === '--task') options.taskIds.push(value)
    if (arg === '--screen-root') options.screenRoots.push(value)
  }
  if (!options.walkthroughRoot)
    throw new Error('--walkthrough-root is required.')
  if (options.sources.length === 0)
    throw new Error('At least one --source is required.')
  if (new Set(options.taskIds).size !== options.taskIds.length)
    throw new Error('Duplicate --task values are not allowed.')
  return options
}

function insideRepo(repo, path) {
  const value = relative(repo, path)
  return !value.startsWith('..') && !isAbsolute(value)
}

function sameSnapshot(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function validateImagePath(repo, root, file, label) {
  const path = resolve(root, file ?? '')
  if (
    !file ||
    !insideRepo(repo, path) ||
    !insideRepo(root, path) ||
    !path.endsWith('.png') ||
    !existsSync(path) ||
    !statSync(path).isFile()
  )
    throw new Error(`${label}: repository PNG required.`)
  return path
}

function validateInputs(options, { repo = process.cwd(), head } = {}) {
  const root = resolve(repo, options.walkthroughRoot)
  if (
    !insideRepo(repo, root) ||
    !existsSync(root) ||
    !statSync(root).isDirectory()
  )
    throw new Error(
      'Walkthrough root must be an existing directory inside the repository.',
    )
  const manifestPath = resolve(root, 'manifest.json')
  if (!existsSync(manifestPath))
    throw new Error('Walkthrough manifest.json is required.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!head || manifest.head !== head)
    throw new Error('Walkthrough capture HEAD must match the reviewed HEAD.')
  const entries = Array.isArray(manifest.tasks) ? manifest.tasks : []
  const selected = options.taskIds.length
    ? options.taskIds
    : entries.map((item) => item.taskId)
  if (selected.length === 0)
    throw new Error('At least one walkthrough task is required.')
  const sourcePaths = options.sources.map((item) => resolve(repo, item))
  for (const source of sourcePaths)
    if (
      !insideRepo(repo, source) ||
      !existsSync(source) ||
      !statSync(source).isFile()
    )
      throw new Error(
        `Source must be an existing file inside the repository: ${relative(repo, source) || source}`,
      )

  const evidencePaths = []
  const imagePaths = []
  for (const taskId of selected) {
    const currentTask = tasks.find((item) => item.id === taskId)
    const entry = entries.find((item) => item.taskId === taskId)
    if (!currentTask) throw new Error(`${taskId}: unknown task.`)
    if (!entry || entry.status !== 'success')
      throw new Error(`${taskId}: successful manifest entry required.`)
    const evidencePath = resolve(root, taskId, 'evidence.json')
    if (!existsSync(evidencePath))
      throw new Error(`${taskId}: evidence.json required.`)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const currentPersona = personas.find(
      (item) => item.id === currentTask.persona,
    )
    if (
      !sameSnapshot(evidence.task, currentTask) ||
      !sameSnapshot(evidence.persona, currentPersona)
    )
      throw new Error(
        `${taskId}: walkthrough task or persona snapshot is stale.`,
      )
    const runs = Array.isArray(evidence.runs) ? evidence.runs : []
    for (const viewport of ['desktop', 'mobile']) {
      const run = runs.find((item) => item.viewport === viewport)
      if (!run || run.status !== 'success')
        throw new Error(`${taskId}: successful ${viewport} run required.`)
      const phases = run.steps?.map((step) => step.phase) ?? []
      if (!sameSnapshot(phases, taskFlowPhases))
        throw new Error(
          `${taskId}/${viewport}: complete ordered phases required.`,
        )
      for (const step of run.steps) {
        if (
          !step.evidence ||
          typeof step.evidence !== 'object' ||
          Array.isArray(step.evidence)
        )
          throw new Error(
            `${taskId}/${viewport}/${step.phase}: evidence required.`,
          )
        imagePaths.push(
          validateImagePath(
            repo,
            resolve(root, taskId),
            step.file,
            `${taskId}/${viewport}/${step.phase}`,
          ),
        )
      }
    }
    evidencePaths.push(evidencePath)
  }
  const screenImagePaths = []
  for (const item of options.screenRoots ?? []) {
    const screenRoot = resolve(repo, item)
    if (
      !insideRepo(repo, screenRoot) ||
      !existsSync(screenRoot) ||
      !statSync(screenRoot).isDirectory()
    )
      throw new Error(
        'Screen capture root must be an existing directory inside the repository.',
      )
    const screenManifestPath = resolve(screenRoot, 'manifest.json')
    if (!existsSync(screenManifestPath))
      throw new Error('Screen capture manifest.json is required.')
    const screenManifest = JSON.parse(readFileSync(screenManifestPath, 'utf8'))
    if (!Array.isArray(screenManifest) || screenManifest.length === 0)
      throw new Error('Screen capture manifest entries are required.')
    for (const entry of screenManifest) {
      const label = `${entry.screen ?? '<screen>'}/${entry.state ?? '<state>'}/${entry.viewport ?? '<viewport>'}`
      if (entry.status !== 'success')
        throw new Error(`${label}: successful screen capture required.`)
      if (entry.head !== head)
        throw new Error(
          `${label}: screen capture HEAD must match reviewed HEAD.`,
        )
      screenImagePaths.push(
        validateImagePath(repo, screenRoot, entry.file, label),
      )
    }
  }
  return {
    root,
    selected,
    sourcePaths,
    evidencePaths,
    imagePaths,
    screenImagePaths,
  }
}

function commonPrompt(input) {
  return [
    'Read-only UI critique. Do not edit files, run a browser, or infer missing evidence.',
    'First report capture/environment defects separately from product defects. If the evidence cannot distinguish them, use needs-verification.',
    'Allowed finding classifications: product-defect, capture-environment-defect, seed-artificial, aesthetic, needs-verification.',
    'Every task finding must use this causal form: "The user needs to decide X at this moment; therefore information Y exists/is missing." Surface description alone is not a finding.',
    'Return NEEDS INPUT instead of guessing when a required file cannot be read or evidence is contradictory.',
    `Tasks: ${input.selected.join(', ')}`,
    `Evidence JSON: ${input.evidencePaths.join(', ')}`,
    `Walkthrough PNG files: ${input.imagePaths.join(', ')}`,
    `Relevant source: ${input.sourcePaths.join(', ')}`,
    'Output Markdown with: Evidence triage; Coverage; Findings. Each finding includes task, viewport, phase, classification, severity (blocker/follow-up/non-actionable), evidence, and minimal proportional fix.',
  ].join('\n')
}

function promptFor(layer, input) {
  const common = commonPrompt(input)
  if (layer.id === 'visual')
    return `${common}\nStandalone screen PNG files: ${(input.screenImagePaths ?? []).join(', ') || 'none supplied'}\n\nVisual layer: inspect every walkthrough and standalone screen PNG plus relevant source. Evaluate screen-ledger responsibility, role, primary action, loop progression, vocabulary, hierarchy/density, representative states, next action, and mock drift. A visual finding may be blocker only when the screen responsibility, primary action, or loop progression is broken; otherwise classify proportionally.`
  return `${common}\n\nTask layer: use the task and persona snapshots plus notification, frame/load, failed-request, clipboard, and CLI evidence. Cover all eight dimensions for every selected task: user/persona and mediation; purpose; states; cues; feedback; constraints; recovery; proficiency (first-use clarity and routine speed). For agent-mediated work, evaluate the human owner reviewing the result, not the agent executing the command. Explicitly test the task ledger completion and confirmation claims.`
}

function invocation(layer, prompt) {
  return {
    command: 'claude',
    args: [
      '--safe-mode',
      '--model',
      layer.model,
      '--effort',
      layer.effort,
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      'Review only. Do not edit, execute commands, browse, or write to remote services.',
      '-p',
      prompt,
      '--output-format',
      'json',
    ],
  }
}

function runLayer(
  layer,
  input,
  { run = spawnSync, repo = process.cwd() } = {},
) {
  const request = invocation(layer, promptFor(layer, input))
  const result = run(request.command, request.args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      result.stderr?.trim() || `${layer.id} critique exited ${result.status}`,
    )
  const envelope = JSON.parse(result.stdout)
  if (
    envelope.is_error !== false ||
    envelope.subtype !== 'success' ||
    typeof envelope.result !== 'string' ||
    !envelope.result.trim() ||
    !Array.isArray(envelope.permission_denials) ||
    envelope.permission_denials.length > 0
  )
    throw new Error(`${layer.id} critique failed.`)
  return envelope.result.trim()
}

function gitOutput(exec, repo, args) {
  return exec('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function cleanHead(exec, repo) {
  if (gitOutput(exec, repo, ['status', '--porcelain']))
    throw new Error('Task critique requires a clean committed checkout.')
  const head = gitOutput(exec, repo, ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the committed critique SHA.')
  return head
}

function main({
  argv = process.argv.slice(2),
  repo = process.cwd(),
  run = spawnSync,
  exec = execFileSync,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  const head = cleanHead(exec, repo)
  const input = validateInputs(options, { repo, head })
  if (options.dryRun) {
    stdout.write(
      `${JSON.stringify(
        layers.map((layer) => ({
          layer: layer.id,
          ...invocation(layer, promptFor(layer, input)),
        })),
        null,
        2,
      )}\n`,
    )
    if (cleanHead(exec, repo) !== head)
      throw new Error('HEAD or worktree changed during task critique.')
    return 0
  }
  for (const layer of layers) {
    stdout.write(
      `## ${layer.id} critique\n\n${runLayer(layer, input, { run, repo })}\n\n`,
    )
    if (cleanHead(exec, repo) !== head)
      throw new Error('HEAD or worktree changed during task critique.')
  }
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

export {
  cleanHead,
  invocation,
  main,
  parseArgs,
  promptFor,
  runLayer,
  usage,
  validateInputs,
}
