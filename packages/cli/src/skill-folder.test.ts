import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  loadSkillBundle,
  writeSkillFolder,
  removeSkillFolder,
  folderDiagnostics,
  type SkillBundle,
} from './command-runners/skill-folder.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-folder-'))
  roots.push(root)
  return root
}
const marker = (version: number) =>
  `<!-- artifactshare-skill\nversion: ${version}\nmanaged: true\n-->\n`
const bundle = (version = 1): SkillBundle => ({
  version,
  files: {
    'SKILL.md': marker(version),
    'references/usage.md': 'usage',
    'references/nested/detail.txt': 'details',
  },
})
async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

test('loads a nested folder without a rule, requires the entry marker and rejects case collisions', async () => {
  const root = await fixture()
  for (const [path, text] of Object.entries(bundle().files))
    await put(root, path, text)
  assert.deepEqual(await loadSkillBundle(root), bundle())
  await put(root, 'SKILL.md', 'unmanaged')
  await assert.rejects(loadSkillBundle(root), /managed marker/)
})

test('all six tool/scope folders install identical complete trees and remove only ownership', async () => {
  const root = await fixture()
  for (const scope of ['project', 'user'])
    for (const tool of ['.claude', '.agents', '.cursor']) {
      const folder = join(root, scope, tool, 'skills/artifactshare')
      const entry = join(folder, 'SKILL.md')
      await writeSkillFolder(entry, bundle())
      for (const [path, text] of Object.entries(bundle().files))
        assert.equal(await readFile(join(folder, path), 'utf8'), text)
      assert.equal((await folderDiagnostics(entry, bundle())).current, true)
      await put(folder, 'references/nested/user.txt', 'user')
      await removeSkillFolder(entry)
      assert.equal(
        await readFile(join(folder, 'references/nested/user.txt'), 'utf8'),
        'user',
      )
      assert.deepEqual(await readdir(folder), ['references'])
    }
})

test('updates replace and retire edited owned files, preserve user files and repair same-version drift', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  await put(folder, 'references/usage.md', 'edited')
  await put(folder, 'references/user.md', 'user')
  const next = bundle(2)
  delete next.files['references/nested/detail.txt']
  next.files['references/new.md'] = 'new'
  await writeSkillFolder(entry, next)
  assert.equal(
    await readFile(join(folder, 'references/usage.md'), 'utf8'),
    'usage',
  )
  await assert.rejects(
    readFile(join(folder, 'references/nested/detail.txt')),
    /ENOENT/,
  )
  assert.equal(
    await readFile(join(folder, 'references/user.md'), 'utf8'),
    'user',
  )
  await rm(join(folder, 'references/new.md'))
  await put(folder, 'references/usage.md', 'drift')
  const diagnostic = await folderDiagnostics(entry, next)
  assert.deepEqual(diagnostic.missing_files, ['references/new.md'])
  assert.deepEqual(diagnostic.different_files, ['references/usage.md'])
  assert.deepEqual(diagnostic.modified_files, [
    'references/new.md',
    'references/usage.md',
  ])
  assert.equal(diagnostic.current, false)
  await writeSkillFolder(entry, next)
  assert.equal((await folderDiagnostics(entry, next)).current, true)
  assert.equal((await folderDiagnostics(entry, bundle(3))).older_version, true)
  await writeSkillFolder(entry, next)
  await removeSkillFolder(entry)
  assert.equal(
    await readFile(join(folder, 'references/user.md'), 'utf8'),
    'user',
  )
})

test('identical unowned references conflict without adoption; explicit install takeover owns only bundled paths', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await put(folder, 'SKILL.md', marker(1))
  await put(folder, 'references/usage.md', 'usage')
  await put(folder, 'references/user.md', 'user')
  await assert.rejects(writeSkillFolder(entry, bundle()), /Unowned/)
  await assert.rejects(
    readFile(join(folder, '.artifactshare-managed.json')),
    /ENOENT/,
  )
  await removeSkillFolder(entry)
  assert.equal(
    await readFile(join(folder, 'references/usage.md'), 'utf8'),
    'usage',
  )
  await writeSkillFolder(entry, bundle(), true)
  await removeSkillFolder(entry)
  await assert.rejects(readFile(join(folder, 'references/usage.md')), /ENOENT/)
  assert.equal(
    await readFile(join(folder, 'references/user.md'), 'utf8'),
    'user',
  )
})

test('unmanaged entries and invalid/traversing metadata never authorize writes or removal', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  await put(folder, 'SKILL.md', 'user')
  await assert.rejects(writeSkillFolder(entry, bundle()))
  await assert.rejects(removeSkillFolder(entry))
  assert.equal(await readFile(entry, 'utf8'), 'user')
  await put(folder, 'SKILL.md', marker(1))
  for (const path of [
    '../outside',
    '/absolute',
    'references/../../outside',
    'references\\outside',
    'references/C:drive',
  ]) {
    await put(
      folder,
      '.artifactshare-managed.json',
      JSON.stringify({
        schema_version: 1,
        version: 1,
        files: { 'SKILL.md': 'a'.repeat(64), [path]: 'a'.repeat(64) },
      }),
    )
    assert.equal(
      (await folderDiagnostics(entry, bundle())).ownership_manifest,
      'invalid',
    )
    await assert.rejects(removeSkillFolder(entry))
    await assert.rejects(writeSkillFolder(entry, bundle()))
  }
})

