import {
  mkdir,
  writeFile,
  readFile,
  cp,
  symlink,
  mkdtemp,
  rm,
  readdir,
  lstat,
  access,
  chmod,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { walkthroughCliEnvironment } from '../walkthrough-cli-environment.mjs'
import { fingerprint, repository, skillLocation } from './plan.mjs'

export async function privateFile(path, data) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, data, { mode: 0o600 })
  await chmod(path, 0o600)
}
export async function temporary(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  await chmod(path, 0o700)
  return path
}
export async function copyFiles(root, files) {
  for (const [path, content] of Object.entries(files))
    await privateFile(join(root, path), content)
}
export async function overlay(
  version,
  checkout = join(repository, 'packages/cli'),
) {
  try {
    await access(join(checkout, 'dist/index.js'))
  } catch {
    throw new Error(
      'Build the CLI first: pnpm --filter @artifactshare/cli build',
    )
  }
  const files = { ...version.files }
  const derivedCompanion = false
  let markerVersion
  for (const name of ['SKILL.md']) {
    const block = files[name].match(
      /<!--\s*artifactshare-skill\b([\s\S]*?)-->/u,
    )?.[1]
    const number = block?.match(/(?:^|\n)\s*version:\s*(\d+)\s*(?:\n|$)/u)?.[1]
    if (
      !number ||
      !/(?:^|\n)\s*managed:\s*true\s*(?:\n|$)/u.test(block) ||
      (markerVersion && markerVersion !== number)
    )
      throw new Error(
        'Selected skill needs a managed artifactshare-skill version marker in SKILL.md',
      )
    markerVersion = number
  }
  const root = await temporary('skill-eval-overlay-')
  try {
    await cp(join(checkout, 'dist'), join(root, 'dist'), { recursive: true })
    const metadata = JSON.parse(
      await readFile(join(checkout, 'package.json'), 'utf8'),
    )
    await privateFile(join(root, 'package.json'), JSON.stringify(metadata))
    await symlink(join(checkout, 'node_modules'), join(root, 'node_modules'))
    await copyFiles(join(root, 'skills/artifactshare'), files)
    return {
      root,
      target: join(root, 'dist/index.js'),
      derivedCompanion,
      files,
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
export function environments({
  root,
  baseUrl,
  token,
  inherited = process.env,
}) {
  const base = walkthroughCliEnvironment({
    tempDir: root,
    token,
    env: inherited,
  }).env
  for (const name of Object.keys(base))
    if (
      /^(?:CLAUDECODE$|CLAUDE_|CODEX_|CURSOR_|AGENTS_|ANTHROPIC_|OPENAI_)/u.test(
        name,
      )
    )
      delete base[name]
  const home = join(root, 'home')
  const agent = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    ZDOTDIR: home,
    CODEX_HOME: join(root, 'codex'),
    // HOME alone selects Claude's default config and existing Keychain identity.
    CURSOR_CONFIG_DIR: join(home, '.cursor'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ARTIFACTSHARE_BASE_URL: baseUrl,
    ARTIFACTSHARE_CONFIG_HOME: join(root, 'cli-config'),
    PATH: `${join(root, 'bin')}:${inherited.PATH ?? ''}`,
  }
  delete agent.ARTIFACTSHARE_TOKEN
  delete agent.NODE_TLS_REJECT_UNAUTHORIZED
  delete agent.NODE_OPTIONS
  delete agent.NODE_PATH
  return {
    agent,
    cli: {
      ...agent,
      ARTIFACTSHARE_TOKEN: token,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  }
}
export async function createRun({
  agent,
  version,
  selectedOverlay,
  baseUrl,
  token,
  realHome = homedir(),
  inherited,
  linkCredentials = true,
}) {
  const root = await temporary('skill-eval-run-')
  try {
    const workdir = join(root, 'work')
    for (const dir of ['home', 'work', 'codex', 'bin', 'cli-config'])
      await mkdir(join(root, dir), { mode: 0o700 })
    const env = environments({ root, baseUrl, token, inherited })
    // Login startup may reorder PATH (macOS path_helper); restore our shims.
    for (const profile of ['.zprofile', '.bash_profile', '.profile'])
      await privateFile(
        join(root, 'home', profile),
        'export PATH="$HOME/../bin:$PATH"\n',
      )
    if (linkCredentials) {
      const source =
        agent === 'codex'
          ? join(realHome, '.codex/auth.json')
          : join(realHome, 'Library/Keychains')
      await access(source)
      const target =
        agent === 'codex'
          ? join(root, 'codex/auth.json')
          : join(root, 'home/Library/Keychains')
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
      await symlink(source, target)
      if (agent === 'cursor') {
        const configSource = join(realHome, '.cursor/cli-config.json')
        await access(configSource)
        await mkdir(join(root, 'home/.cursor'), {
          recursive: true,
          mode: 0o700,
        })
        await symlink(configSource, join(root, 'home/.cursor/cli-config.json'))
      }
    }
    const location = skillLocation(agent, version)
    const projectFiles = Object.fromEntries(
      Object.entries(version.files).filter(
        ([name]) => name === 'SKILL.md' || name.startsWith('references/'),
      ),
    )
    if (location.endsWith('.mdc'))
      await privateFile(
        join(workdir, location),
        version.files['artifactshare.mdc'],
      )
    else await copyFiles(join(workdir, location), projectFiles)
    const config = {
      target: selectedOverlay.target,
      baseUrl,
      token,
      root,
      fingerprint: version.fingerprint,
      log: join(root, 'actions.jsonl'),
      files: selectedOverlay.files,
      workdir,
    }
    await privateFile(join(root, 'launcher.json'), JSON.stringify(config))
    const launcherSource = join(import.meta.dirname, 'launcher.mjs')
    for (const bin of ['artifactshare', 'npm', 'npx', 'pnpm', 'bunx']) {
      const path = join(root, 'bin', bin)
      // JSON literals are JavaScript source, not shell interpolation.
      await privateFile(
        path,
        `#!${process.execPath}\nimport { launch } from ${JSON.stringify(launcherSource)}; await launch(${JSON.stringify(join(root, 'launcher.json'))}, ${JSON.stringify(bin)});\n`,
      )
      await chmod(path, 0o700)
    }
    return {
      root,
      workdir,
      env,
      config,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
export async function inventory(
  root,
  expectedFiles,
  { live = false, io = { readdir, lstat, readFile } } = {},
) {
  const marker = expectedFiles['SKILL.md']?.match(
    /<!--\s*artifactshare-skill([\s\S]*?)-->/u,
  )?.[1]
  const version = marker?.match(/(?:^|\n)\s*version:\s*(\d+)\s*(?:\n|$)/u)?.[1]
  const expectedManifest =
    version && /(?:^|\n)\s*managed:\s*true\s*(?:\n|$)/u.test(marker)
      ? JSON.stringify(
          {
            schema_version: 1,
            version: Number(version),
            files: Object.fromEntries(
              Object.entries(expectedFiles)
                .filter(
                  ([path]) =>
                    path === 'SKILL.md' || path.startsWith('references/'),
                )
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([path, content]) => [path, fingerprint(content)]),
            ),
          },
          null,
          2,
        ) + '\n'
      : undefined
  const expectedContents = {
    ...expectedFiles,
    '.artifactshare-managed.json': expectedManifest,
  }
  const files = []
  const errors = []
  const vanished = []
  const recordError = (path, error) =>
    errors.push({
      path: relative(root, path),
      code: error.code ?? 'inspection_failed',
    })
  async function walk(dir, required = false) {
    let entries
    try {
      entries = await io.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT' || required) recordError(dir, error)
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const name = relative(root, path)
      const inSkill = /(?:^|\/)artifactshare(?:\/|\.mdc$|$)/u.test(name)
      // Installer staging files are not active skills or reference assets.
      if (/^\.artifactshare-[a-z\d-]+\.tmp$/iu.test(entry.name)) continue
      if (entry.isSymbolicLink()) {
        if (inSkill) recordError(path, { code: 'uninspected_skill_symlink' })
        continue
      }
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!inSkill && !/^(?:SKILL\.md|artifactshare\.mdc)$/u.test(entry.name))
        continue
      try {
        // Re-read if an ordinary writer changed the file during observation.
        const before = await io.lstat(path)
        if (before.isSymbolicLink()) {
          recordError(path, { code: 'uninspected_skill_symlink' })
          continue
        }
        let content = await io.readFile(path)
        const after = await io.lstat(path)
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          content = await io.readFile(path)
        const selectedPath =
          name.match(/(?:^|\/)artifactshare\/(.+)$/u)?.[1] ??
          (entry.name === 'artifactshare.mdc'
            ? 'artifactshare.mdc'
            : 'SKILL.md')
        if (
          entry.name === 'SKILL.md' &&
          !name.includes('/artifactshare/') &&
          !content.includes('artifactshare-skill')
        )
          continue
        const expectedContent =
          expectedContents[selectedPath] === undefined
            ? undefined
            : Buffer.from(expectedContents[selectedPath])
        const expected = expectedContent?.equals(content) ?? false
        // writeFile truncates before copying. A prefix seen during a live poll
        // is retained as pending, then resolved by a post-action/final snapshot.
        const pending =
          live &&
          !expected &&
          expectedContent !== undefined &&
          content.length < expectedContent.length &&
          expectedContent.subarray(0, content.length).equals(content)
        files.push({
          path: name,
          fingerprint: fingerprint(content),
          expected,
          pending,
          scope:
            name.startsWith('home/') || name.startsWith('codex/')
              ? 'user'
              : name.startsWith('work/')
                ? 'project'
                : 'unknown',
          location: name.startsWith('codex/')
            ? 'codex'
            : (name.match(/\.(claude|agents|cursor)\//u)?.[1] ?? 'unknown'),
        })
      } catch (error) {
        // Rename/unlink churn is local to this entry, not a failed directory.
        if (error.code === 'ENOENT') vanished.push(name)
        else recordError(path, error)
      }
    }
  }
  for (const folder of ['home', 'work', 'codex'])
    await walk(join(root, folder), true)
  return {
    files,
    errors,
    vanished,
    settled: !live,
    complete: errors.length === 0,
  }
}
export function observe(history, snapshot) {
  history.pending ??= {}
  for (const file of snapshot.files) {
    if (
      !history.files.some(
        (old) =>
          old.path === file.path &&
          old.fingerprint === file.fingerprint &&
          Boolean(old.pending) === Boolean(file.pending),
      )
    ) {
      history.files.push({
        ...file,
        change: !history.initialized
          ? 'initial'
          : history.files.some((old) => old.path === file.path)
            ? 'changed'
            : 'created',
      })
    }
    if (file.pending) history.pending[file.path] = file.fingerprint
    else delete history.pending[file.path]
  }
  history.vanished = [
    ...new Set([...(history.vanished ?? []), ...(snapshot.vanished ?? [])]),
  ]
  history.initialized = true
  history.errors.push(...snapshot.errors)
  history.complete &&= snapshot.complete
  history.contaminated ||= snapshot.files.some(
    (file) => !file.expected && !file.pending,
  )
  if (snapshot.settled && Object.keys(history.pending).length) {
    history.complete = false
    for (const path of Object.keys(history.pending))
      history.errors.push({ path, code: 'unresolved_partial_write' })
  }
  return history
}
