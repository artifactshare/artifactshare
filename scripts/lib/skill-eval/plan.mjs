import { realpath, readdir, readFile, lstat } from 'node:fs/promises'
import { resolve, dirname, join, relative, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

export const repository = resolve(import.meta.dirname, '../../..')
export const combinations = [
  'claude:claude-opus-5-5',
  'claude:claude-sonnet-5-5',
  'codex:gpt-6.1-sol',
  'codex:gpt-6-astra',
]
export const personas = [
  'free-owner',
  'plus-owner',
  'team-owner',
  'team-member',
]
export const usage =
  'pnpm skill-eval -- [--dry-run] [--persona free-owner|plus-owner|team-owner|team-member] [--combination agent:model] [--scenario share|update] [--skill-version directory] [--runs N] [--timeout-ms N] [--max-turns N] [--base-url origin] [--output-dir directory]'
export const fingerprint = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')
export function localOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Expected a local HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Expected a local HTTP(S) origin without credentials, path, query or fragment',
    )
  return url.origin
}
export function within(parent, child) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))
  )
}
export async function canonical(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(resolve(path))
    return join(await canonical(parent), basename(path))
  }
}
export async function outputPath(path, repo = repository) {
  const target = await canonical(resolve(path))
  if (within(await realpath(repo), target))
    throw new Error('Results must be outside the repository working tree')
  return target
}
export async function skillVersion(source) {
  const root = await realpath(resolve(source))
  const files = {}
  async function walk(dir, ancestors = []) {
    const actual = await realpath(dir)
    if (!within(root, actual) || ancestors.includes(actual))
      throw new Error('Skill contains an escaping or cyclic symlink')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const target = await realpath(path)
      if (!within(root, target))
        throw new Error('Skill contains an escaping symlink')
      const info = await lstat(target)
      if (info.isDirectory()) await walk(path, [...ancestors, actual])
      else if (info.isFile())
        files[relative(root, path)] = await readFile(target, 'utf8')
      else throw new Error('Skill inputs must be ordinary files')
    }
  }
  await walk(root)
  if (!files['SKILL.md']) throw new Error('Skill version requires SKILL.md')
  return {
    source: root,
    label: basename(root),
    fingerprint: fingerprint(JSON.stringify(Object.entries(files).sort())),
    files,
  }
}
export function agentCommand(combination, maxTurns) {
  const [agent, model] = combination.split(':')
  if (agent === 'claude')
    return [
      'claude',
      '-p',
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Bash',
      '--max-turns',
      String(maxTurns),
    ]
  return [
    'codex',
    'exec',
    '--skip-git-repo-check',
    '-m',
    model,
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ]
}
export async function plan(argv) {
  const options = {
    combinations: [],
    scenarios: [],
    sources: [],
    persona: 'free-owner',
    runs: 1,
    timeoutMs: 300000,
    maxTurns: 20,
    baseUrl: 'https://localhost:5173',
    outputDir: join(tmpdir(), 'artifactshare-skill-eval'),
    dryRun: false,
  }
  const names = {
    '--combination': 'combinations',
    '--scenario': 'scenarios',
    '--skill-version': 'sources',
    '--persona': 'persona',
    '--runs': 'runs',
    '--timeout-ms': 'timeoutMs',
    '--max-turns': 'maxTurns',
    '--base-url': 'baseUrl',
    '--output-dir': 'outputDir',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') return { help: usage }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    const name = names[arg]
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(`Invalid or missing argument: ${arg}\n${usage}`)
    const value = argv[++i]
    if (Array.isArray(options[name])) options[name].push(value)
    else if (typeof options[name] === 'number') {
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error(`Expected positive integer for ${arg}\n${usage}`)
      options[name] = Number(value)
    } else options[name] = value
  }
  if (!personas.includes(options.persona))
    throw new Error(`Unsupported persona ${options.persona}\n${usage}`)
  if (!options.combinations.length) options.combinations = [...combinations]
  if (!options.scenarios.length) options.scenarios = ['share', 'update']
  for (const id of options.combinations)
    if (!combinations.includes(id))
      throw new Error(
        `Unsupported combination ${id}; Cursor is deferred\n${usage}`,
      )
  for (const id of options.scenarios)
    if (!['share', 'update'].includes(id))
      throw new Error(
        `Unsupported scenario ${id}; comments is deferred\n${usage}`,
      )
  options.combinations = [...new Set(options.combinations)]
  options.scenarios = [...new Set(options.scenarios)]
  options.baseUrl = localOrigin(options.baseUrl)
  options.outputDir = await outputPath(options.outputDir)
  const versions = await Promise.all(
    (options.sources.length
      ? options.sources
      : [join(repository, 'packages/cli/skills/artifactshare')]
    ).map(skillVersion),
  )
  if (new Set(versions.map((v) => v.label)).size !== versions.length)
    throw new Error('Skill version directory names must be unique labels')
  const matrix = []
  for (const version of versions)
    for (const combination of options.combinations)
      for (const scenario of options.scenarios)
        for (let repetition = 1; repetition <= options.runs; repetition++)
          matrix.push({
            version: version.label,
            combination,
            scenario,
            repetition,
            command: agentCommand(combination, options.maxTurns),
            layout: {
              home: '<temporary>/home',
              codexHome: '<temporary>/codex',
              workdir: '<temporary>/work',
              skill: combination.startsWith('claude:')
                ? '.claude/skills/artifactshare'
                : '.agents/skills/artifactshare',
              bin: '<temporary>/bin',
              overlay: '<temporary-overlay>/dist/index.js',
            },
          })
  return { ...options, versions, matrix }
}
export function publicPlan(value) {
  return {
    ...value,
    versions: value.versions.map(({ files: _files, ...version }) => version),
  }
}
