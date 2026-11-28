import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { compileScanConfig, scanValue } from './lib/scan-patterns.mjs'
const root = process.cwd()
const defaultGit = (args) =>
  execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
const manifestFix = (change) =>
  `fix: ${change} in config/repository-boundary.json`
const rewriteFix = (sha) =>
  `fix: rewrite commit ${sha.slice(0, 12)} (git rebase -i, edit or reword); a later commit that removes it does not clear this check`

const metadataFixes = {
  'issue-reference': (text) => `remove ${text} and state the fact in words`,
  'private-repository-url': () => 'remove the private repository URL',
  'artifactshare-spec-url': () =>
    'remove the artifact URL and describe the artifact in words',
  'internal-host': () => 'remove the internal host name',
  'internal-helper': () => 'remove the internal command or helper name',
}

const contentFixes = {
  credential: 'remove the credential and rotate it',
  'personal-data':
    'replace the address with one at example.com, example.org, or example.test',
  'private-network':
    'replace the private address or ssh target with a documentation value',
  'private-reference':
    'remove the private path, issue number, or URL and state the fact in words',
  'production-resource': 'remove the production identifier',
  'public-ci-reachability':
    'remove the private runner, secret, deploy, or publish step from the public workflow',
}

function metadataLocationFix(label) {
  if (label.startsWith('commit ')) return rewriteFix(label.slice(7))
  if (label === 'branch')
    return 'fix: rename the branch (git branch -m <new-name>) and push the new name'
  if (label === 'pull request')
    return 'fix: edit the pull request title or body, then rerun the check'
  return `fix: edit the ${label}`
}

