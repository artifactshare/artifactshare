import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = process.cwd()
const generatedPublicOnlyPaths = ['PUBLIC-EXPORT-RECEIPT.json']
const defaultGit = (args) =>
  execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
export function loadBoundaryManifest(repo = process.cwd()) {
  const include = JSON.parse(
    fs.readFileSync(
      path.join(repo, 'config/public-export-include.json'),
      'utf8',
    ),
  )
  const boundary = JSON.parse(
    fs.readFileSync(path.join(repo, 'config/repository-boundary.json'), 'utf8'),
  )
  const exported = include.rules.flatMap((rule) => {
    const values = rule.exact
      ? Array.isArray(rule.exact)
        ? rule.exact
        : [rule.exact]
      : []
    return values.map((source) => rule.export_path ?? source)
  })
  exported.push(...generatedPublicOnlyPaths)
  const prefixes = include.rules
    .filter((rule) => rule.prefix)
    .map((rule) => ({
      path: rule.prefix,
      classification:
        rule.classification === 'public' ? 'canonical' : rule.classification,
      exclusions: (rule.exclude ?? []).map(
        (excluded) => `${rule.prefix}${excluded}`,
      ),
    }))
  const classifications = Object.fromEntries(
    Object.entries(boundary.classifications ?? {}).map(([key, values]) => [
      key,
      [...values],
    ]),
  )
  classifications.canonical = [
    ...(boundary.canonical ?? []),
    ...(classifications.canonical ?? []),
  ]
  if (boundary.source !== 'config/public-export-include.json')
    throw new Error('boundary manifest source mismatch')
  const publicRules = include.rules.filter(
    ({ classification }) => classification === 'public',
  )
  const expectedPrefixes = publicRules
    .filter((rule) => rule.prefix)
    .map((rule) => rule.prefix)
  const actualPrefixes = boundary.canonical_prefixes ?? []
  if (expectedPrefixes.some((prefix) => !actualPrefixes.includes(prefix)))
    throw new Error('boundary prefix contract mismatch')
  if (actualPrefixes.some((prefix) => !expectedPrefixes.includes(prefix)))
    throw new Error('boundary prefix contract mismatch')
  if (actualPrefixes.some((prefix) => !prefix.endsWith('/')))
    throw new Error('boundary prefix must end with /')
  const expectedExclusions = Object.fromEntries(
    publicRules
      .filter((rule) => rule.prefix && rule.exclude?.length)
      .map((rule) => [rule.prefix, rule.exclude]),
  )
  if (
    JSON.stringify(boundary.canonical_prefix_exclusions ?? {}) !==
    JSON.stringify(expectedExclusions)
  )
    throw new Error('boundary prefix exclusion contract mismatch')
  const expectedExactPaths = [...generatedPublicOnlyPaths]
  for (const rule of include.rules) {
    const sources = Array.isArray(rule.exact)
      ? rule.exact
      : rule.exact
        ? [rule.exact]
        : []
    const paths = sources.map((source) => rule.export_path ?? source)
    expectedExactPaths.push(...paths)
  }
  const actualExactPaths = [
    ...(boundary.canonical ?? []),
    ...Object.values(boundary.classifications ?? {}).flat(),
  ]
  if (
    expectedExactPaths.some((file) => !actualExactPaths.includes(file)) ||
    actualExactPaths.some((file) => !expectedExactPaths.includes(file))
  )
    throw new Error('boundary exact contract mismatch')
  return { ...boundary, exported, prefixes, classifications }
}

