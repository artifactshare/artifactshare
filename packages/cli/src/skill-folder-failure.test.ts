import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  writeSkillFolder,
  type SkillBundle,
} from './command-runners/skill-folder.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename) }
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
  await writeSkillFolder(
    join(root, '.agents/skills/artifactshare/SKILL.md'),
    bundle(1),
  )
  const destinations = vi
    .mocked(rename)
    .mock.calls.map((args) => basename(String(args[1])))
  assert.deepEqual(destinations, [
    'a.md',
    'b.md',
    '.artifactshare-managed.json',
    'SKILL.md',
  ])
})

for (const failurePath of ['references/new/b.md', 'SKILL.md'])
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
