import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  writeSkillFolder,
  type SkillBundle,
} from './command-runners/skill-folder.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    mkdir: vi.fn(fs.mkdir),
    writeFile: vi.fn(fs.writeFile),
    rename: vi.fn(fs.rename),
  }
})
const marker = (version: number) =>
  `<!-- artifactshare-skill\nversion: ${version}\nmanaged: true\n-->\n`
const bundle = (version: number): SkillBundle => ({
  version,
  files: {
    'SKILL.md': marker(version),
    'references/a.md': `version ${version}`,
    'references/nested/b.md': `version ${version}`,
  },
})
let root: string
const cleanup = async () => {
  if (root) await rm(root, { recursive: true, force: true })
}
afterEach(async () => {
  vi.mocked(mkdir).mockRestore()
  vi.mocked(writeFile).mockRestore()
  vi.mocked(rename).mockRestore()
  await cleanup()
})

for (const failure of ['write', 'rename'])
  test(`failed reference ${failure} does not commit entry or manifest and cleans temporary files`, async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-failure-'))
    const folder = join(root, '.agents/skills/artifactshare'),
      entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle(1))
    const previous = await readFile(
      join(folder, '.artifactshare-managed.json'),
      'utf8',
    )
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    if (failure === 'write')
      vi.mocked(writeFile).mockImplementation(async (...args) => {
        if (String(args[0]).includes('/nested/'))
          throw new Error('synthetic reference write failure')
        return fs.writeFile(...args)
      })
    else
      vi.mocked(rename).mockImplementation(async (...args) => {
        if (String(args[1]).endsWith('/b.md'))
          throw new Error('synthetic reference rename failure')
        return fs.rename(...args)
      })
    await assert.rejects(writeSkillFolder(entry, bundle(2)), /synthetic/)
    await assert.rejects(
      readFile(join(folder, '.artifactshare-pending.json')),
      /ENOENT/,
    )
    assert.equal(await readFile(entry, 'utf8'), marker(1))
    assert.equal(
      await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
      previous,
    )
    assert.ok(
      !(await readdir(folder, { recursive: true })).some((path) =>
        path.endsWith('.tmp'),
      ),
    )
  })

test('references precede manifest and entry is always renamed last', async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-order-'))
  await mkdir(join(root, '.agents'))
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('/a.md')) {
      const intent = JSON.parse(
        await readFile(
          join(
            root,
            '.agents/skills/artifactshare/.artifactshare-pending.json',
          ),
          'utf8',
        ),
      )
      assert.equal(intent.version, 1)
      assert.deepEqual(
        intent.files,
        Object.fromEntries(
          Object.entries(bundle(1).files).map(([path, text]) => [
            path,
            createHash('sha256').update(text).digest('hex'),
          ]),
        ),
      )
    }
    return fs.rename(...args)
  })
  await writeSkillFolder(
    join(root, '.agents/skills/artifactshare/SKILL.md'),
    bundle(1),
  )
  for (const [source] of vi.mocked(rename).mock.calls) {
    assert.match(String(source), /skills\/\.artifactshare-staging-/)
    assert.ok(!String(source).includes('/artifactshare/'))
  }
  assert.ok(
    !(await readdir(join(root, '.agents/skills'))).some((name) =>
      name.startsWith('.artifactshare-staging-'),
    ),
  )
  const destinations = vi
    .mocked(rename)
    .mock.calls.map((args) => basename(String(args[1])))
  assert.deepEqual(destinations, [
    '.artifactshare-pending.json',
    'a.md',
    'b.md',
    '.artifactshare-managed.json',
    'SKILL.md',
  ])
})