test('aliased configuration roots work but target and reference links conflict without following them', async () => {
  const root = await fixture(),
    config = join(root, 'config'),
    alias = join(root, 'alias')
  await mkdir(config)
  await symlink(config, alias)
  const entry = join(alias, 'skills/artifactshare/SKILL.md')
  await writeSkillFolder(entry, bundle())
  assert.equal((await folderDiagnostics(entry, bundle())).current, true)
  const reference = join(config, 'skills/artifactshare/references/usage.md')
  await rm(reference)
  await put(root, 'outside', 'outside')
  await symlink(join(root, 'outside'), reference)
  await assert.rejects(writeSkillFolder(entry, bundle()), /Unsafe/)
  await assert.rejects(removeSkillFolder(entry), /Unsafe/)
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'outside')
})

test('diagnostics compare bytes rather than lossy UTF-8 decoding', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  const content = bundle()
  content.files['references/usage.md'] = '\ufffd'
  await writeSkillFolder(entry, content)
  await writeFile(join(folder, 'references/usage.md'), Buffer.from([255]))
  const diagnostic = await folderDiagnostics(entry, content)
  assert.deepEqual(diagnostic.different_files, ['references/usage.md'])
  assert.deepEqual(diagnostic.modified_files, ['references/usage.md'])
  assert.equal(diagnostic.current, false)
})

test('updates replace a retired owned file with nested references without adopting user paths', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  const previous = bundle()
  previous.files['references/topic'] = 'old topic'
  await writeSkillFolder(entry, previous)
  await put(folder, 'references/topic', 'edited owned topic')
  await put(folder, 'references/user.md', 'user')
  const next = bundle(2)
  next.files['references/topic/nested/detail.txt'] = 'new topic'
  await writeSkillFolder(entry, next)
  assert.equal(
    await readFile(join(folder, 'references/topic/nested/detail.txt'), 'utf8'),
    'new topic',
  )
  assert.equal((await folderDiagnostics(entry, next)).current, true)
  await writeSkillFolder(entry, next)
  await removeSkillFolder(entry)
  assert.deepEqual(await readdir(join(folder, 'references')), ['user.md'])
  assert.equal(
    await readFile(join(folder, 'references/user.md'), 'utf8'),
    'user',
  )

  await writeSkillFolder(entry, bundle())
  await put(folder, 'references/topic', 'user topic')
  await assert.rejects(writeSkillFolder(entry, next), /Unsafe/)
  assert.equal(
    await readFile(join(folder, 'references/topic'), 'utf8'),
    'user topic',
  )
  assert.equal((await folderDiagnostics(entry, bundle())).current, true)

  await rm(join(folder, 'references/topic'))
  await writeSkillFolder(entry, previous)
  await rm(join(folder, 'references/topic'))
  await put(root, 'outside', 'outside')
  await symlink(join(root, 'outside'), join(folder, 'references/topic'))
  await assert.rejects(writeSkillFolder(entry, next), /Unsafe/)
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'outside')
})

test('owned directories become files, but user additions block the entire update', async () => {
  const root = await fixture()
  const folder = join(root, '.agents/skills/artifactshare')
  const entry = join(folder, 'SKILL.md')
  const next = bundle(2)
  delete next.files['references/nested/detail.txt']
  next.files['references/nested'] = 'flat reference'
  await writeSkillFolder(entry, bundle())
  await put(folder, 'references/nested/user.txt', 'user')
  await assert.rejects(
    writeSkillFolder(entry, next),
    /Unowned.*references\/nested\/user.txt/,
  )
  assert.equal((await folderDiagnostics(entry, bundle())).current, true)
  assert.equal(
    await readFile(join(folder, 'references/nested/user.txt'), 'utf8'),
    'user',
  )
  await rm(join(folder, 'references/nested/user.txt'))
  await writeSkillFolder(entry, next)
  assert.equal(
    await readFile(join(folder, 'references/nested'), 'utf8'),
    'flat reference',
  )
  assert.equal((await folderDiagnostics(entry, next)).current, true)
  await writeSkillFolder(entry, bundle())
  assert.equal((await folderDiagnostics(entry, bundle())).current, true)
})

test('force reinstall recovers a manifest committed before the entry without trusting invalid ownership', async () => {
  const root = await fixture()
  const folder = join(root, '.agents/skills/artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle(2))
  await put(folder, 'SKILL.md', marker(1))
  await put(folder, 'references/user.txt', 'user')
  await assert.rejects(
    writeSkillFolder(entry, bundle(2)),
    /ownership.*artifactshare-managed/,
  )
  await writeSkillFolder(entry, bundle(2), true)
  assert.equal((await folderDiagnostics(entry, bundle(2))).current, true)
  assert.equal(
    await readFile(join(folder, 'references/user.txt'), 'utf8'),
    'user',
  )
  await put(folder, 'SKILL.md', 'user entry')
  await assert.rejects(
    writeSkillFolder(entry, bundle(2)),
    /SKILL.md.*user-edited/,
  )
})
