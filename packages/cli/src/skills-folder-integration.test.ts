import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  lstat,
  readdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  DoctorSkillsDataSchema,
  SkillsListDataSchema,
  SkillsActionDataSchema,
} from '@artifactshare/contract'
import { loadSkillBundle } from './command-runners/skill-folder.js'
import { expectSuccess, expectFailure } from './test/helpers.js'

let root: string, work: string, home: string, overlay: string
const marker = (version: number) =>
  `<!-- artifactshare-skill\nversion: ${version}\nmanaged: true\n-->\n`
const initial = {
  'SKILL.md': marker(10),
  'references/usage.md': 'usage\n',
  'references/nested/detail.txt': 'detail\n',
}
const target = (tool = '.cursor', scope = 'project') =>
  join(scope === 'project' ? work : home, tool, 'skills/artifactshare')
const legacy = () => join(work, '.cursor/rules/artifactshare.mdc')
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
async function setBundle(files: Record<string, string>) {
  const folder = join(overlay, 'skills/artifactshare')
  await rm(folder, { recursive: true, force: true })
  for (const [path, text] of Object.entries(files))
    await put(join(folder, path), text)
}
function run(args: string[], preload?: string) {
  return spawnSync(
    process.execPath,
    [
      ...(preload ? ['--import', preload] : []),
      join(overlay, 'dist/index.js'),
      ...args,
      '--json',
    ],
    {
      cwd: work,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ARTIFACTSHARE_CONFIG_HOME: join(home, '.config'),
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        ARTIFACTSHARE_TOKEN: '',
        CI: '',
      },
    },
  )
}
const skills = (...args: string[]) => run(['skills', ...args])
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-integration-'))
  work = join(root, 'work')
  home = join(root, 'home')
  overlay = join(root, 'cli')
  await mkdir(work)
  await mkdir(home)
  await mkdir(overlay)
  await cp(join(import.meta.dirname, '../dist'), join(overlay, 'dist'), {
    recursive: true,
  })
  await cp(
    join(import.meta.dirname, '../package.json'),
    join(overlay, 'package.json'),
  )
  await symlink(
    join(import.meta.dirname, '../node_modules'),
    join(overlay, 'node_modules'),
  )
  await setBundle(initial)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('packaged folder installs all six targets and emits contract-valid folder diagnostics', async () => {
  for (const scope of ['project', 'user']) {
    const result = expectSuccess(
      skills('install', '--tool', 'claude,codex,cursor', '--scope', scope),
    )
    SkillsActionDataSchema.parse(result.data)
    for (const tool of ['.claude', '.agents', '.cursor'])
      for (const [path, text] of Object.entries(initial))
        assert.equal(
          await readFile(join(target(tool, scope), path), 'utf8'),
          text,
        )
  }
  const listed = expectSuccess(skills('list')).data
  SkillsListDataSchema.parse(listed)
  assert.ok(
    listed.targets.every(
      (item: any) =>
        item.current && item.complete && item.ownership_manifest === 'valid',
    ),
  )
  const diagnosed = expectSuccess(run(['doctor'])).data.skills
  DoctorSkillsDataSchema.parse(diagnosed)
  assert.ok(diagnosed.targets.every((item: any) => item.current))
  const repeat = expectSuccess(skills('install', '--tool', 'cursor')).data
  assert.equal(repeat.targets[0].action, 'unchanged')
})

test('list and doctor distinguish same-version drift and update repairs it', async () => {
  expectSuccess(skills('install', '--tool', 'cursor'))
  await rm(join(target(), 'references/nested/detail.txt'))
  await put(join(target(), 'references/usage.md'), 'changed')
  for (const command of [['skills', 'list'], ['doctor']]) {
    const result = expectSuccess(run(command)).data
    const data = command[0] === 'doctor' ? result.skills : result
    const item = data.targets.find(
      (candidate: any) =>
        candidate.tool === 'cursor' && candidate.scope === 'project',
    )
    assert.equal(item.complete, false)
    assert.equal(item.current, false)
    assert.equal(item.older_version, false)
    assert.deepEqual(item.missing_files, ['references/nested/detail.txt'])
    assert.deepEqual(item.different_files, ['references/usage.md'])
    assert.deepEqual(item.modified_files, [
      'references/nested/detail.txt',
      'references/usage.md',
    ])
    if (command[0] === 'doctor')
      assert.match(item.update_command, /skills install.*--force/)
  }
  expectFailure(skills('update', '--tool', 'cursor'), {
    code: 'skill_update_conflict',
  })
  const repaired = expectSuccess(
    skills('update', '--tool', 'cursor', '--force'),
  ).data
  assert.equal(repaired.targets[0].action, 'updated')
  assert.equal(
    await readFile(join(target(), 'references/usage.md'), 'utf8'),
    initial['references/usage.md'],
  )
})

test('missing managed bundle marker fails before any target write', async () => {
  await setBundle({ ...initial, 'SKILL.md': 'no marker' })
  expectFailure(skills('install', '--tool', 'cursor'))
  await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
})