const boundaryFixes = {
  'unsupported-boundary-schema': () => [manifestFix('set schema_version to 1')],
  'unknown-prefix-exclusion': () => [
    manifestFix(
      'list the prefix in canonical_prefixes or classification_prefixes, or drop its canonical_prefix_exclusions entry',
    ),
  ],
  'unterminated-boundary-prefix': () => [
    manifestFix('end every prefix with /'),
  ],
  'duplicate-exported-path': () => [manifestFix('list each path once')],
  'invalid-classification': () => [
    manifestFix('use canonical, private-overlay, or public-only'),
  ],
  'duplicate-boundary-prefix': () => [manifestFix('list the prefix once')],
  'duplicate-boundary-path': () => [
    manifestFix('keep the path under one classification'),
  ],
  'unexported-boundary-path': () => [
    manifestFix('add the path to canonical or drop its classification'),
  ],
  'unclassified-exported-path': () => [manifestFix('classify the path')],
  'ambiguous-boundary-prefix': () => [
    manifestFix('make the prefixes disjoint'),
  ],
  'invalid-boundary-exclusion': () => [
    manifestFix('make each exclusion a path inside its prefix'),
  ],
  'ambiguous-boundary-path': () => [
    manifestFix('classify the path the same way as its prefix'),
  ],
  'outside-manifest': () => [
    manifestFix(
      'add the path to canonical (or under a canonical_prefixes entry), or remove the file from every outgoing commit',
    ),
  ],
  'unsafe-tree-entry': ({ mode }) => [
    `fix: replace the ${mode} with a regular file in every outgoing commit`,
  ],
  'invalid-tree-entry': () => [
    'fix: git ls-tree printed an unexpected line; rerun in a clean checkout',
  ],
  'proposal-document-only': () => [
    'fix: an external pull request may add one proposals/<name>.md or .txt file and change nothing else',
  ],
  'reclassified-outside-manifest-pr': () => [
    'fix: move the config/repository-boundary.json change into its own pull request',
  ],
  'changed-content-finding': ({ category, match, line, commit }) => [
    `${category}: found \`${match}\` at line ${line}; ${contentFixes[category] ?? 'remove it'}`,
    rewriteFix(commit),
    'fix: if the finding is a false positive, land the allowlist change in config/public-repository-scan.json on main first, then run git fetch and push again; the scan reads its policy from the remote main as of the last fetch',
  ],
  'missing-scan-policy': ({ subject, remote }) => [
    `fix: run git fetch ${remote} main, then push again; the content scan reads config/public-repository-scan.json from ${subject}, never from the branch being pushed`,
  ],
  'forbidden-metadata': ({ subject, violations }) => [
    ...violations.map(
      ({ id, text }) =>
        `${id}: found \`${text}\`; ${metadataFixes[id](`\`${text}\``)}`,
    ),
    metadataLocationFix(subject),
  ],
}

export class BoundaryError extends Error {
  constructor(code, subject, detail) {
    const fix = boundaryFixes[code]
    if (!fix) throw new TypeError(`no fix registered for ${code}`)
    super(
      [
        subject === undefined ? code : `${code}: ${subject}`,
        ...fix({ subject, ...detail }).map((line) => `  ${line}`),
      ].join('\n'),
    )
    this.name = 'BoundaryError'
    this.code = code
    this.subject = subject
    if (detail !== undefined) Object.assign(this, detail)
  }
}

export function loadBoundaryManifest(repo = process.cwd()) {
  return parseBoundaryManifest(
    fs.readFileSync(path.join(repo, 'config/repository-boundary.json'), 'utf8'),
  )
}

export function loadBoundaryManifestAt(git, commit) {
  return parseBoundaryManifest(
    git(['show', `${commit}:config/repository-boundary.json`]),
  )
}

function parseBoundaryManifest(source) {
  const boundary = JSON.parse(source)
  if (boundary.schema_version !== 1)
    throw new BoundaryError('unsupported-boundary-schema')
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
      throw new BoundaryError('unknown-prefix-exclusion', prefix)
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
    throw new BoundaryError('unterminated-boundary-prefix')
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
    throw new BoundaryError('duplicate-exported-path')
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
      throw new BoundaryError('invalid-classification', classification)
    for (const file of paths) {
      if (file.endsWith('/')) {
        if (classifiedPrefixes.some(({ path: prefix }) => prefix === file))
          throw new BoundaryError('duplicate-boundary-prefix', file)
        classifiedPrefixes.push({ path: file, classification })
        continue
      }
      if (classified.has(file))
        throw new BoundaryError('duplicate-boundary-path', file)
      classified.set(file, classification)
    }
  }
  for (const file of classified.keys()) {
    if (
      !allowed.has(file) &&
      !classifiedPrefixes.some(({ path: prefix }) => file.startsWith(prefix))
    )
      throw new BoundaryError('unexported-boundary-path', file)
  }
  for (const file of allowed) {
    if (
      !classified.has(file) &&
      !classifiedPrefixes.some(({ path: prefix }) => file.startsWith(prefix))
    )
      throw new BoundaryError('unclassified-exported-path', file)
  }
  for (let i = 0; i < classifiedPrefixes.length; i++)
    for (let j = i + 1; j < classifiedPrefixes.length; j++)
      if (
        classifiedPrefixes[i].path.startsWith(classifiedPrefixes[j].path) ||
        classifiedPrefixes[j].path.startsWith(classifiedPrefixes[i].path)
      )
        throw new BoundaryError(
          'ambiguous-boundary-prefix',
          classifiedPrefixes[i].path,
        )
  for (const { path: prefix, exclusions } of classifiedPrefixes)
    for (const excluded of exclusions)
      if (!excluded.startsWith(prefix) || excluded === prefix)
        throw new BoundaryError('invalid-boundary-exclusion', excluded)
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
      throw new BoundaryError('ambiguous-boundary-path', file)
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
    if (!classification) throw new BoundaryError('outside-manifest', file)
    if (mode !== 'file')
      throw new BoundaryError('unsafe-tree-entry', file, { mode })
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
      if (!match) throw new BoundaryError('invalid-tree-entry', line)
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
  const scanConfig = loadScanConfig(manifestRepo)
  for (const sha of commits) {
    if (acceptedOnTrustedTip(sha)) continue
    inspectMetadata(git(['show', '-s', '--format=%B', sha]), `commit ${sha}`)
    inspectTree(parseTree(git(['ls-tree', '-r', sha])), headManifest)
    inspectChangedContent({
      git,
      head: sha,
      changed: changedFromParents(git, sha),
      scanConfig,
    })
  }
  inspectChangedContent({
    git,
    head,
    changed: reclassified.map((file) => ({ status: 'M', path: file })),
    scanConfig,
  })
  return commits
}

export function changedFromParents(git, sha) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha])
    .trim()
    .split(/\s+/u)
    .slice(1)
  if (parents.length === 0) return changedPaths(git, EMPTY_TREE, sha)
  let changed = changedPaths(git, parents[0], sha)
  for (const parent of parents.slice(1)) {
    const alsoChanged = new Set(
      changedPaths(git, parent, sha).map((entry) => entry.path),
    )
    changed = changed.filter((entry) => alsoChanged.has(entry.path))
  }
  return changed
}

// git's well-known empty tree object, for the pathological root-commit case.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

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
    throw new BoundaryError('proposal-document-only')
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
      throw new BoundaryError('reclassified-outside-manifest-pr', file)
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

function defaultBranchScanConfig(git, remoteName) {
  let source
  try {
    source = git([
      'show',
      `refs/remotes/${remoteName}/main:config/public-repository-scan.json`,
    ])
  } catch (error) {
    if (error?.status === undefined) throw error
    throw new BoundaryError('missing-scan-policy', `${remoteName}/main`, {
      remote: remoteName,
    })
  }
  return JSON.parse(source)
}

export function inspectChangedContent({ git, head, changed, scanConfig }) {
  const compiled = compileScanConfig(scanConfig)
  for (const { status, path: file } of changed) {
    if (status === 'D') continue
    const value = git(['show', `${head}:${file}`])
    if (value.includes('\0')) continue
    const finding = scanValue(value, file, compiled)[0]
    if (finding)
      throw new BoundaryError('changed-content-finding', file, {
        category: finding.category,
        match: finding.match,
        line: finding.line,
        commit: head,
      })
  }
}

const forbidden = [
  { id: 'issue-reference', pattern: /(?<![\p{L}\p{N}_])#\d+(?!\w)/u },
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
  const violations = forbidden.flatMap(({ id, pattern }) =>
    [
      ...new Set(
        Array.from(
          value.matchAll(new RegExp(pattern, `${pattern.flags}g`)),
          (match) => match[0].trim(),
        ),
      ),
    ].map((text) => ({ id, text })),
  )
  if (violations.length)
    throw new BoundaryError('forbidden-metadata', label, { violations })
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
  const scanConfig =
    commits.length > 0 ? defaultBranchScanConfig(gitImpl, remoteName) : null
  for (const sha of commits) {
    const message = gitImpl(['show', '-s', '--format=%B', sha])
    inspectMetadata(message, `commit ${sha}`)
    inspectTree(parseTree(gitImpl(['ls-tree', '-r', sha])), manifest)
    inspectChangedContent({
      git: gitImpl,
      head: sha,
      changed: changedFromParents(gitImpl, sha),
      scanConfig,
    })
  }
  return { commits, updates: updates.length }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const readStdin = async () => {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    return input
  }
  try {
    const args = process.argv.slice(2)
    const values = (option) =>
      args.flatMap((arg, index) => (arg === option ? [args[index + 1]] : []))
    const metadataFiles = values('--metadata-file')
    for (const file of metadataFiles) {
      if (!file || file.startsWith('--'))
        throw new Error('metadata-file value is required')
      inspectMetadata(fs.readFileSync(file, 'utf8'), 'pull request')
    }
    if (
      metadataFiles.length > 0 &&
      args.every((arg, index) =>
        arg.startsWith('--')
          ? arg === '--metadata-file'
          : args[index - 1] === '--metadata-file',
      )
    ) {
      process.stdout.write('pull request metadata passed\n')
    } else if (process.argv.includes('--ci-pr')) {
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
        input: await readStdin(),
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