for (const failurePath of [
  'references/new/b.md',
  '.artifactshare-managed.json',
  'SKILL.md',
])
  test(`failed commit at ${failurePath} rolls back new paths and permits retry`, async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-retry-'))
    const folder = join(root, '.agents/skills/artifactshare')
    const entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle(1))
    const before = await readFile(
      join(folder, '.artifactshare-managed.json'),
      'utf8',
    )
    const next = bundle(2)
    next.files['references/new/a.md'] = 'new a'
    next.files['references/new/b.md'] = 'new b'
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (String(args[1]).endsWith(`/artifactshare/${failurePath}`))
        throw new Error('synthetic commit failure')
      return fs.rename(...args)
    })
    await assert.rejects(writeSkillFolder(entry, next), /synthetic/)
    await assert.rejects(
      readFile(join(folder, '.artifactshare-pending.json')),
      /ENOENT/,
    )
    assert.equal(await readFile(entry, 'utf8'), marker(1))
    assert.equal(
      await readFile(join(folder, 'references/a.md'), 'utf8'),
      'version 1',
    )
    assert.equal(
      await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
      before,
    )
    await assert.rejects(readdir(join(folder, 'references/new')), /ENOENT/)
    assert.ok(
      !(await readdir(folder, { recursive: true })).some((path) =>
        path.endsWith('.tmp'),
      ),
    )
    vi.mocked(rename).mockImplementation(fs.rename)
    await writeSkillFolder(entry, next)
    assert.equal(await readFile(entry, 'utf8'), marker(2))
    assert.equal(
      await readFile(join(folder, 'references/new/a.md'), 'utf8'),
      'new a',
    )
  })

for (const direction of ['file-to-directory', 'directory-to-file'])
  test(`failed ${direction} transition restores ownership and can be retried`, async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-transition-'))
    const folder = join(root, '.agents/skills/artifactshare')
    const entry = join(folder, 'SKILL.md')
    const flat = bundle(1)
    flat.files['references/topic'] = 'flat'
    const nested = bundle(2)
    nested.files['references/topic/detail.md'] = 'nested'
    const [previous, next] =
      direction === 'file-to-directory' ? [flat, nested] : [nested, flat]
    await writeSkillFolder(entry, previous)
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (String(args[1]).endsWith('/SKILL.md'))
        throw new Error('synthetic entry failure')
      return fs.rename(...args)
    })
    await assert.rejects(writeSkillFolder(entry, next), /synthetic/)
    for (const [path, text] of Object.entries(previous.files))
      assert.equal(await readFile(join(folder, path), 'utf8'), text)
    vi.mocked(rename).mockImplementation(fs.rename)
    await writeSkillFolder(entry, next)
    for (const [path, text] of Object.entries(next.files))
      assert.equal(await readFile(join(folder, path), 'utf8'), text)
  })

test('ordinary retired references remain readable until replacement references are committed', async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-retirement-'))
  const folder = join(root, '.agents/skills/artifactshare')
  const entry = join(folder, 'SKILL.md')
  const previous = bundle(1)
  previous.files['references/retired.md'] = 'old reference'
  await writeSkillFolder(entry, previous)
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let observed = false
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('/b.md')) {
      assert.equal(
        await readFile(join(folder, 'references/retired.md'), 'utf8'),
        'old reference',
      )
      observed = true
    }
    return fs.rename(...args)
  })
  await writeSkillFolder(entry, bundle(2))
  assert.equal(observed, true)
  await assert.rejects(
    readFile(join(folder, 'references/retired.md')),
    /ENOENT/,
  )
  assert.equal(await readFile(entry, 'utf8'), marker(2))
})

test('EXDEV from both staging locations rolls back and removes staging before retry', async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-exdev-'))
  const folder = join(root, '.agents/skills/artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle(1))
  const before = await readFile(join(folder, '.artifactshare-managed.json'))
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('/SKILL.md'))
      throw Object.assign(new Error('cross-device commit'), { code: 'EXDEV' })
    return fs.rename(...args)
  })
  await assert.rejects(writeSkillFolder(entry, bundle(2)), { code: 'EXDEV' })
  assert.deepEqual(
    await readFile(join(folder, '.artifactshare-managed.json')),
    before,
  )
  for (const [path, text] of Object.entries(bundle(1).files))
    assert.equal(await readFile(join(folder, path), 'utf8'), text)
  assert.deepEqual(await readdir(join(root, '.agents/skills')), [
    'artifactshare',
  ])
  vi.mocked(rename).mockImplementation(fs.rename)
  await writeSkillFolder(entry, bundle(2))
})