test('managed legacy-only Cursor migrates after folder writes; dry run only plans cleanup', async () => {
  await put(legacy(), marker(1))
  const dry = expectSuccess(
    skills('update', '--tool', 'cursor', '--scope', 'project', '--dry-run'),
  ).data
  assert.equal(dry.targets[0].legacy_rule.action, 'would_remove')
  assert.equal(await readFile(legacy(), 'utf8'), marker(1))
  await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
  const updated = expectSuccess(
    skills('update', '--tool', 'cursor', '--scope', 'project'),
  ).data
  SkillsActionDataSchema.parse(updated)
  assert.equal(updated.targets[0].legacy_rule.action, 'removed')
  await assert.rejects(readFile(legacy()), /ENOENT/)
  assert.equal(
    await readFile(join(target(), 'references/nested/detail.txt'), 'utf8'),
    'detail\n',
  )
})

for (const command of [
  ['init'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['profiles', 'list'],
]) {
  test(`${command.join(' ')} migrates only managed project legacy rules and preserves primary results on conflict`, async () => {
    await put(legacy(), 'user rule')
    expectSuccess(run(command))
    await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
    await put(legacy(), marker(1))
    const success = expectSuccess(run(command)).data
    const actions =
      command[0] === 'skills'
        ? success.targets
        : command[0] === 'init'
          ? success.skills.targets
          : success.skills.auto_update.targets
    assert.equal(
      actions.find((item: any) => item.scope === 'project').legacy_rule.action,
      'removed',
    )
    await put(legacy(), marker(1))
    await put(join(target(), 'SKILL.md'), 'user skill')
    const failure = expectSuccess(run(command)).data
    const failed =
      command[0] === 'skills'
        ? failure.targets
        : command[0] === 'init'
          ? failure.skills.targets
          : failure.skills.auto_update.targets
    assert.equal(
      failed.find((item: any) => item.scope === 'project').action,
      'update_recommended',
    )
    assert.equal(await readFile(legacy(), 'utf8'), marker(1))
    assert.equal(
      await readFile(join(target(), 'SKILL.md'), 'utf8'),
      'user skill',
    )
  })
}

test('unmanaged legacy coexistence is diagnosed and never removed', async () => {
  await put(legacy(), 'user rule')
  const installed = expectSuccess(skills('install', '--tool', 'cursor')).data
  assert.equal(installed.targets[0].legacy_rule.action, 'kept_unmanaged')
  for (const command of [['skills', 'list'], ['doctor']]) {
    const result = expectSuccess(run(command)).data
    const item = (result.skills ?? result).targets.find(
      (candidate: any) =>
        candidate.tool === 'cursor' && candidate.scope === 'project',
    )
    assert.equal(item.legacy_rule.coexistence, true)
    assert.equal(item.legacy_rule.managed, false)
    assert.match(item.legacy_rule.hint, /manually remove/)
  }
  expectSuccess(skills('remove', '--tool', 'cursor', '--scope', 'project'))
  assert.equal(await readFile(legacy(), 'utf8'), 'user rule')
})

for (const dual of [false, true])
  test(`remove cleans managed legacy with folder present=${dual}`, async () => {
    if (dual) expectSuccess(skills('install', '--tool', 'cursor'))
    await put(legacy(), marker(1))
    const result = expectSuccess(
      skills('remove', '--tool', 'cursor', '--scope', 'project'),
    ).data
    assert.equal(result.targets[0].legacy_rule.action, 'removed')
    await assert.rejects(readFile(legacy()), /ENOENT/)
    await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
  })

test('unowned identical files and invalid metadata block mutation and migration', async () => {
  await put(legacy(), marker(1))
  await put(
    join(target(), 'references/usage.md'),
    initial['references/usage.md']!,
  )
  expectFailure(skills('update', '--tool', 'cursor', '--scope', 'project'), {
    code: 'skill_update_conflict',
  })
  assert.equal(await readFile(legacy(), 'utf8'), marker(1))
  expectSuccess(skills('install', '--tool', 'cursor', '--force'))
  await put(join(target(), '.artifactshare-managed.json'), '{broken')
  expectFailure(skills('remove', '--tool', 'cursor'), {
    code: 'skill_update_conflict',
  })
  const listed = expectSuccess(skills('list')).data.targets.find(
    (candidate: any) =>
      candidate.tool === 'cursor' && candidate.scope === 'project',
  )
  assert.equal(listed.ownership_manifest, 'invalid')
})

for (const failure of ['reference', 'legacy'])
  test(`migration reports injected ${failure} failure without claiming premature cleanup`, async () => {
    await put(legacy(), marker(1))
    const preload = join(root, 'inject.mjs')
    await put(
      preload,
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename, unlink = fs.unlink;
fs.rename = async (...args) => {
  if (${JSON.stringify(failure)} === 'reference' && String(args[1]).endsWith('/references/usage.md')) throw new Error('synthetic reference failure');
  return rename(...args);
};
fs.unlink = async (...args) => {
  if (${JSON.stringify(failure)} === 'legacy' && String(args[0]).endsWith('artifactshare.mdc')) throw new Error('synthetic cleanup failure');
  return unlink(...args);
};
syncBuiltinESMExports();
`,
    )
    const result = run(
      ['skills', 'update', '--tool', 'cursor', '--scope', 'project'],
      preload,
    )
    assert.equal(await readFile(legacy(), 'utf8'), marker(1))
    if (failure === 'reference') {
      expectFailure(result)
      await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
    } else {
      const data = expectSuccess(result).data
      assert.equal(data.targets[0].legacy_rule.action, 'remove_failed')
      assert.match(data.targets[0].legacy_rule.hint, /Retry/)
      assert.equal(
        await readFile(join(target(), 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
    }
  })

test('automatic migration never downgrades a newer legacy rule', async () => {
  await put(legacy(), marker(999))
  const result = expectSuccess(run(['profiles', 'list'])).data
  assert.equal(result.skills, undefined)
  await assert.rejects(readFile(join(target(), 'SKILL.md')), /ENOENT/)
  assert.equal(await readFile(legacy(), 'utf8'), marker(999))
})

for (const version of [10, 11])
  for (const edited of ['SKILL.md', 'references/usage.md'])
    test(`automatic paths preserve edited ${edited} with bundle version ${version}`, async () => {
      expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
      const path = join(target('.agents', 'user'), edited)
      const content = initial[edited as keyof typeof initial] + 'personal edits'
      await put(path, content)
      await setBundle({ ...initial, 'SKILL.md': marker(version) })
      for (const args of [
        ['profiles', 'list'],
        ['skills', 'ensure', '--tool', 'auto'],
        ['init'],
      ]) {
        const data = expectSuccess(run(args)).data
        assert.equal(await readFile(path, 'utf8'), content)
        const actions =
          data.skills?.auto_update?.targets ??
          data.skills?.targets ??
          data.targets
        assert.ok(
          actions?.some(
            (item: any) =>
              item.tool === 'codex' && item.action === 'update_recommended',
          ),
        )
      }
    })

test('automatic commands leave an equal-version manifestless installation unchanged', async () => {
  const entry = join(target('.agents', 'user'), 'SKILL.md')
  await put(entry, initial['SKILL.md'])
  expectSuccess(run(['profiles', 'list']))
  expectSuccess(skills('ensure', '--tool', 'auto'))
  await assert.rejects(
    readFile(join(dirname(entry), '.artifactshare-managed.json')),
    /ENOENT/,
  )
})

test('remove and update report edited retirement paths without deleting them', async () => {
  expectSuccess(skills('install', '--tool', 'cursor'))
  const path = join(target(), 'references/usage.md')
  await put(path, 'personal edits')
  for (const args of [['remove', '--dry-run'], ['remove']]) {
    const result = expectFailure(skills(...args, '--tool', 'cursor'))
    assert.match(result.error.hint, /references\/usage.md/)
    assert.equal(await readFile(path, 'utf8'), 'personal edits')
  }
  const next = { ...initial, 'SKILL.md': marker(11) }
  delete (next as Partial<typeof initial>)['references/usage.md']
  await setBundle(next)
  const result = expectFailure(skills('update', '--tool', 'cursor'))
  assert.match(result.error.hint, /references\/usage.md/)
  assert.equal(await readFile(path, 'utf8'), 'personal edits')
  expectSuccess(skills('update', '--tool', 'cursor', '--force'))
  await assert.rejects(readFile(path), /ENOENT/)
})

for (const conflict of ['invalid manifest', 'unowned reference'])
  test(`doctor recommends force install for ${conflict}`, async () => {
    expectSuccess(skills('install', '--tool', 'cursor'))
    if (conflict === 'invalid manifest') {
      await put(join(target(), '.artifactshare-managed.json'), '{}')
    } else {
      await put(join(target(), 'references/new.md'), 'user content')
      await setBundle({ ...initial, 'references/new.md': 'bundled content' })
    }
    const data = expectSuccess(run(['doctor'])).data.skills
    const item = data.targets.find(
      (candidate: any) =>
        candidate.tool === 'cursor' && candidate.scope === 'project',
    )
    assert.match(
      item.update_command,
      /skills install --tool cursor --scope project --force --json/,
    )
  })

for (const manifest of ['absent', 'invalid'])
  test(`automatic migration preserves the legacy rule when the equal-version folder manifest is ${manifest}`, async () => {
    expectSuccess(skills('install', '--tool', 'cursor'))
    const manifestPath = join(target(), '.artifactshare-managed.json')
    if (manifest === 'absent') await rm(manifestPath)
    else await put(manifestPath, '{}')
    await put(legacy(), marker(1))
    for (const args of [
      ['profiles', 'list'],
      ['skills', 'ensure', '--tool', 'auto', '--dry-run'],
      ['skills', 'ensure', '--tool', 'auto'],
      ['init'],
    ]) {
      const data = expectSuccess(run(args)).data
      const actions =
        data.skills?.auto_update?.targets ??
        data.skills?.targets ??
        data.targets
      const migration = actions.find(
        (item: any) => item.tool === 'cursor' && item.scope === 'project',
      )
      assert.equal(migration.action, 'update_recommended')
      assert.equal(migration.legacy_rule, undefined)
      assert.match(
        migration.update_command,
        /skills update --tool cursor --scope project/,
      )
      assert.equal(await readFile(legacy(), 'utf8'), marker(1))
      assert.equal(
        await readFile(join(target(), 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
      if (manifest === 'absent')
        await assert.rejects(readFile(manifestPath), /ENOENT/)
      else assert.equal(await readFile(manifestPath, 'utf8'), '{}')
    }
  })

test('automatic paths skip edited newer folders without downgrade recommendations or legacy cleanup', async () => {
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
  expectSuccess(skills('install', '--tool', 'cursor', '--scope', 'project'))
  const folders = [target('.agents', 'user'), target()]
  for (const folder of folders)
    await put(join(folder, 'references/usage.md'), 'personal edits')
  await put(legacy(), marker(1))
  await setBundle(initial)
  for (const args of [
    ['profiles', 'list'],
    ['skills', 'ensure', '--tool', 'auto'],
    ['init'],
  ]) {
    const data = expectSuccess(run(args)).data
    const actions =
      data.skills?.auto_update?.targets ??
      data.skills?.targets ??
      data.targets ??
      []
    assert.equal(
      actions.some(
        (item: any) => item.tool === 'codex' || item.scope === 'project',
      ),
      false,
    )
    for (const folder of folders) {
      assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), marker(11))
      assert.equal(
        await readFile(join(folder, 'references/usage.md'), 'utf8'),
        'personal edits',
      )
      assert.equal(
        JSON.parse(
          await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
        ).version,
        11,
      )
    }
    assert.equal(await readFile(legacy(), 'utf8'), marker(1))
    if (args[0] === 'skills') await mkdir(join(work, '.agents'))
  }
})

test('real bundled references install byte-for-byte across all six targets', async () => {
  const bundle = await loadSkillBundle(
    join(import.meta.dirname, '../skills/artifactshare'),
  )
  await setBundle(bundle.files)
  for (const scope of ['project', 'user']) {
    expectSuccess(
      skills('install', '--tool', 'claude,codex,cursor', '--scope', scope),
    )
    for (const tool of ['.claude', '.agents', '.cursor']) {
      for (const [path, content] of Object.entries(bundle.files)) {
        assert.equal(
          await readFile(join(target(tool, scope), path), 'utf8'),
          content,
        )
      }
    }
  }
})

test('shared user folders transact once and report selected aliases across commands', async () => {
  const folder = target('.agents', 'user')
  const link = target('.claude', 'user')
  await mkdir(folder, { recursive: true })
  await mkdir(dirname(link), { recursive: true })
  await symlink(folder, link)
  const log = join(root, 'commits')
  const preload = join(root, 'count.mjs')
  await writeFile(
    preload,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename; fs.rename = async (...args) => { if (String(args[1]).endsWith('/.agents/skills/artifactshare/SKILL.md')) await fs.appendFile(${JSON.stringify(log)}, 'commit\\n'); return rename(...args) }; syncBuiltinESMExports();`,
  )
  const check = (rows: any[]) => {
    const shared = rows.filter((row) =>
      row.aliases?.some(
        (alias: any) => alias.tool === 'claude' && alias.scope === 'user',
      ),
    )
    assert.equal(shared.length, 1)
    assert.deepEqual(
      shared[0].aliases.map((alias: any) => alias.tool),
      ['codex', 'claude'],
    )
    assert.ok(
      shared[0].resolved_folder_path.endsWith('/.agents/skills/artifactshare'),
    )
  }
  const installed = expectSuccess(
    run(
      ['skills', 'install', '--tool', 'claude,codex', '--scope', 'user'],
      preload,
    ),
  ).data
  check(installed.targets)
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1)
  check(expectSuccess(skills('list')).data.targets)
  check(expectSuccess(run(['doctor'])).data.skills.targets)
  await mkdir(join(work, '.claude'))
  check(expectSuccess(run(['init'])).data.skills.targets)
  check(expectSuccess(skills('ensure', '--tool', 'auto')).data.targets)
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  check(
    expectSuccess(run(['skills', 'update', '--scope', 'user'], preload)).data
      .targets,
  )
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2)
  await setBundle({ ...initial, 'SKILL.md': marker(12) })
  check(
    expectSuccess(run(['profiles', 'list'], preload)).data.skills.auto_update
      .targets,
  )
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3)
  const filtered = expectSuccess(
    skills('update', '--tool', 'claude', '--scope', 'user'),
  ).data
  assert.deepEqual(
    filtered.targets[0].aliases.map((alias: any) => alias.tool),
    ['claude'],
  )
  check(expectSuccess(skills('remove', '--scope', 'user')).data.targets)
  assert.equal((await lstat(link)).isSymbolicLink(), true)
  assert.deepEqual(await readdir(folder), [])
})

