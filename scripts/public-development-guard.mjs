import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { compileScanConfig, scanValue } from './lib/scan-patterns.mjs'
const root = process.cwd()
const defaultGit = (args) =>
  execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
export function loadBoundaryManifest(repo = process.cwd()) {
  return parseBoundaryManifest(
    fs.readFileSync(path.join(repo, 'config/repository-boundary.json'), 'utf8'),
  )
}

// The baseline manifest must describe the tree it classifies. Reading it from
// a commit (the diff base) instead of a working tree keeps it aligned when
// the trusted checkout is the base branch tip: a path removed from the
// manifest on main must not fail an older base tree that still contains it.
export function loadBoundaryManifestAt(git, commit) {
  return parseBoundaryManifest(
    git(['show', `${commit}:config/repository-boundary.json`]),
  )
}

function parseBoundaryManifest(source) {
  const boundary = JSON.parse(source)
  if (boundary.schema_version !== 1)
    throw new Error('unsupported boundary schema')
  const prefixes = (boundary.canonical_prefixes ?? []).map((prefix) => ({
    path: prefix,
    classification: 'canonical',
    exclusions: (boundary.canonical_prefix_exclusions?.[prefix] ?? []).map(
      (excluded) => `${prefix}${excluded}`,
    ),
  }))
  for (const [classification, values] of Object.entries(
    boundary.classification_prefixes ?? {},
  ))
    prefixes.push(
      ...values.map((prefix) => ({
        path: prefix,
        classification,
        exclusions: [],
      })),
    )
  const knownPrefixes = new Set([
    ...(boundary.canonical_prefixes ?? []),
    ...Object.values(boundary.classification_prefixes ?? {}).flat(),
  ])
  for (const prefix of Object.keys(boundary.canonical_prefix_exclusions ?? {}))
    if (!knownPrefixes.has(prefix))
      throw new Error(`exclusion for unknown boundary prefix: ${prefix}`)
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
  if (prefixes.some(({ path: prefix }) => !prefix.endsWith('/')))
    throw new Error('boundary prefix must end with /')
  const exported = Object.values(classifications).flat()
  return { ...boundary, exported, prefixes, classifications }
}

export function checkStandalone(repo = root) {
  const manifest = loadBoundaryManifest(repo)
  validateBoundaryManifest(manifest)
  const indexTree = execFileSync('git', ['write-tree'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
  const rows = parseTree(
    execFileSync('git', ['ls-tree', '-r', '--full-tree', indexTree], {
      cwd: repo,
      encoding: 'utf8',
    }),
  )
  return inspectTree(rows, manifest)
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
  trustedHead = '',
  headRepoFullName = '',
  baseRepoFullName = '',
}) {
  if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head))
    throw new Error('invalid CI PR range')
  if (trustedHead !== '' && !/^[0-9a-f]{40}$/u.test(trustedHead))
    throw new Error('invalid trusted head')
  for (const [label, value] of metadata) inspectMetadata(value, label)
  inspectMetadata(branch, 'branch')
  const commits = git(['rev-list', '--reverse', `${base}..${head}`])
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  // Commits reachable from the trusted tip (history the PR merged in from
  // the base branch) were already accepted when they landed there. Scanning
  // them again with today's policy would make a later allowlist removal on
  // main fail an open PR in a way only a history rewrite could clear. Only
  // the PR's own commits are inspected; the head tree check below still
  // covers the final content.
  const ownCommits =
    trustedHead === ''
      ? null
      : new Set(
          git(['rev-list', `${base}..${head}`, '--not', trustedHead])
            .trim()
            .split(/\s+/u)
            .filter(Boolean),
        )
  const acceptedOnTrustedTip = (sha) =>
    ownCommits !== null && !ownCommits.has(sha)
  const changed = changedPaths(git, base, head)
  const maintainer =
    headRepoFullName !== '' && headRepoFullName === baseRepoFullName
  if (!maintainer) assertProposalOnly(changed)
  const baseManifest = loadBoundaryManifestAt(git, base)
  const headManifest = maintainer ? loadBoundaryManifest(repo) : baseManifest
  const baseTree = parseTree(git(['ls-tree', '-r', base]))
  const headTree = parseTree(git(['ls-tree', '-r', head]))
  const reclassified = assertManifestEvolution({
    baseManifest,
    headManifest,
    baseTree,
    headTree,
    manifestOnly:
      maintainer &&
      changed.length === 1 &&
      changed[0].path === 'config/repository-boundary.json',
  })
  inspectTree(headTree, headManifest)
  let previous = base
  for (const sha of commits) {
    if (!acceptedOnTrustedTip(sha)) {
      inspectChangedContent({
        git,
        head: sha,
        changed: changedPaths(git, previous, sha),
        configRepo: manifestRepo,
      })
      inspectMetadata(git(['show', '-s', '--format=%B', sha]), `commit ${sha}`)
      inspectTree(parseTree(git(['ls-tree', '-r', sha])), headManifest)
    }
    previous = sha
  }
  inspectChangedContent({
    git,
    head,
    changed: reclassified.map((file) => ({ status: 'M', path: file })),
    configRepo: manifestRepo,
  })
  return commits
}