test('force update intent retains committed hashes instead of blessing edited backup bytes', async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-intent-'))
  const folder = join(root, 'artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle(1))
  const previous = JSON.parse(
    await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
  )
  await writeFile(join(folder, 'references/a.md'), 'personal edits')
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let observed = false
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('/a.md')) {
      const intent = JSON.parse(
        await readFile(join(folder, '.artifactshare-pending.json'), 'utf8'),
      )
      assert.deepEqual(intent.previous_files, previous.files)
      observed = true
      throw new Error('synthetic interrupted force update')
    }
    return fs.rename(...args)
  })
  await assert.rejects(
    writeSkillFolder(entry, bundle(2), false, true),
    /synthetic interrupted/,
  )
  assert.equal(observed, true)
  assert.equal(
    await readFile(join(folder, 'references/a.md'), 'utf8'),
    'personal edits',
  )
})

for (const code of ['EACCES', 'EPERM', 'EROFS', 'EXDEV'])
  test(`${code} from sibling staging falls back to private internal staging`, async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'skill-staging-fallback-')),
    )
    const folder = join(root, 'artifactshare')
    const entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle(1))
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      if (
        code !== 'EXDEV' &&
        basename(String(args[0])).startsWith('.artifactshare-staging-') &&
        dirname(String(args[0])) === root
      )
        throw Object.assign(new Error('sibling staging unavailable'), { code })
      return fs.mkdir(...args)
    })
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (
        code === 'EXDEV' &&
        !String(args[0]).startsWith(`${folder}/`) &&
        String(args[1]).endsWith('/SKILL.md')
      )
        throw Object.assign(new Error('cross-device commit'), { code })
      return fs.rename(...args)
    })
    await writeSkillFolder(entry, bundle(2))
    for (const [path, text] of Object.entries(bundle(2).files))
      assert.equal(await readFile(join(folder, path), 'utf8'), text)
    assert.ok(
      vi
        .mocked(rename)
        .mock.calls.some(([source]) =>
          String(source).startsWith(`${folder}/.artifactshare-staging-`),
        ),
    )
    assert.ok(
      vi
        .mocked(mkdir)
        .mock.calls.some(
          ([path, options]) =>
            String(path).startsWith(`${folder}/.artifactshare-staging-`) &&
            typeof options === 'object' &&
            options?.mode === 0o700,
        ),
    )
    assert.ok(
      !(await readdir(root, { recursive: true })).some((path) =>
        path.includes('.artifactshare-staging-'),
      ),
    )
  })

test('a failed internal restage after EXDEV restores committed bytes and permits retry', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-restage-failure-')))
  const folder = join(root, 'artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle(1))
  const before = await readFile(join(folder, '.artifactshare-managed.json'))
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('/SKILL.md'))
      throw Object.assign(new Error('cross-device commit'), { code: 'EXDEV' })
    return fs.rename(...args)
  })
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    if (
      String(args[0]).startsWith(`${folder}/.artifactshare-staging-`) &&
      String(args[0]).endsWith('/b.md')
    )
      throw new Error('internal staging write failed')
    return fs.writeFile(...args)
  })
  await assert.rejects(
    writeSkillFolder(entry, bundle(2)),
    /internal staging write failed/,
  )
  assert.deepEqual(
    await readFile(join(folder, '.artifactshare-managed.json')),
    before,
  )
  for (const [path, text] of Object.entries(bundle(1).files))
    assert.equal(await readFile(join(folder, path), 'utf8'), text)
  assert.ok(
    !(await readdir(root, { recursive: true })).some((path) =>
      path.includes('.artifactshare-staging-'),
    ),
  )
  vi.mocked(rename).mockImplementation(fs.rename)
  vi.mocked(writeFile).mockImplementation(fs.writeFile)
  await writeSkillFolder(entry, bundle(2))
  assert.equal(await readFile(entry, 'utf8'), marker(2))
})