for (const command of [
  ['skills', 'install', '--tool', 'codex', '--scope', 'user'],
  ['skills', 'update', '--scope', 'user'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['profiles', 'list'],
])
  test(`${command.join(' ')} cleans reserved debris even without an update`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const folder = target('.agents', 'user')
    const temp = join(
      folder,
      'references/.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
    )
    const staging = join(
      dirname(folder),
      '.artifactshare-staging-00000000-0000-4000-8000-000000000000',
    )
    await put(temp, 'partial')
    await put(join(staging, 'partial'), 'partial')
    expectSuccess(skills('list'))
    expectSuccess(run(['doctor']))
    expectSuccess(skills('update', '--scope', 'user', '--dry-run'))
    assert.equal(await readFile(temp, 'utf8'), 'partial')
    expectSuccess(run(command))
    await assert.rejects(lstat(temp), /ENOENT/)
    await assert.rejects(lstat(staging), /ENOENT/)
  })

for (const command of [
  ['skills', 'install', '--tool', 'claude', '--scope', 'user'],
  ['skills', 'update', '--tool', 'claude', '--scope', 'user'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['profiles', 'list'],
])
  test(`${command.join(' ')} cleans legacy debris before replacing an owned directory through a link`, async () => {
    const folder = target('.agents', 'user')
    const link = target('.claude', 'user')
    await mkdir(folder, { recursive: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink(folder, link)
    expectSuccess(skills('install', '--tool', 'claude', '--scope', 'user'))
    const temp = join(
      folder,
      'references/nested/.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
    )
    await put(temp, 'partial')
    const next: Record<string, string> = {
      ...initial,
      'SKILL.md': marker(11),
      'references/nested': 'flat',
    }
    delete next['references/nested/detail.txt']
    await setBundle(next)
    expectSuccess(run(command))
    assert.equal(
      await readFile(join(folder, 'references/nested'), 'utf8'),
      'flat',
    )
  })

for (const kind of ['dangling', 'file', 'entry'])
  test(`${kind} links have repair guidance in explicit mutations and read-only diagnostics`, async () => {
    const folder = target('.claude', 'user')
    const outside = join(root, 'outside')
    if (kind === 'entry') {
      expectSuccess(skills('install', '--tool', 'claude', '--scope', 'user'))
      await rm(join(folder, 'SKILL.md'))
      await put(outside, initial['SKILL.md'])
      await symlink(outside, join(folder, 'SKILL.md'))
    } else {
      await mkdir(dirname(folder), { recursive: true })
      if (kind === 'file') await put(outside, 'untouched')
      await symlink(outside, folder)
    }
    for (const action of ['install', 'update']) {
      for (const force of [[], ['--force']]) {
        const result = expectFailure(
          skills(action, '--tool', 'claude', '--scope', 'user', ...force),
        )
        assert.equal(result.error.code, 'skill_update_conflict')
        assert.match(
          result.error.hint,
          kind === 'entry' ? /internal link/ : /Restore or repoint/,
        )
      }
    }
    for (const args of [['skills', 'list'], ['doctor']]) {
      const data = expectSuccess(run(args)).data
      const row = (data.skills ?? data).targets.find(
        (item: any) => item.tool === 'claude' && item.scope === 'user',
      )
      assert.equal(row.current, false)
      assert.equal(row.code, 'skill_update_conflict')
      assert.match(
        row.hint,
        kind === 'entry' ? /internal link/ : /Restore or repoint/,
      )
    }
    const automatic = expectSuccess(run(['profiles', 'list'])).data.skills
      .auto_update.targets
    assert.equal(automatic[0].action, 'update_recommended')
    assert.ok(automatic[0].hint)
    if (kind !== 'dangling')
      assert.equal(
        await readFile(outside, 'utf8'),
        kind === 'file' ? 'untouched' : initial['SKILL.md'],
      )
  })

test('unresolvable folders retain separate aliases when init adds automatic targets', async () => {
  for (const tool of ['.agents', '.claude']) {
    const folder = target(tool, 'user')
    await mkdir(dirname(folder), { recursive: true })
    await symlink(join(root, `missing-${tool}`), folder)
  }
  const rows = expectSuccess(run(['init'])).data.skills.targets.filter(
    (row: any) => row.action === 'update_recommended',
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row: any) => row.aliases.map((alias: any) => alias.tool)),
    [['codex'], ['claude']],
  )
  assert.ok(
    rows.every((row: any) => row.resolved_folder_path === null && row.hint),
  )
})

async function sharedCursorFolder(scope: 'project' | 'user') {
  const folder = target('.agents', scope)
  await mkdir(folder, { recursive: true })
  await mkdir(dirname(target()), { recursive: true })
  await symlink(folder, target())
  return folder
}

function sharedCursorRow(rows: any[]) {
  const shared = rows.filter((row: any) =>
    row.aliases.some(
      (alias: any) => alias.tool === 'cursor' && alias.scope === 'project',
    ),
  )
  assert.equal(shared.length, 1)
  assert.equal(shared[0].tool, 'codex')
  assert.deepEqual(
    shared[0].aliases.map((alias: any) => alias.tool),
    ['codex', 'cursor'],
  )
  return shared[0]
}

for (const managed of [false, true])
  test(`shared Cursor diagnostics retain legacy rule metadata (managed=${managed})`, async () => {
    await sharedCursorFolder('project')
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'project'))
    await put(legacy(), managed ? marker(1) : 'personal rule')
    for (const command of [['skills', 'list'], ['doctor']]) {
      const data = expectSuccess(run(command)).data
      const row = sharedCursorRow((data.skills ?? data).targets)
      assert.equal(row.legacy_rule.path, '.cursor/rules/artifactshare.mdc')
      assert.equal(row.legacy_rule.present, true)
      assert.equal(row.legacy_rule.managed, managed)
      assert.equal(row.legacy_rule.coexistence, true)
      assert.equal(row.current, true)
      if (!managed) assert.match(row.legacy_rule.hint, /manually remove/)
    }
    assert.equal(
      await readFile(legacy(), 'utf8'),
      managed ? marker(1) : 'personal rule',
    )
  })