export function changedPaths(git, base, head) {
  return git(['diff', '--name-status', '--find-renames', base, head])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split('\t')
      return {
        status,
        path: second ?? first,
        previousPath: second ? first : null,
      }
    })
}

export function assertProposalOnly(changed) {
  if (
    changed.length !== 1 ||
    changed[0].status !== 'A' ||
    !/^proposals\/[^/]+\.(?:md|txt)$/u.test(changed[0].path)
  )
    throw new Error(
      'external pull requests may add exactly one proposal document',
    )
}

function classificationsFor(entries, manifest) {
  return new Map(
    inspectTree(entries, manifest).map((row) => [row.path, row.classification]),
  )
}

export function assertManifestEvolution({
  baseManifest,
  headManifest,
  baseTree,
  headTree,
  manifestOnly = false,
}) {
  const base = classificationsFor(baseTree, baseManifest)
  const head = classificationsFor(headTree, headManifest)
  const reclassified = []
  for (const [file, classification] of base) {
    if (!head.has(file)) continue
    if (head.get(file) !== classification) {
      if (manifestOnly) {
        reclassified.push(file)
        continue
      }
      throw new Error(
        `boundary classification changed outside a manifest-only PR: ${file}`,
      )
    }
  }
  return reclassified
}

function loadScanConfig(repo) {
  return JSON.parse(
    fs.readFileSync(
      path.join(repo, 'config/public-repository-scan.json'),
      'utf8',
    ),
  )
}

export function inspectChangedContent({ git, head, changed, configRepo }) {
  const compiled = compileScanConfig(loadScanConfig(configRepo))
  for (const { status, path: file } of changed) {
    if (status === 'D') continue
    const value = git(['show', `${head}:${file}`])
    if (value.includes('\0')) continue
    const finding = scanValue(value, file, compiled)[0]
    if (finding)
      throw new Error(`changed content contains ${finding.category}: ${file}`)
  }
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
    const range = [
      'rev-list',
      '--reverse',
      update.localSha,
      '--not',
      `--remotes=${remoteName}`,
    ]
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
      const trustedHead = values('--trusted-head')[0] ?? ''
      const headRepoFullName = values('--head-repo-full-name')[0] ?? ''
      const baseRepoFullName = values('--base-repo-full-name')[0] ?? ''
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
        trustedHead,
        headRepoFullName,
        baseRepoFullName,
      })
    } else if (process.argv.includes('--check')) {
      const unknown = args.filter((arg) => arg !== '--check')
      if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`)
      checkStandalone(root)
    } else {
      const unknown = args.filter(
        (arg) =>
          arg.startsWith('--') &&
          !['--remote'].includes(arg) &&
          ![
            '--ci-pr',
            '--base',
            '--head',
            '--metadata-file',
            '--head-repo-full-name',
            '--base-repo-full-name',
          ].includes(arg),
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