export function checkStandalone(repo = root, { sourceInventory = false } = {}) {
  const manifest = loadBoundaryManifest(repo)
  validateBoundaryManifest(manifest)
  const rows = parseTree(
    execFileSync('git', ['ls-tree', '-r', '--full-tree', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }),
  )
  const inventoryFile = path.join(
    repo,
    'docs',
    'reference',
    'public-export-inventory.jsonl',
  )
  const checkedRows = sourceInventory
    ? fs
        .readFileSync(inventoryFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((row) => row.classification === 'public')
        .map((row) => ({ path: row.export_path, mode: row.entry_type }))
    : rows
  return inspectTree(checkedRows, manifest)
}

export function validateBoundaryManifest(manifest) {
  const allowed = new Set(manifest.exported)
  if (allowed.size !== manifest.exported.length)
    throw new Error('duplicate exported path')
  const classified = new Map()
  const classifiedPrefixes = (manifest.prefixes ?? []).map((prefix) =>
    typeof prefix === 'string'
      ? { path: prefix, classification: 'canonical', exclusions: [] }
      : { ...prefix, exclusions: prefix.exclusions ?? [] },
  )
  for (const [classification, paths] of Object.entries(
    manifest.classifications ?? {},
  )) {
    if (
      !['canonical', 'private-overlay', 'public-only'].includes(classification)
    )
      throw new Error(`invalid classification: ${classification}`)
    for (const file of paths) {
      if (file.endsWith('/')) {
        if (classifiedPrefixes.some(({ path: prefix }) => prefix === file))
          throw new Error(`duplicate boundary prefix: ${file}`)
        classifiedPrefixes.push({ path: file, classification })
        continue
      }
      if (classified.has(file))
        throw new Error(`duplicate boundary path: ${file}`)
      classified.set(file, classification)
    }
  }
  for (const file of classified.keys()) {
    if (
      !allowed.has(file) &&
      !classifiedPrefixes.some(({ path: prefix }) => file.startsWith(prefix))
    )
      throw new Error(`boundary path is not exported: ${file}`)
  }
  for (const file of allowed) {
    if (
      !classified.has(file) &&
      !classifiedPrefixes.some(({ path: prefix }) => file.startsWith(prefix))
    )
      throw new Error(`unclassified exported path: ${file}`)
  }
  for (let i = 0; i < classifiedPrefixes.length; i++)
    for (let j = i + 1; j < classifiedPrefixes.length; j++)
      if (
        classifiedPrefixes[i].path.startsWith(classifiedPrefixes[j].path) ||
        classifiedPrefixes[j].path.startsWith(classifiedPrefixes[i].path)
      )
        throw new Error(
          `ambiguous boundary prefix: ${classifiedPrefixes[i].path}`,
        )
  for (const { path: prefix, exclusions } of classifiedPrefixes)
    for (const excluded of exclusions)
      if (!excluded.startsWith(prefix) || excluded === prefix)
        throw new Error(`invalid boundary exclusion: ${excluded}`)
  for (const file of classified.keys()) {
    const matches = classifiedPrefixes.filter(({ path: prefix }) =>
      file.startsWith(prefix),
    )
    if (
      matches.length &&
      matches.some(
        ({ classification }) => classification !== classified.get(file),
      )
    )
      throw new Error(`ambiguous boundary path: ${file}`)
  }
  return { exact: classified, prefixes: classifiedPrefixes }
}

export function inspectTree(entries, manifest) {
  const classifications = validateBoundaryManifest(manifest)
  const rows = []
  for (const entry of entries) {
    const file = typeof entry === 'string' ? entry : entry.path
    const mode = typeof entry === 'string' ? 'file' : entry.mode
    const classification =
      classifications.exact.get(file) ??
      classifications.prefixes.find(
        ({ path: prefix, exclusions }) =>
          file.startsWith(prefix) && !exclusions.includes(file),
      )?.classification
    if (!classification) throw new Error(`manifest outside path: ${file}`)
    if (mode !== 'file') throw new Error(`unsafe tree entry: ${mode} ${file}`)
    rows.push({ path: file, classification })
  }
  return rows
}

export function parseTree(output) {
  return output
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+) \w+ [0-9a-f]+\t(.+)$/u)
      if (!match) throw new Error(`invalid tree entry: ${line}`)
      return {
        mode:
          match[1] === '100644' || match[1] === '100755'
            ? 'file'
            : match[1] === '120000'
              ? 'symlink'
              : match[1] === '160000'
                ? 'submodule'
                : match[1],
        path: match[2],
      }
    })
}

export function inspectCommitRange({
  base,
  head,
  branch = '',
  metadata = [],
  git,
  repo = root,
  manifestRepo = repo,
}) {
  if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head))
    throw new Error('invalid CI PR range')
  for (const [label, value] of metadata) inspectMetadata(value, label)
  inspectMetadata(branch, 'branch')
  const commits = git(['rev-list', '--reverse', `${base}..${head}`])
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  const manifest = loadBoundaryManifest(manifestRepo)
  for (const sha of commits) {
    inspectMetadata(git(['show', '-s', '--format=%B', sha]), `commit ${sha}`)
    inspectTree(parseTree(git(['ls-tree', '-r', sha])), manifest)
  }
  return commits
}