for (const command of ['install', 'update', 'ensure', 'remove'])
  test(`shared Cursor ${command} processes its legacy rule once after the folder transaction`, async () => {
    const folder = await sharedCursorFolder('project')
    await put(legacy(), marker(1))
    const log = join(root, 'cursor-transactions')
    const preload = join(root, 'cursor-transactions.mjs')
    await writeFile(
      preload,
      `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename, unlink = fs.unlink;
fs.rename = async (...args) => { if (String(args[1]).endsWith('/.agents/skills/artifactshare/SKILL.md')) { await fs.access(${JSON.stringify(legacy())}); await fs.appendFile(${JSON.stringify(log)}, 'entry\\n') }; return rename(...args) };
fs.unlink = async (...args) => { if (String(args[0]).endsWith('rules/artifactshare.mdc')) await fs.appendFile(${JSON.stringify(log)}, 'legacy\\n'); return unlink(...args) }; syncBuiltinESMExports();`,
    )
    const args = [
      'skills',
      command,
      '--tool',
      'codex,cursor',
      '--scope',
      'project',
    ]
    const dry = sharedCursorRow(
      expectSuccess(run([...args, '--dry-run'], preload)).data.targets,
    )
    assert.equal(dry.legacy_rule.action, 'would_remove')
    assert.equal(await readFile(legacy(), 'utf8'), marker(1))
    await assert.rejects(readFile(log), /ENOENT/)
    const row = sharedCursorRow(expectSuccess(run(args, preload)).data.targets)
    assert.equal(row.legacy_rule.action, 'removed')
    assert.equal(row.action, command === 'remove' ? 'removed' : 'installed')
    assert.deepEqual(
      (await readFile(log, 'utf8')).trim().split('\n'),
      command === 'remove' ? ['legacy'] : ['entry', 'legacy'],
    )
    await assert.rejects(readFile(legacy()), /ENOENT/)
    assert.equal((await lstat(target())).isSymbolicLink(), true)
    if (command !== 'remove')
      assert.equal(
        await readFile(join(folder, 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
  })

for (const command of [
  ['init'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['profiles', 'list'],
])
  for (const installed of [false, true])
    test(`${command.join(' ')} migrates shared Cursor project rules under a user primary (installed=${installed})`, async () => {
      const folder = await sharedCursorFolder('user')
      if (installed)
        expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
      await put(legacy(), marker(1))
      const data = expectSuccess(run(command)).data
      const row = sharedCursorRow(
        data.skills?.auto_update?.targets ??
          data.skills?.targets ??
          data.targets,
      )
      assert.equal(row.scope, 'user')
      assert.equal(row.legacy_rule.action, 'removed')
      assert.equal(
        await readFile(join(folder, 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
      await assert.rejects(readFile(legacy()), /ENOENT/)
    })

test('shared Cursor migration respects selected aliases and retains unmanaged rules', async () => {
  await sharedCursorFolder('project')
  await put(legacy(), marker(1))
  const filtered = expectSuccess(skills('install', '--tool', 'codex')).data
    .targets[0]
  assert.equal(filtered.legacy_rule, undefined)
  assert.deepEqual(
    filtered.aliases.map((alias: any) => alias.tool),
    ['codex'],
  )
  assert.equal(await readFile(legacy(), 'utf8'), marker(1))
  await put(legacy(), 'personal rule')
  for (const command of ['update', 'remove']) {
    const row = sharedCursorRow(
      expectSuccess(
        skills(command, '--tool', 'codex,cursor', '--scope', 'project'),
      ).data.targets,
    )
    assert.equal(row.legacy_rule.action, 'kept_unmanaged')
    assert.equal(await readFile(legacy(), 'utf8'), 'personal rule')
  }
})

for (const command of [
  ['init'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['profiles', 'list'],
])
  for (const selected of [true, false])
    test(`${command.join(' ')} (selected=${selected}) reports cleanup failure on a current skill without failing`, async () => {
      expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
      if (!selected) await mkdir(join(work, '.claude'))
      const folder = await realpath(target('.agents', 'user'))
      const temp = join(
        folder,
        '.artifactshare-12345678-1234-1234-1234-123456789abc.tmp',
      )
      await put(temp, 'stale')
      const preload = join(root, 'inject.mjs')
      await put(
        preload,
        `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const unlink = fs.unlink;
fs.unlink = async (...args) => {
  if (String(args[0]) === ${JSON.stringify(temp)}) throw new Error('EACCES: cannot unlink ' + args[0]);
  return unlink(...args);
};
syncBuiltinESMExports();
`,
      )
      const data = expectSuccess(run(command, preload)).data
      const row = (
        data.skills?.auto_update?.targets ??
        data.skills?.targets ??
        data.targets
      ).find((item: any) => item.tool === 'codex' && item.scope === 'user')
      assert.equal(row.action, 'update_recommended')
      assert.equal(row.path, join(target('.agents', 'user'), 'SKILL.md'))
      assert.ok(row.hint.includes(temp))
      assert.equal(await readFile(temp, 'utf8'), 'stale')
      assert.equal(
        await readFile(join(folder, 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
    })

async function pendingIntent(
  folder: string,
  files: Record<string, string>,
  version: number,
) {
  await put(
    join(folder, '.artifactshare-pending.json'),
    JSON.stringify({
      schema_version: 1,
      version,
      files: Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          path,
          createHash('sha256').update(text).digest('hex'),
        ]),
      ),
    }),
  )
}

for (const command of [
  ['skills', 'update', '--tool', 'codex', '--scope', 'user'],
  ['profiles', 'list'],
])
  test(`${command.join(' ')} resumes a reference committed before the manifest`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const folder = target('.agents', 'user')
    const next = {
      ...initial,
      'SKILL.md': marker(11),
      'references/usage.md': 'new usage\n',
    }
    await setBundle(next)
    const reference = join(folder, 'references/usage.md')
    const manifest = join(folder, '.artifactshare-managed.json')
    const previousManifest = await readFile(manifest, 'utf8')
    await pendingIntent(folder, next, 11)
    await put(reference, next['references/usage.md'])
    expectSuccess(run(command))
    assert.equal(
      await readFile(join(folder, 'SKILL.md'), 'utf8'),
      next['SKILL.md'],
    )
    assert.equal(await readFile(reference, 'utf8'), next['references/usage.md'])
    assert.notEqual(await readFile(manifest, 'utf8'), previousManifest)

    await put(reference, 'personal edits')
    await setBundle({ ...next, 'SKILL.md': marker(12) })
    const refused = expectFailure(
      skills('update', '--tool', 'codex', '--scope', 'user'),
    )
    assert.match(refused.error.hint, /Modified skill file/)
    const automatic = expectSuccess(run(['profiles', 'list'])).data.skills
      .auto_update.targets
    assert.equal(
      automatic.find((item: any) => item.tool === 'codex').action,
      'update_recommended',
    )
    assert.equal(await readFile(reference, 'utf8'), 'personal edits')
  })

for (const command of ['update', 'remove'])
  for (const installed of [false, true])
    test(`${command} leaves debris in ${installed ? 'unmanaged' : 'missing'} targets untouched`, async () => {
      const folder = target('.agents', 'user')
      if (installed) await put(join(folder, 'SKILL.md'), 'personal skill')
      const temp = join(
        folder,
        '.artifactshare-12345678-1234-1234-1234-123456789abc.tmp',
      )
      await put(temp, 'stale')
      expectSuccess(skills(command, '--tool', 'codex', '--scope', 'user'))
      assert.equal(await readFile(temp, 'utf8'), 'stale')
    })

for (const command of [
  ['skills', 'update', '--tool', 'codex', '--scope', 'user'],
  ['profiles', 'list'],
])
  for (const replacement of [false, true])
    test(`${command.join(' ')} recovers a committed ${replacement ? 'directory replacement' : 'new reference'} before the manifest`, async () => {
      expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
      const folder = target('.agents', 'user')
      const path = replacement ? 'references/nested' : 'references/new.md'
      const next: Record<string, string> = {
        ...initial,
        'SKILL.md': marker(11),
        [path]: 'new reference\n',
      }
      if (replacement) {
        delete next['references/nested/detail.txt']
        await rm(join(folder, path), { recursive: true })
      }
      await setBundle(next)
      const manifest = join(folder, '.artifactshare-managed.json')
      const previousManifest = await readFile(manifest, 'utf8')
      const reference = join(folder, path)
      await pendingIntent(folder, next, 11)
      await put(reference, 'personal edits')
      const refusal = expectFailure(
        skills('update', '--tool', 'codex', '--scope', 'user'),
      )
      assert.equal(refusal.error.code, 'skill_update_conflict')
      const warning = expectSuccess(run(['profiles', 'list'])).data.skills
        .auto_update.targets
      assert.equal(
        warning.find((item: any) => item.tool === 'codex').action,
        'update_recommended',
      )
      assert.equal(await readFile(reference, 'utf8'), 'personal edits')
      assert.equal(await readFile(manifest, 'utf8'), previousManifest)

      await put(reference, next[path]!)
      await put(join(folder, 'references/personal.md'), 'unrelated addition')
      const diagnosed = expectSuccess(run(['doctor'])).data.skills.targets.find(
        (item: any) => item.tool === 'codex' && item.scope === 'user',
      )
      assert.equal(diagnosed.interrupted_update, true)
      assert.match(diagnosed.update_command, /skills update/)
      expectSuccess(run(command))
      await assert.rejects(
        readFile(join(folder, '.artifactshare-pending.json')),
        /ENOENT/,
      )
      assert.equal(
        await readFile(join(folder, 'SKILL.md'), 'utf8'),
        next['SKILL.md'],
      )
      assert.equal(await readFile(reference, 'utf8'), next[path])
      assert.notEqual(await readFile(manifest, 'utf8'), previousManifest)
      assert.equal(
        await readFile(join(folder, 'references/personal.md'), 'utf8'),
        'unrelated addition',
      )
      const listed = expectSuccess(skills('list')).data.targets.find(
        (item: any) => item.tool === 'codex' && item.scope === 'user',
      )
      assert.equal(listed.current, true)
    })

for (const replacement of [false, true])
  test(`remove consumes interrupted ${replacement ? 'replacement' : 'addition'} intent`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const folder = target('.agents', 'user')
    const path = replacement ? 'references/nested' : 'references/new.md'
    const next = { ...initial, 'SKILL.md': marker(11), [path]: 'new reference' }
    if (replacement) await rm(join(folder, path), { recursive: true })
    await pendingIntent(folder, next, 11)
    await put(join(folder, path), 'new reference')
    expectSuccess(skills('remove', '--tool', 'codex', '--scope', 'user'))
    await assert.rejects(readFile(join(folder, path)), /ENOENT/)
    await assert.rejects(
      readFile(join(folder, '.artifactshare-pending.json')),
      /ENOENT/,
    )
  })

for (const manifestCommitted of [false, true])
  test(`automatic recovery consumes intent with ${manifestCommitted ? 'new manifest and old entry' : 'same-version content'}`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const folder = target('.agents', 'user')
    const previous = JSON.parse(
      await readFile(join(folder, '.artifactshare-managed.json'), 'utf8'),
    )
    const version = manifestCommitted ? 11 : 10
    const next = { ...initial, 'SKILL.md': marker(version) }
    await setBundle(next)
    await pendingIntent(folder, next, version)
    const pendingPath = join(folder, '.artifactshare-pending.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8'))
    await put(
      pendingPath,
      JSON.stringify({ ...pending, previous_files: previous.files }),
    )
    if (manifestCommitted)
      await put(
        join(folder, '.artifactshare-managed.json'),
        JSON.stringify(pending),
      )
    expectSuccess(run(['profiles', 'list']))
    assert.equal(
      await readFile(join(folder, 'SKILL.md'), 'utf8'),
      next['SKILL.md'],
    )
    await assert.rejects(readFile(pendingPath), /ENOENT/)
  })

for (const manifestCommitted of [false, true])
  for (const command of ['install', 'update', 'ensure', 'automatic', 'remove'])
    test(`${command} recovers missing entry with ${manifestCommitted ? 'committed manifest' : 'pending references'}`, async () => {
      const folder = target('.agents', 'user')
      await pendingIntent(folder, initial, 10)
      for (const [path, content] of Object.entries(initial))
        if (path !== 'SKILL.md') await put(join(folder, path), content)
      const pendingPath = join(folder, '.artifactshare-pending.json')
      if (manifestCommitted)
        await put(
          join(folder, '.artifactshare-managed.json'),
          await readFile(pendingPath, 'utf8'),
        )
      const diagnosed = expectSuccess(run(['doctor'])).data.skills.targets.find(
        (item: any) => item.tool === 'codex' && item.scope === 'user',
      )
      assert.equal(diagnosed.interrupted_update, true)
      assert.match(diagnosed.update_command, /skills update/)
      expectSuccess(
        command === 'automatic'
          ? run(['profiles', 'list'])
          : skills(command, '--tool', 'codex', '--scope', 'user'),
      )
      await assert.rejects(readFile(pendingPath), /ENOENT/)
      for (const [path, content] of Object.entries(initial)) {
        if (command === 'remove')
          await assert.rejects(readFile(join(folder, path)), /ENOENT/)
        else assert.equal(await readFile(join(folder, path), 'utf8'), content)
      }
    })
