import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
  lstat,
  realpath,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  cleanupSkillFolder,
  isProtectedLink,
  resolveSkillFolder,
  preflightFolder,
  loadSkillBundle,
  writeSkillFolder,
  removeSkillFolder,
  folderDiagnostics,
  type SkillBundle,
} from './command-runners/skill-folder.js'

async function age(path: string) {
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await utimes(path, old, old)
}
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

test('updates protect edits unless forced and repair missing owned files', async () => {
  const root = await fixture(),
    folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  await put(folder, 'references/usage.md', 'edited')
  await put(folder, 'references/user.md', 'user')
  const next = bundle(2)
  delete next.files['references/nested/detail.txt']
  next.files['references/new.md'] = 'new'
  await assert.rejects(writeSkillFolder(entry, next), /Modified/)
  await writeSkillFolder(entry, next, false, true)
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
  await assert.rejects(writeSkillFolder(entry, next), /Modified/)
  await writeSkillFolder(entry, next, false, true)
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
  await assert.rejects(
    writeSkillFolder(entry, next),
    /Modified skill file: references\/topic/,
  )
  assert.equal(
    await readFile(join(folder, 'references/topic'), 'utf8'),
    'edited owned topic',
  )
  await writeSkillFolder(entry, next, false, true)
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

test('removal and retirement preserve modified owned files and report their paths', async () => {
  const root = await fixture()
  const folder = join(root, '.agents/skills/artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  await put(folder, 'references/usage.md', 'personal edits')
  await assert.rejects(
    removeSkillFolder(entry),
    /Modified skill file: references\/usage.md/,
  )
  const next = bundle(2)
  delete next.files['references/usage.md']
  await assert.rejects(
    writeSkillFolder(entry, next),
    /Modified skill file: references\/usage.md/,
  )
  assert.equal(
    await readFile(join(folder, 'references/usage.md'), 'utf8'),
    'personal edits',
  )
  assert.equal(await readFile(entry, 'utf8'), marker(1))
  await writeSkillFolder(entry, next, false, true)
  await assert.rejects(readFile(join(folder, 'references/usage.md')), /ENOENT/)
})

for (const boundary of ['folder', 'skills', 'config'])
  test(`resolves ${boundary} aliases and keeps linked removal usable`, async () => {
    const root = await fixture()
    const destination = join(root, 'destination')
    await mkdir(destination)
    const config = join(root, '.claude')
    const link =
      boundary === 'folder'
        ? join(config, 'skills/artifactshare')
        : boundary === 'skills'
          ? join(config, 'skills')
          : config
    await mkdir(dirname(link), { recursive: true })
    await symlink(destination, link)
    const entry = join(config, 'skills/artifactshare/SKILL.md')
    const canonical = await resolveSkillFolder(entry)
    await writeSkillFolder(entry, bundle())
    assert.equal(
      await resolveSkillFolder(entry),
      await realpath(dirname(entry)),
    )
    assert.equal((await folderDiagnostics(entry, bundle())).current, true)
    await writeSkillFolder(entry, bundle(2))
    assert.equal(await readFile(join(canonical, 'SKILL.md'), 'utf8'), marker(2))
    await removeSkillFolder(entry)
    assert.equal((await lstat(link)).isSymbolicLink(), true)
    assert.deepEqual(await readdir(canonical), [])
  })

for (const kind of ['dangling', 'file'])
  test(`refuses ${kind} folder links even with force and diagnoses recovery`, async () => {
    const root = await fixture()
    const folder = join(root, '.claude/skills/artifactshare')
    const referent = join(root, 'outside')
    if (kind === 'file') await writeFile(referent, 'sentinel')
    await mkdir(dirname(folder), { recursive: true })
    await symlink(referent, folder)
    const entry = join(folder, 'SKILL.md')
    for (const force of [false, true])
      await assert.rejects(
        writeSkillFolder(entry, bundle(), force),
        /Restore or repoint/,
      )
    assert.match((await folderDiagnostics(entry, bundle())).hint!, /directory/)
    if (kind === 'file')
      assert.equal(await readFile(referent, 'utf8'), 'sentinel')
  })

for (const path of [
  'SKILL.md',
  'references',
  'references/usage.md',
  '.artifactshare-managed.json',
])
  test(`internal ${path} links are never followed or force-replaced`, async () => {
    const root = await fixture()
    const folder = join(root, '.agents/skills/artifactshare')
    const entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle())
    const outside = join(root, 'outside')
    await put(outside, 'sentinel', 'untouched')
    await rm(join(folder, path), { recursive: true })
    await symlink(
      path === 'references' ? outside : join(outside, 'sentinel'),
      join(folder, path),
    )
    await assert.rejects(
      writeSkillFolder(entry, bundle(), true),
      /regular file or directory or remove/,
    )
    await assert.rejects(
      removeSkillFolder(entry),
      /regular file or directory or remove/,
    )
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  })

test('reserved debris is ignored read-only and cleaned before directory-to-file transitions', async () => {
  const root = await fixture()
  const folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  const name = '.artifactshare-00000000-0000-4000-8000-000000000000.tmp'
  const staging = join(
    dirname(folder),
    '.artifactshare-staging-00000000-0000-4000-8000-000000000000',
  )
  await put(folder, `references/nested/${name}`, 'partial')
  await age(join(folder, `references/nested/${name}`))
  await put(folder, name, 'partial')
  await age(join(folder, name))
  await put(staging, 'partial', 'partial')
  await age(staging)
  await put(folder, '.artifactshare-almost.tmp', 'user')
  const next = bundle(2)
  delete next.files['references/nested/detail.txt']
  next.files['references/nested'] = 'flat'
  await preflightFolder(entry, next)
  await folderDiagnostics(entry, next)
  assert.equal(await readFile(join(folder, name), 'utf8'), 'partial')
  await writeSkillFolder(entry, next)
  await assert.rejects(lstat(staging), /ENOENT/)
  await assert.rejects(lstat(join(folder, name)), /ENOENT/)
  assert.equal(
    await readFile(join(folder, 'references/nested'), 'utf8'),
    'flat',
  )
  assert.equal(
    await readFile(join(folder, '.artifactshare-almost.tmp'), 'utf8'),
    'user',
  )
  await put(folder, name, 'partial')
  await age(join(folder, name))
  await cleanupSkillFolder(entry)
  await assert.rejects(lstat(join(folder, name)), /ENOENT/)
})

test('cleanup rejects internal temporary links and never follows staging links', async () => {
  const root = await fixture()
  const folder = join(root, '.agents/skills/artifactshare'),
    entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  const outside = join(root, 'outside')
  await put(outside, 'sentinel', 'untouched')
  const staging = join(
    dirname(folder),
    '.artifactshare-staging-00000000-0000-4000-8000-000000000000',
  )
  await symlink(outside, staging)
  await cleanupSkillFolder(entry)
  assert.equal((await lstat(staging)).isSymbolicLink(), true)
  await rm(staging)
  await mkdir(staging)
  await symlink(outside, join(staging, 'trap'))
  await age(staging)
  await cleanupSkillFolder(entry)
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  const temp = join(
    folder,
    '.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
  )
  await symlink(join(outside, 'sentinel'), temp)
  await assert.rejects(
    cleanupSkillFolder(entry),
    /regular file or directory or remove/,
  )
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
})

test('matching the new bundle does not authorize an edited owned reference without intent', async () => {
  const folder = join(await fixture(), 'artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  const next = bundle(2)
  next.files['references/usage.md'] = 'changed usage'
  await put(folder, 'references/usage.md', 'changed usage')
  await assert.rejects(writeSkillFolder(entry, next), /Modified skill file/)
  assert.deepEqual((await folderDiagnostics(entry, next)).modified_files, [
    'references/usage.md',
  ])
})

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
async function putIntent(
  folder: string,
  next: SkillBundle,
  previous: Record<string, string>,
) {
  await put(
    folder,
    '.artifactshare-pending.json',
    JSON.stringify({
      schema_version: 1,
      version: next.version,
      files: Object.fromEntries(
        Object.entries(next.files).map(([path, text]) => [path, digest(text)]),
      ),
      previous_files: previous,
    }),
  )
}

for (const edited of [false, true])
  test(`pending legacy entry ${edited ? 'protects edits even with update force' : 'accepts its recorded old hash'}`, async () => {
    const folder = join(await fixture(), 'artifactshare')
    const entry = join(folder, 'SKILL.md')
    const old = marker(1)
    const next = bundle(2)
    await putIntent(folder, next, { 'SKILL.md': digest(old) })
    await put(folder, 'SKILL.md', edited ? old + 'personal edits' : old)
    if (edited) {
      await assert.rejects(
        writeSkillFolder(entry, next),
        /Unowned skill file: SKILL.md/,
      )
      await assert.rejects(
        writeSkillFolder(entry, next, false, true),
        /Unowned skill file: SKILL.md/,
      )
      await removeSkillFolder(entry)
      assert.equal(await readFile(entry, 'utf8'), old + 'personal edits')
    } else {
      await writeSkillFolder(entry, next)
      assert.equal(await readFile(entry, 'utf8'), marker(2))
    }
  })

for (const record of ['files', 'previous_files'])
  test(`unmatched ${record} intent does not authorize takeover by force update or removal`, async () => {
    const folder = join(await fixture(), 'artifactshare')
    const entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle())
    const next = bundle(2)
    const path = 'references/new.md'
    if (record === 'files') next.files[path] = 'planned content'
    await putIntent(
      folder,
      next,
      record === 'previous_files' ? { [path]: digest('old content') } : {},
    )
    await put(folder, path, 'personal content')
    if (record === 'previous_files') next.files[path] = 'planned content'
    assert.ok(
      !(await folderDiagnostics(entry, next)).modified_files.includes(path),
    )
    await assert.rejects(
      writeSkillFolder(entry, next, false, true),
      /Unowned skill file: references\/new.md/,
    )
    await removeSkillFolder(entry)
    assert.equal(await readFile(join(folder, path), 'utf8'), 'personal content')
  })

for (const location of ['sibling', 'internal'])
  test(`cleanup preserves fresh ${location} staging and legacy temps, then removes old debris`, async () => {
    const root = await fixture()
    const folder = join(root, 'artifactshare')
    const entry = join(folder, 'SKILL.md')
    await writeSkillFolder(entry, bundle())
    const staging = join(
      location === 'sibling' ? root : folder,
      '.artifactshare-staging-00000000-0000-4000-8000-000000000000',
    )
    const temp = join(
      folder,
      'references/.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
    )
    await put(staging, 'payload', 'in progress')
    await writeFile(temp, 'in progress')
    await writeSkillFolder(entry, bundle(2))
    assert.equal(
      await readFile(join(staging, 'payload'), 'utf8'),
      'in progress',
    )
    assert.equal(await readFile(temp, 'utf8'), 'in progress')
    await age(staging)
    await age(temp)
    await writeSkillFolder(entry, bundle(3))
    await assert.rejects(lstat(staging), /ENOENT/)
    await assert.rejects(lstat(temp), /ENOENT/)
  })

test('a fresh legacy temp delays a directory replacement without removing active data', async () => {
  const folder = join(await fixture(), 'artifactshare')
  const entry = join(folder, 'SKILL.md')
  await writeSkillFolder(entry, bundle())
  const temp = join(
    folder,
    'references/nested/.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
  )
  await writeFile(temp, 'in progress')
  const next = bundle(2)
  delete next.files['references/nested/detail.txt']
  next.files['references/nested'] = 'flat'
  await assert.rejects(
    writeSkillFolder(entry, next),
    /Recent skill temporary file/,
  )
  assert.equal(await readFile(temp, 'utf8'), 'in progress')
  await age(temp)
  await writeSkillFolder(entry, next)
  assert.equal(
    await readFile(join(folder, 'references/nested'), 'utf8'),
    'flat',
  )
})

for (const source of ['manifest', 'pending', 'previous']) {
  test(`protects retired ${source} paths even when the bundle no longer includes them`, async () => {
    const root = await fixture()
    const folder = join(root, 'artifactshare')
    const entry = join(folder, 'SKILL.md')
    const previous = bundle()
    previous.files['references/retired.md'] = 'retired'
    await writeSkillFolder(entry, previous)
    const owned = JSON.parse(
      await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
    )
    if (source !== 'manifest') {
      const files = { ...owned.files }
      delete owned.files['references/retired.md']
      await put(folder, '.artifactshare-managed.json', JSON.stringify(owned))
      await put(
        folder,
        '.artifactshare-pending.json',
        JSON.stringify({
          ...owned,
          ...(source === 'pending' ? { files } : { previous_files: files }),
        }),
      )
    }
    await rm(join(folder, 'references/retired.md'))
    const outside = join(root, 'sentinel')
    await writeFile(outside, 'untouched')
    await symlink(outside, join(folder, 'references/retired.md'))
    for (const operation of [
      () => writeSkillFolder(entry, bundle(2), true),
      () => removeSkillFolder(entry, false, bundle(2)),
    ])
      await assert.rejects(
        operation(),
        /references\/retired.md.*regular file or directory or remove/,
      )
    assert.equal(await readFile(outside, 'utf8'), 'untouched')
  })
}

test('protected link identity uses filesystem name resolution without following links', async () => {
  const root = await fixture()
  const link = join(root, 'skill.md')
  await symlink(join(root, 'missing'), link)
  const item = await lstat(link)
  const lookups: string[] = []
  const lookup = async (path: string) => {
    lookups.push(path)
    return path.toLowerCase() === link.toLowerCase() ? item : null
  }
  assert.equal(
    await isProtectedLink(root, item, new Set(['SKILL.md']), lookup),
    true,
  )
  assert.equal(
    await isProtectedLink(
      root,
      { dev: item.dev + 1, ino: item.ino },
      new Set(['SKILL.md/child']),
      lookup,
    ),
    false,
  )
  assert.deepEqual(lookups, [join(root, 'SKILL.md'), join(root, 'SKILL.md')])
})

for (const record of [
  '.artifactshare-managed.json',
  '.artifactshare-pending.json',
])
  for (const kind of ['invalid', 'dangling'])
    test(`${kind} ${record} keeps protected-link checks strict`, async () => {
      const root = await fixture()
      const folder = join(root, 'artifactshare')
      const entry = join(folder, 'SKILL.md')
      await mkdir(folder)
      await put(root, 'outside', marker(99))
      await symlink(join(root, 'outside'), entry)
      if (kind === 'invalid') await put(folder, record, '{}')
      else await symlink(join(root, 'missing'), join(folder, record))
      assert.equal(
        (await folderDiagnostics(entry, bundle())).code,
        'skill_update_conflict',
      )
      await assert.rejects(
        preflightFolder(entry, bundle(), true),
        /regular file or directory or remove/,
      )
      await assert.rejects(
        removeSkillFolder(entry, false, bundle()),
        /regular file or directory or remove/,
      )
      assert.equal(await readFile(join(root, 'outside'), 'utf8'), marker(99))
    })

test('managed legacy rules retain protected-link diagnostics for otherwise unowned folders', async () => {
  const root = await fixture()
  const folder = join(root, 'artifactshare')
  await mkdir(folder)
  const entry = join(folder, 'SKILL.md')
  await symlink(join(root, 'missing'), entry)
  const diagnostic = await folderDiagnostics(entry, bundle(), true)
  assert.equal(diagnostic.code, 'skill_update_conflict')
  assert.match(
    diagnostic.hint!,
    /SKILL.md.*regular file or directory or remove/,
  )
})