const forbidden = [
  { id: 'issue-reference', pattern: /(^|[^\p{L}\p{N}_])#\d+(?!\w)/u },
  {
    id: 'private-repository-url',
    pattern:
      /https?:\/\/(?:www\.)?github\.com\/techtalkjp\/artifactshare(?:\b|\/)/iu,
  },
  {
    id: 'artifactshare-spec-url',
    pattern: /https?:\/\/artifactshare\.com\/a\//iu,
  },
  {
    id: 'internal-host',
    pattern:
      /(?:^|[.\s])(?:techtalkjp|artifactshare\.internal|(?:dev|staging|prod)\.artifactshare\.com)(?:$|[/:\s])/iu,
  },
  {
    id: 'internal-helper',
    pattern:
      /(?:^|[\s/_-])(?:pnpm\s+(?:deploy|publish)|(?:ops|production|private)-(?:deploy|smoke|handoff)|stripe-ops|oauth-workspace-integration)(?:$|[\s/_-])/iu,
  },
]

export function inspectMetadata(value, label = 'metadata') {
  const violations = forbidden
    .filter(({ pattern }) => pattern.test(value))
    .map(({ id }) => id)
  if (violations.length)
    throw new Error(
      `${label} contains forbidden metadata: ${violations.join(', ')}`,
    )
  return true
}

export function parsePrePushInput(input) {
  return input
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line
        .trim()
        .split(/\s+/u)
      if (!localRef || !localSha || !remoteRef || !remoteSha)
        throw new Error(`invalid pre-push line: ${line}`)
      return {
        localRef,
        localSha,
        remoteRef,
        remoteSha,
        deleted: localSha === '0'.repeat(40),
      }
    })
}

export function outgoingCommits(
  updates,
  remoteName = 'origin',
  git = defaultGit,
) {
  const commits = new Set()
  for (const update of updates) {
    if (update.deleted) continue
    const range =
      update.remoteSha === '0'.repeat(40)
        ? [
            'rev-list',
            '--reverse',
            update.localSha,
            `--not`,
            `--remotes=${remoteName}`,
          ]
        : ['rev-list', '--reverse', `${update.remoteSha}..${update.localSha}`]
    for (const sha of git(range).trim().split(/\s+/u).filter(Boolean))
      commits.add(sha)
  }
  return [...commits]
}

export function guardPush({ input, branch, remoteName = 'origin', git } = {}) {
  const manifest = loadBoundaryManifest(process.cwd())
  validateBoundaryManifest(manifest)
  inspectMetadata(branch ?? '', 'branch')
  const updates = parsePrePushInput(input ?? '')
  if (!/^[A-Za-z0-9._-]+$/u.test(remoteName))
    throw new Error(`invalid remote name: ${remoteName}`)
  const gitImpl = git ?? defaultGit
  const commits = outgoingCommits(updates, remoteName, gitImpl)
  for (const sha of commits) {
    const message = gitImpl(['show', '-s', '--format=%B', sha])
    inspectMetadata(message, `commit ${sha}`)
    const tree = parseTree(gitImpl(['ls-tree', '-r', sha]))
    inspectTree(tree, manifest)
  }
  return { commits, updates: updates.length }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  try {
    const args = process.argv.slice(2)
    const values = (option) =>
      args.flatMap((arg, index) => (arg === option ? [args[index + 1]] : []))
    for (const file of values('--metadata-file')) {
      if (!file || file.startsWith('--'))
        throw new Error('metadata-file value is required')
      inspectMetadata(fs.readFileSync(file, 'utf8'), 'pull request')
    }
    if (process.argv.includes('--ci-pr')) {
      const base = values('--base')[0]
      const head = values('--head')[0]
      const repo = values('--repo')[0] ?? root
      const manifestRepo = values('--manifest-repo')[0] ?? repo
      const git = (gitArgs) =>
        execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8' })
      inspectCommitRange({
        base,
        head,
        branch: process.env.GITHUB_HEAD_REF ?? '',
        metadata: [],
        git,
        repo,
        manifestRepo,
      })
    } else if (process.argv.includes('--check')) {
      const unknown = args.filter(
        (arg) => !['--check', '--source-inventory'].includes(arg),
      )
      if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`)
      checkStandalone(root, {
        sourceInventory: process.argv.includes('--source-inventory'),
      })
    } else {
      const unknown = args.filter(
        (arg) =>
          arg.startsWith('--') &&
          !['--remote'].includes(arg) &&
          !['--ci-pr', '--base', '--head', '--metadata-file'].includes(arg),
      )
      if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`)
      const remote = values('--remote')[0]
      if (!remote || values('--remote').length !== 1)
        throw new Error('remote option requires a value')
      guardPush({
        input,
        remoteName: remote,
        branch: execFileSync('git', ['branch', '--show-current'], {
          encoding: 'utf8',
        }).trim(),
      })
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
