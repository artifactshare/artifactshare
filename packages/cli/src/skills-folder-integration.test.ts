import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  lstat,
  readdir,
  readlink,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  DoctorSkillsDataSchema,
  SkillsListDataSchema,
  SkillsActionDataSchema,
  SkillAutoUpdateContainerSchema,
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
async function age(path: string) {
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await utimes(path, old, old)
}
async function setBundle(files: Record<string, string>) {
  const folder = join(overlay, 'skills/artifactshare')
  await rm(folder, { recursive: true, force: true })
  for (const [path, text] of Object.entries(files))
    await put(join(folder, path), text)
}
function run(args: string[], preload?: string, env: NodeJS.ProcessEnv = {}) {
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
        ...env,
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
      assert.match(item.update_command, /skills update.*--force/)
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
        /skills install --tool cursor --scope project --force/,
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
    await age(temp)
    await put(join(staging, 'partial'), 'partial')
    await age(staging)
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
    await age(temp)
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

for (const kind of ['file', 'entry'])
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
          kind === 'entry'
            ? /regular file or directory or remove/
            : /Restore or repoint/,
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
        kind === 'entry'
          ? /regular file or directory or remove/
          : /Restore or repoint/,
      )
    }
    const automatic = expectSuccess(run(['profiles', 'list'])).data.skills
      .auto_update.targets
    assert.equal(automatic[0].action, 'update_recommended')
    assert.ok(automatic[0].hint)
    assert.equal(automatic[0].update_command, undefined)
    assert.equal(
      await readFile(outside, 'utf8'),
      kind === 'file' ? 'untouched' : initial['SKILL.md'],
    )
  })

test('unresolvable folders retain separate aliases when init adds automatic targets', async () => {
  for (const tool of ['.agents', '.claude']) {
    const folder = target(tool, 'user')
    await mkdir(dirname(folder), { recursive: true })
    const outside = join(root, `file-${tool}`)
    await put(outside, 'not a directory')
    await symlink(outside, folder)
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
      await age(temp)
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

for (const args of [
  ['profiles', 'list'],
  ['skills', 'ensure', '--tool', 'auto'],
  ['init'],
  ['doctor'],
])
  test(`${args.join(' ')} recommends a working force update for managed edits`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const path = join(target('.agents', 'user'), 'references/usage.md')
    await put(path, 'personal edits')
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const data = expectSuccess(run(args)).data
    const rows =
      data.skills?.auto_update?.targets ?? data.skills?.targets ?? data.targets
    const row = rows.find(
      (item: any) => item.tool === 'codex' && item.scope === 'user',
    )
    if (args[0] === 'doctor')
      assert.equal(data.skills.update_command, row.update_command)
    assert.deepEqual(row.modified_files, ['references/usage.md'])
    assert.match(
      row.update_command,
      /skills update --tool codex --scope user --force --json$/,
    )
    assert.equal(await readFile(path, 'utf8'), 'personal edits')
    const command = row.update_command
      .slice(row.update_command.indexOf('skills update'))
      .split(' ')
    expectSuccess(run(command.filter((part: string) => part !== '--json')))
    assert.equal(await readFile(path, 'utf8'), initial['references/usage.md'])
  })

for (const installed of [false, true])
  test(`automatic update leaves ${installed ? 'unmanaged' : 'missing'} folder debris and links untouched`, async () => {
    const folder = target('.agents', 'user')
    if (installed) await put(join(folder, 'SKILL.md'), 'personal skill')
    const temp = join(
      folder,
      '.artifactshare-12345678-1234-1234-1234-123456789abc.tmp',
    )
    await put(temp, 'stale')
    const outside = join(root, 'outside')
    await put(outside, 'sentinel')
    await symlink(outside, join(folder, 'references'))
    const data = expectSuccess(run(['profiles', 'list'])).data
    assert.equal(data.skills?.auto_update, undefined)
    assert.equal(await readFile(temp, 'utf8'), 'stale')
    assert.equal(await readFile(outside, 'utf8'), 'sentinel')
  })

for (const danglingPart of ['.cursor', '.cursor/skills/artifactshare'])
  for (const action of ['update', 'remove'])
    test(`a dangling ${danglingPart} does not block unfiltered ${action} or automatic commands`, async () => {
      for (const tool of ['codex', 'claude'])
        expectSuccess(skills('install', '--tool', tool, '--scope', 'user'))
      const dangling = join(home, danglingPart)
      await mkdir(dirname(dangling), { recursive: true })
      await symlink(join(root, 'missing-cursor'), dangling)
      await setBundle({ ...initial, 'SKILL.md': marker(11) })
      for (const args of [['skills', 'list'], ['doctor']]) {
        const data = expectSuccess(run(args)).data
        const row = (data.skills ?? data).targets.find(
          (item: any) => item.tool === 'cursor' && item.scope === 'user',
        )
        assert.equal(row.installed, false)
        assert.equal(row.resolved_folder_path, null)
        assert.ok(row.hint.includes(`${dangling}. Restore`))
      }
      for (const args of [
        ['profiles', 'list'],
        ['init'],
        ['skills', 'ensure', '--tool', 'auto'],
      ]) {
        const data = expectSuccess(run(args)).data
        const rows =
          data.skills?.auto_update?.targets ??
          data.skills?.targets ??
          data.targets ??
          []
        assert.ok(
          !rows.some(
            (item: any) => item.tool === 'cursor' && item.scope === 'user',
          ),
        )
      }
      await setBundle({ ...initial, 'SKILL.md': marker(12) })
      const rows = expectSuccess(skills(action)).data.targets
      const missing = rows.find(
        (item: any) => item.tool === 'cursor' && item.scope === 'user',
      )
      assert.equal(missing.action, 'not_installed')
      assert.ok(missing.hint.includes(`${dangling}. Restore`))
      for (const tool of ['codex', 'claude']) {
        const row = rows.find(
          (item: any) => item.tool === tool && item.scope === 'user',
        )
        assert.equal(row.action, action === 'remove' ? 'removed' : 'updated')
      }
      assert.equal((await lstat(dangling)).isSymbolicLink(), true)
    })

for (const kind of ['internal link', 'directory replacement'])
  test(`automatic recommendations give repair hints without force commands for ${kind}`, async () => {
    expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const path = join(target('.agents', 'user'), 'references/usage.md')
    await rm(path)
    if (kind === 'internal link') {
      const outside = join(root, 'outside-reference')
      await put(outside, 'sentinel')
      await symlink(outside, path)
    } else {
      await put(join(path, 'personal.md'), 'sentinel')
    }
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    for (const args of [
      ['profiles', 'list'],
      ['skills', 'ensure', '--tool', 'auto'],
      ['init'],
      ['doctor'],
    ]) {
      const data = expectSuccess(run(args)).data
      const rows =
        data.skills?.auto_update?.targets ??
        data.skills?.targets ??
        data.targets
      const row = rows.find(
        (item: any) => item.tool === 'codex' && item.scope === 'user',
      )
      assert.equal(row.update_command, args[0] === 'doctor' ? null : undefined)
      assert.match(
        row.hint,
        /regular file or directory or remove|Preserve or move/,
      )
      assert.ok(!row.hint.includes('--force'))
    }
    assert.equal(
      await readFile(
        kind === 'internal link' ? path : join(path, 'personal.md'),
        'utf8',
      ),
      'sentinel',
    )
  })

test('doctor scopes a working update recommendation when another folder has an unsafe link', async () => {
  for (const tool of ['codex', 'claude'])
    expectSuccess(skills('install', '--tool', tool, '--scope', 'user'))
  const path = join(target('.agents', 'user'), 'references/usage.md')
  await rm(path)
  const outside = join(root, 'outside-reference')
  await put(outside, 'sentinel')
  await symlink(outside, path)
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  const data = expectSuccess(run(['doctor'])).data.skills
  const unsafe = data.targets.find(
    (item: any) => item.tool === 'codex' && item.scope === 'user',
  )
  assert.equal(unsafe.update_command, null)
  assert.match(
    data.update_command,
    /skills update --tool claude --scope user --json$/,
  )
  const command = data.update_command
    .slice(data.update_command.indexOf('skills update'))
    .split(' ')
  expectSuccess(run(command.filter((part: string) => part !== '--json')))
  assert.equal(
    await readFile(join(target('.claude', 'user'), 'SKILL.md'), 'utf8'),
    marker(11),
  )
  assert.equal(await readFile(outside, 'utf8'), 'sentinel')
})

for (const force of [false, true])
  test(`doctor covers all stale targets with the same command (force=${force}) despite unavailable Claude`, async () => {
    expectSuccess(
      skills('install', '--tool', 'codex,cursor', '--scope', 'project'),
    )
    if (force)
      for (const tool of ['.agents', '.cursor'])
        await put(join(target(tool), 'references/usage.md'), 'personal edits')
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const data = expectSuccess(
      run(['doctor'], undefined, { CLAUDE_CONFIG_DIR: 'relative' }),
    ).data.skills
    assert.match(
      data.update_command,
      force ? /skills update --force --json$/ : /skills update --json$/,
    )
    const args = data.update_command
      .slice(data.update_command.indexOf('skills update'))
      .split(' ')
    expectSuccess(run(args))
    for (const tool of ['.agents', '.cursor'])
      assert.equal(
        await readFile(join(target(tool), 'SKILL.md'), 'utf8'),
        marker(11),
      )
  })

test('doctor lists both commands when stale targets need different repairs', async () => {
  expectSuccess(
    skills('install', '--tool', 'codex,cursor', '--scope', 'project'),
  )
  await put(join(target('.agents'), 'references/usage.md'), 'personal edits')
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  const data = expectSuccess(run(['doctor'])).data.skills
  const commands = data.targets
    .filter((row: any) => row.update_command)
    .map((row: any) => row.update_command)
  assert.equal(commands.length, 2)
  assert.equal(data.update_command, commands.join(' && '))
})

for (const installed of [false, true])
  test(`newer interrupted intent requires a newer CLI (installed=${installed})`, async () => {
    if (installed)
      expectSuccess(skills('install', '--tool', 'codex', '--scope', 'user'))
    const folder = target('.agents', 'user')
    const next = {
      ...initial,
      'SKILL.md': marker(11),
      'references/usage.md': 'newer reference',
    }
    await pendingIntent(folder, next, 11)
    await put(join(folder, 'references/usage.md'), next['references/usage.md'])
    const staleFile = join(
      folder,
      '.artifactshare-12345678-1234-1234-1234-123456789abc.tmp',
    )
    await put(staleFile, 'stale staging')
    await age(staleFile)
    const pending = await readFile(
      join(folder, '.artifactshare-pending.json'),
      'utf8',
    )
    const doctor = expectSuccess(run(['doctor'])).data.skills.targets.find(
      (row: any) => row.tool === 'codex' && row.scope === 'user',
    )
    assert.equal(doctor.update_command, null)
    assert.match(doctor.hint, /newer CLI/)
    const auto = expectSuccess(run(['profiles', 'list'])).data.skills
      .auto_update.targets[0]
    assert.equal(auto.action, 'update_recommended')
    assert.equal(auto.update_command, undefined)
    assert.match(auto.hint, /newer CLI/)
    for (const command of ['update', 'install'])
      expectFailure(
        skills(command, '--tool', 'codex', '--scope', 'user', '--force'),
      )
    assert.equal(await readFile(staleFile, 'utf8'), 'stale staging')
    assert.equal(
      await readFile(join(folder, '.artifactshare-pending.json'), 'utf8'),
      pending,
    )
    assert.equal(
      await readFile(join(folder, 'references/usage.md'), 'utf8'),
      'newer reference',
    )
    if (installed)
      assert.equal(
        await readFile(join(folder, 'SKILL.md'), 'utf8'),
        initial['SKILL.md'],
      )
    else await assert.rejects(readFile(join(folder, 'SKILL.md')), /ENOENT/)
  })

test('failed automatic recovery of a fresh install reports no installed version', async () => {
  const folder = target('.agents', 'user')
  await pendingIntent(folder, initial, 10)
  const preload = join(root, 'fail-entry.mjs')
  await put(
    preload,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  if (String(args[1]).endsWith('/SKILL.md')) throw new Error('synthetic commit failure');
  return rename(...args);
};
syncBuiltinESMExports();
`,
  )
  const data = expectSuccess(run(['profiles', 'list'], preload)).data
  SkillAutoUpdateContainerSchema.parse(data)
  const row = data.skills.auto_update.targets[0]
  assert.equal(row.action, 'update_recommended')
  assert.equal(row.installed_version, null)
  await assert.rejects(readFile(join(folder, 'SKILL.md')), /ENOENT/)
})

for (const kind of ['directory', 'dangling', 'cycle']) {
  test(`user ${kind} links survive list, doctor, update and remove across targets`, async () => {
    expectSuccess(skills('install', '--tool', 'codex,claude'))
    const outside = join(root, 'outside')
    await put(join(outside, 'sentinel'), 'untouched')
    const link = join(target('.agents'), 'notes')
    await symlink(
      kind === 'directory'
        ? outside
        : kind === 'cycle'
          ? link
          : join(root, 'missing'),
      link,
    )
    const inode = (await lstat(link)).ino
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const listed = SkillsListDataSchema.parse(
      expectSuccess(skills('list')).data,
    )
    const doctor = DoctorSkillsDataSchema.parse(
      expectSuccess(run(['doctor'])).data.skills,
    )
    for (const data of [listed, doctor]) {
      const row = data.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!
      assert.deepEqual(row.user_links, ['notes'])
      assert.equal(row.complete, true)
      assert.deepEqual(row.modified_files, [])
    }
    for (const command of ['update', 'remove']) {
      const data = SkillsActionDataSchema.parse(
        expectSuccess(skills(command)).data,
      )
      for (const tool of ['codex', 'claude'])
        assert.equal(
          data.targets.find(
            (candidate) =>
              candidate.tool === tool && candidate.scope === 'project',
          )!.action,
          command === 'update' ? 'updated' : 'removed',
        )
      assert.equal((await lstat(link)).ino, inode)
      assert.equal(
        await readFile(join(outside, 'sentinel'), 'utf8'),
        'untouched',
      )
    }
    assert.deepEqual(await readdir(target('.agents')), ['notes'])
  })
}

for (const path of [
  'references',
  'SKILL.md',
  'references/usage.md',
  '.artifactshare-managed.json',
  '.artifactshare-pending.json',
  '.artifactshare-staging-00000000-0000-4000-8000-000000000000',
]) {
  test(`protected ${path} link fails only its target, including forced dry runs`, async () => {
    expectSuccess(skills('install', '--tool', 'codex,claude'))
    const outside = join(root, 'outside')
    await put(join(outside, 'sentinel'), 'untouched')
    await rm(join(target('.agents'), path), { recursive: true, force: true })
    await symlink(outside, join(target('.agents'), path))
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    for (const args of [
      ['update', '--force', '--dry-run'],
      ['update', '--force'],
      ['remove', '--dry-run'],
      ['remove'],
    ]) {
      const result = skills(...args)
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stderr, '')
      const envelope = JSON.parse(result.stdout)
      assert.equal(envelope.ok, true)
      const data = SkillsActionDataSchema.parse(envelope.data)
      const failed = data.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!
      assert.equal(failed.action, 'failed')
      assert.equal(failed.code, 'skill_update_conflict')
      assert.ok(failed.hint?.includes(path))
      assert.match(failed.hint!, /regular file or directory or remove/)
      assert.equal(
        data.targets.find(
          (candidate) =>
            candidate.tool === 'claude' && candidate.scope === 'project',
        )!.action,
        args[0] === 'update' ? 'updated' : 'removed',
      )
      assert.equal(
        await readFile(join(outside, 'sentinel'), 'utf8'),
        'untouched',
      )
      assert.equal(
        (await lstat(join(target('.agents'), path))).isSymbolicLink(),
        true,
      )
    }
  })
}

for (const command of ['install', 'update'])
  test(`${command}: newer installations receive no recommendation, skip all writes, and require explicit downgrade`, async () => {
    await setBundle({ ...initial, 'SKILL.md': marker(12) })
    expectSuccess(skills('install', '--tool', 'codex', '--tool', 'cursor'))
    await put(legacy(), marker(12))
    await setBundle(initial)
    expectSuccess(skills('install', '--tool', 'claude'))
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const debris = join(
      target('.agents'),
      '.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
    )
    await put(debris, 'debris')
    await age(debris)
    const manifest = join(target('.agents'), '.artifactshare-managed.json')
    const before = await readFile(manifest, 'utf8')
    const listed = SkillsListDataSchema.parse(
      expectSuccess(skills('list')).data,
    )
    const doctor = DoctorSkillsDataSchema.parse(
      expectSuccess(run(['doctor'])).data.skills,
    )
    for (const data of [listed, doctor]) {
      const row = data.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!
      assert.equal(row.update_available, false)
      assert.equal(row.current, false)
      assert.match(row.hint!, /A newer CLI installed/)
    }
    assert.equal(
      doctor.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!.update_command,
      null,
    )
    assert.match(doctor.update_command!, /--tool claude/)
    assert.doesNotMatch(doctor.update_command!, /--tool codex/)
    for (const args of [
      [
        command,
        '--tool',
        'codex',
        '--tool',
        'claude',
        '--tool',
        'cursor',
        '--dry-run',
      ],
      [command, '--tool', 'codex', '--tool', 'claude', '--tool', 'cursor'],
      ...(command === 'update' ? [[command, '--dry-run'], [command]] : []),
    ]) {
      const data = SkillsActionDataSchema.parse(
        expectSuccess(skills(...args)).data,
      )
      const row = data.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!
      assert.equal(row.action, 'unchanged')
      assert.equal(await readFile(legacy(), 'utf8'), marker(12))
      assert.equal(
        data.targets.find(
          (candidate) =>
            candidate.tool === 'claude' && candidate.scope === 'project',
        )!.action,
        // Unfiltered runs follow the filtered update of the same target.
        args.includes('--tool') ? 'updated' : 'unchanged',
      )
      assert.match(row.hint!, /A newer CLI installed/)
      assert.equal(await readFile(manifest, 'utf8'), before)
      assert.equal(await readFile(debris, 'utf8'), 'debris')
      assert.equal(
        await readFile(join(target('.agents'), 'SKILL.md'), 'utf8'),
        marker(12),
      )
    }
    for (const dry of [true, false]) {
      const data = SkillsActionDataSchema.parse(
        expectSuccess(
          skills(
            command,
            '--tool',
            'codex',
            '--scope',
            'project',
            '--force',
            ...(dry ? ['--dry-run'] : []),
          ),
        ).data,
      )
      assert.match(data.targets[0]!.hint!, /downgrade.*12.*11/)
      assert.equal(
        await readFile(join(target('.agents'), 'SKILL.md'), 'utf8'),
        marker(dry ? 12 : 11),
      )
    }
  })

for (const spelling of ['SKILL.md', 'skill.md'])
  test(`protected ${spelling} link isolates automatic ensure and unfiltered mutations`, async (context) => {
    expectSuccess(
      skills('install', '--tool', 'codex,claude', '--scope', 'user'),
    )
    const folder = target('.agents', 'user')
    if (
      spelling === 'skill.md' &&
      !(await lstat(join(folder, spelling)).catch(() => null))
    ) {
      context.skip()
      return
    }
    const outside = join(root, 'outside')
    await put(join(outside, 'sentinel'), 'untouched')
    await rm(join(folder, 'SKILL.md'))
    await symlink(outside, join(folder, spelling))
    const inode = (await lstat(join(folder, spelling))).ino
    for (const [index, args] of [
      ['ensure', '--tool', 'auto', '--scope', 'user', '--dry-run'],
      ['ensure', '--tool', 'auto', '--scope', 'user'],
      ['update', '--force', '--dry-run'],
      ['update', '--force'],
      ['remove', '--dry-run'],
      ['remove'],
    ].entries()) {
      await setBundle({ ...initial, 'SKILL.md': marker(11 + index) })
      const result = skills(...args)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.notEqual(result.stdout, '', result.stderr)
      const data = SkillsActionDataSchema.parse(JSON.parse(result.stdout).data)
      const failed = data.targets.find(
        (row) => row.tool === 'codex' && row.scope === 'user',
      )!
      assert.equal(failed.action, 'failed')
      assert.equal(failed.code, 'skill_update_conflict')
      assert.ok(failed.hint?.includes(spelling))
      assert.match(failed.hint!, /regular file or directory or remove/)
      const healthy = data.targets.find(
        (row) => row.tool === 'claude' && row.scope === 'user',
      )!
      assert.equal(healthy.action, args[0] === 'remove' ? 'removed' : 'updated')
      assert.equal((await lstat(join(folder, spelling))).ino, inode)
      assert.equal(
        await readFile(join(outside, 'sentinel'), 'utf8'),
        'untouched',
      )
    }
  })

test('removing a broken marker with newer pending intent reports the ownership conflict', async () => {
  expectSuccess(skills('install', '--tool', 'codex'))
  const folder = target('.agents')
  await pendingIntent(folder, { ...initial, 'SKILL.md': marker(11) }, 11)
  await put(join(folder, 'SKILL.md'), '<!-- artifactshare-skill -->')
  const result = expectFailure(skills('remove', '--tool', 'codex'))
  assert.match(result.error.hint, /Skill ownership conflict/)
  assert.doesNotMatch(result.error.hint, /newer CLI|Upgrade the CLI/)
  assert.equal(
    await readFile(join(folder, 'SKILL.md'), 'utf8'),
    '<!-- artifactshare-skill -->',
  )
})

for (const path of ['SKILL.md', 'references', 'dangling'])
  for (const [command, force] of [
    ['update', false],
    ['update', true],
    ['remove', false],
  ] as const)
    for (const filtered of [true, false])
      test(`unmanaged ${path}: ${command} ${filtered ? 'filtered' : 'all'} force=${force} never reads or mutates links`, async () => {
        const folder = target('.agents')
        const outside = join(root, 'outside')
        await put(join(outside, 'SKILL.md'), marker(99))
        await put(join(folder, 'SKILL.md'), 'personal skill')
        const link = join(folder, path === 'references' ? path : 'SKILL.md')
        if (path !== 'references') await rm(link)
        const referent =
          path === 'references'
            ? outside
            : join(outside, path === 'dangling' ? 'missing' : 'SKILL.md')
        await symlink(referent, link)
        const debris = join(
          folder,
          '.artifactshare-00000000-0000-4000-8000-000000000000.tmp',
        )
        await put(debris, 'partial')
        await age(debris)
        await put(join(folder, 'personal.txt'), 'personal')
        const before = await lstat(link)
        expectSuccess(skills('install', '--tool', 'claude'))
        await setBundle({ ...initial, 'SKILL.md': marker(11) })
        const log = join(root, 'reads.log')
        const preload = join(root, 'watch.mjs')
        await put(
          preload,
          `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFile;
for (const name of ['readFile', 'open', 'readdir']) {
  const original = fs[name];
  fs[name] = async (...args) => {
    const path = String(args[0]);
    if (path === ${JSON.stringify(link)} || path.startsWith(${JSON.stringify(link + '/')}) || path.startsWith(${JSON.stringify(outside)}))
      await append(${JSON.stringify(log)}, name + ':' + path + '\\n');
    return original(...args);
  };
}
syncBuiltinESMExports();`,
        )
        for (const args of [['skills', 'list'], ['doctor']]) {
          const data = expectSuccess(run(args, preload)).data
          const parsed =
            args[0] === 'doctor'
              ? DoctorSkillsDataSchema.parse(data.skills)
              : SkillsListDataSchema.parse(data)
          const row = parsed.targets.find(
            (candidate) =>
              candidate.tool === 'codex' && candidate.scope === 'project',
          )!
          assert.equal(row.installed, true)
          assert.equal(row.managed, false)
          assert.equal(row.ownership_manifest, 'absent')
          assert.equal(row.code, undefined)
          assert.equal(row.hint, undefined)
          assert.equal(row.update_available, false)
          if ('update_command' in row) assert.equal(row.update_command, null)
        }
        for (const dry of [true, false]) {
          const data = SkillsActionDataSchema.parse(
            expectSuccess(
              run(
                [
                  'skills',
                  command,
                  ...(filtered
                    ? [
                        '--tool',
                        'codex',
                        '--tool',
                        'claude',
                        '--scope',
                        'project',
                      ]
                    : []),
                  ...(force ? ['--force'] : []),
                  ...(dry ? ['--dry-run'] : []),
                ],
                preload,
              ),
            ).data,
          )
          assert.equal(
            data.targets.find(
              (row) => row.tool === 'codex' && row.scope === 'project',
            )!.action,
            'skipped_unmanaged',
          )
          assert.equal(
            data.targets.find(
              (row) => row.tool === 'claude' && row.scope === 'project',
            )!.action,
            command === 'update' ? 'updated' : 'removed',
          )
          assert.equal((await lstat(link)).ino, before.ino)
          assert.equal(await readlink(link), referent)
          assert.equal(await readFile(debris, 'utf8'), 'partial')
          assert.equal(
            await readFile(join(folder, 'personal.txt'), 'utf8'),
            'personal',
          )
          for (const record of [
            '.artifactshare-managed.json',
            '.artifactshare-pending.json',
          ])
            await assert.rejects(lstat(join(folder, record)), /ENOENT/)
        }
        await assert.rejects(lstat(log), /ENOENT/)
        assert.equal(
          await readFile(join(outside, 'SKILL.md'), 'utf8'),
          marker(99),
        )
        for (const dry of [true, false]) {
          const result = expectFailure(
            skills(
              'install',
              '--tool',
              'codex',
              '--force',
              ...(dry ? ['--dry-run'] : []),
            ),
          )
          assert.equal(result.error.code, 'skill_update_conflict')
          assert.match(
            result.error.hint,
            path === 'references' ? /references/ : /SKILL.md/,
          )
        }
      })

for (const kind of ['references without SKILL.md', 'reserved name'])
  test(`unowned folder with a ${kind} link is never a conflict`, async () => {
    const folder = target('.agents')
    const outside = join(root, 'outside')
    await put(join(outside, 'sentinel'), 'untouched')
    if (kind === 'reserved name') await put(join(folder, 'SKILL.md'), 'mine')
    const link = join(
      folder,
      kind === 'reserved name'
        ? '.artifactshare-staging-00000000-0000-4000-8000-000000000000'
        : 'references',
    )
    await mkdir(folder, { recursive: true })
    await symlink(outside, link)
    expectSuccess(skills('install', '--tool', 'claude'))
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const expected = kind === 'reserved name' ? 'skipped_unmanaged' : null
    for (const data of [
      SkillsListDataSchema.parse(expectSuccess(skills('list')).data),
      DoctorSkillsDataSchema.parse(expectSuccess(run(['doctor'])).data.skills),
    ]) {
      const row = data.targets.find(
        (candidate) =>
          candidate.tool === 'codex' && candidate.scope === 'project',
      )!
      assert.equal(row.code, undefined)
      assert.equal(row.hint, undefined)
    }
    for (const args of [
      ['update', '--tool', 'codex', '--scope', 'project'],
      ['update'],
      ['remove', '--tool', 'codex', '--scope', 'project'],
      ['remove'],
    ]) {
      const data = SkillsActionDataSchema.parse(
        expectSuccess(skills(...args, '--dry-run')).data,
      )
      assert.equal(
        data.targets.find(
          (row) => row.tool === 'codex' && row.scope === 'project',
        )!.action,
        expected ?? 'not_installed',
      )
    }
    assert.equal((await lstat(link)).isSymbolicLink(), true)
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  })

test('automatic ensure, open and init skip an unowned folder whose SKILL.md is a link', async () => {
  expectSuccess(skills('install', '--tool', 'claude', '--scope', 'user'))
  const folder = target('.agents', 'user')
  const outside = join(root, 'outside')
  await put(join(outside, 'SKILL.md'), marker(99))
  await mkdir(folder, { recursive: true })
  await symlink(join(outside, 'SKILL.md'), join(folder, 'SKILL.md'))
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  const data = SkillsActionDataSchema.parse(
    expectSuccess(skills('ensure', '--tool', 'auto', '--scope', 'user')).data,
  )
  assert.equal(
    data.targets.find((row) => row.tool === 'codex' && row.scope === 'user')!
      .action,
    'skipped_unmanaged',
  )
  assert.equal(
    data.targets.find((row) => row.tool === 'claude' && row.scope === 'user')!
      .action,
    'updated',
  )
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), marker(99))
})

test('install preserves a newer installation despite a link at a path only the older bundle ships', async () => {
  await setBundle({ ...initial, 'SKILL.md': marker(12) })
  expectSuccess(skills('install', '--tool', 'codex'))
  await setBundle({
    ...initial,
    'SKILL.md': marker(11),
    'references/old.md': 'old',
  })
  const outside = join(root, 'outside')
  await put(join(outside, 'sentinel'), 'untouched')
  await symlink(outside, join(target('.agents'), 'references/old.md'))
  const data = SkillsActionDataSchema.parse(
    expectSuccess(skills('install', '--tool', 'codex', '--tool', 'claude'))
      .data,
  )
  const row = data.targets.find((candidate) => candidate.tool === 'codex')!
  assert.equal(row.action, 'unchanged')
  assert.match(row.hint!, /A newer CLI installed/)
  assert.equal(
    data.targets.find((candidate) => candidate.tool === 'claude')!.action,
    'installed',
  )
})

test('automatic ensure refuses a linked SKILL.md when the legacy rule is managed', async () => {
  await put(legacy(), marker(1))
  const outside = join(root, 'outside')
  await put(join(outside, 'SKILL.md'), marker(99))
  await mkdir(target(), { recursive: true })
  await symlink(join(outside, 'SKILL.md'), join(target(), 'SKILL.md'))
  const row = SkillsActionDataSchema.parse(
    expectSuccess(skills('ensure', '--tool', 'auto')).data,
  ).targets.find((item) => item.tool === 'cursor' && item.scope === 'project')!
  // Not skipped as the user's folder: the link is refused with a repair hint.
  assert.equal(row.action, 'update_recommended')
  assert.match(row.hint!, /Unsafe skill path \(link\): SKILL.md/)
  assert.equal(await readFile(legacy(), 'utf8'), marker(1))
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), marker(99))
})

for (const command of [
  ['install', '--tool', 'cursor'],
  ['update', '--tool', 'cursor', '--scope', 'project'],
  ['update'],
])
  for (const force of [false, true])
    for (const dryRun of [false, true])
      test(`newer legacy-only rule: ${command.join(' ')} force=${force} dryRun=${dryRun}`, async () => {
        await setBundle({ ...initial, 'SKILL.md': marker(11) })
        const original = marker(12) + 'newer rule content\n'
        await put(legacy(), original)
        const data = SkillsActionDataSchema.parse(
          expectSuccess(
            skills(
              ...command,
              ...(force ? ['--force'] : []),
              ...(dryRun ? ['--dry-run'] : []),
            ),
          ).data,
        )
        const row = data.targets.find(
          (item) => item.tool === 'cursor' && item.scope === 'project',
        )!
        assert.equal(row.action, force ? 'installed' : 'unchanged')
        assert.match(
          row.hint!,
          force
            ? /Intentional downgrade from skill version 12 to bundled version 11/
            : /A newer CLI installed skill version 12; this CLI bundles version 11/,
        )
        if (force)
          assert.equal(
            row.legacy_rule?.action,
            dryRun ? 'would_remove' : 'removed',
          )
        if (!force || dryRun) {
          assert.equal(await readFile(legacy(), 'utf8'), original)
          await assert.rejects(lstat(target()), /ENOENT/)
        } else {
          await assert.rejects(lstat(legacy()), /ENOENT/)
          for (const [path, content] of Object.entries({
            ...initial,
            'SKILL.md': marker(11),
          }))
            assert.equal(await readFile(join(target(), path), 'utf8'), content)
        }
      })

test('list and doctor preserve newer legacy-only advice alongside an outdated target', async () => {
  expectSuccess(skills('install', '--tool', 'claude'))
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  await put(legacy(), marker(12))
  for (const command of [['skills', 'list'], ['doctor']]) {
    const result = expectSuccess(run(command)).data
    const data = command[0] === 'doctor' ? result.skills : result
    const row = data.targets.find(
      (item: any) => item.tool === 'cursor' && item.scope === 'project',
    )
    assert.equal(row.installed, false)
    assert.equal(row.installed_version, null)
    assert.match(row.hint, /A newer CLI installed skill version 12/)
    assert.ok(!row.update_command)
    if (command[0] === 'doctor')
      assert.ok(!data.update_command.includes('--force'))
  }
  assert.equal(await readFile(legacy(), 'utf8'), marker(12))
  await assert.rejects(lstat(target()), /ENOENT/)
})

for (const command of ['ensure', 'init', 'open'])
  test(`${command} recommends forced install for a regular user reference collision`, async () => {
    const path = join(target('.agents', 'user'), 'references/usage.md')
    await put(path, 'personal reference')
    const preload = join(overlay, 'mock-open.mjs')
    await put(
      preload,
      `
import { MockAgent, setGlobalDispatcher } from 'undici';
const agent = new MockAgent();
agent.disableNetConnect();
agent.get('https://artifactshare.com').intercept({ path: '/api/cli/artifacts/abc123def4', method: 'GET' }).reply(200, {
  id: 'abc123def4', share_url: 'https://artifactshare.com/a/abc123def4', version_id: 'ver123', format: 'markdown', content: '# Report', size_bytes: 8, truncated: false, next_offset: null
});
setGlobalDispatcher(agent);
`,
    )
    const result =
      command === 'ensure'
        ? expectSuccess(skills('ensure', '--tool', 'auto')).data
        : expectSuccess(
            run(
              command === 'init' ? ['init'] : ['open', 'abc123def4'],
              preload,
              { ARTIFACTSHARE_TOKEN: 'test-token' },
            ),
          ).data.skills
    const data = SkillsActionDataSchema.parse(result)
    const row = data.targets.find(
      (item) => item.tool === 'codex' && item.scope === 'user',
    )!
    assert.equal(row.action, 'update_recommended')
    assert.equal(
      row.update_command,
      'npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool codex --scope user --force --json',
    )
    assert.equal(await readFile(path, 'utf8'), 'personal reference')
  })

test('doctor exposes regular directory collisions and scopes other updates', async () => {
  expectSuccess(skills('install', '--tool', 'claude'))
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  await put(join(target('.agents'), 'SKILL.md'), 'personal skill')
  await put(
    join(target('.agents'), 'references/usage.md/personal.txt'),
    'personal reference',
  )
  const data = DoctorSkillsDataSchema.parse(
    expectSuccess(run(['doctor'])).data.skills,
  )
  const row = data.targets.find(
    (item) => item.tool === 'codex' && item.scope === 'project',
  )!
  assert.match(row.hint!, /Unowned skill directory.*references\/usage.md/)
  assert.equal(row.update_command, null)
  assert.match(
    data.update_command!,
    /skills update --tool claude --scope project --json/,
  )
})

for (const force of [false, true])
  test(`managed legacy linked entry remains refused with force=${force}`, async () => {
    await put(legacy(), marker(1))
    const outside = join(root, 'outside.md')
    await put(outside, marker(99))
    await mkdir(target(), { recursive: true })
    await symlink(outside, join(target(), 'SKILL.md'))
    for (const command of ['install', 'update'])
      expectFailure(
        skills(command, '--tool', 'cursor', ...(force ? ['--force'] : [])),
        { code: 'skill_update_conflict' },
      )
    assert.equal(await readFile(outside, 'utf8'), marker(99))
    assert.equal(await readFile(legacy(), 'utf8'), marker(1))
  })

for (const installed of [false, true])
  test(`doctor keeps regular type-collision guidance beside an unrelated user link, installed=${installed}`, async () => {
    expectSuccess(skills('install', '--tool', 'claude'))
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    const folder = target('.agents')
    if (installed) await put(join(folder, 'SKILL.md'), 'personal skill')
    await put(join(folder, 'references'), 'personal references')
    const outside = join(root, 'outside')
    await put(join(outside, 'sentinel'), 'untouched')
    await symlink(outside, join(folder, 'notes'))
    const data = DoctorSkillsDataSchema.parse(
      expectSuccess(run(['doctor'])).data.skills,
    )
    const row = data.targets.find(
      (item) => item.tool === 'codex' && item.scope === 'project',
    )!
    assert.deepEqual(row.user_links, ['notes'])
    assert.match(
      row.hint!,
      /Unsafe skill path \(type change or link\): .*references/,
    )
    assert.equal(row.update_command, null)
    if (installed)
      assert.match(
        data.update_command!,
        /skills update --tool claude --scope project --json/,
      )
    assert.equal(
      await readFile(join(folder, 'references'), 'utf8'),
      'personal references',
    )
    assert.equal(await readlink(join(folder, 'notes')), outside)
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  })

for (const command of [
  ['install', '--tool', 'cursor'],
  ['update', '--tool', 'cursor', '--scope', 'project'],
  ['ensure', '--tool', 'cursor', '--scope', 'project'],
])
  test(`newer legacy rule beside a folder without SKILL.md: ${command.join(' ')}`, async () => {
    await setBundle({ ...initial, 'SKILL.md': marker(11) })
    await put(legacy(), marker(12))
    await mkdir(target(), { recursive: true })
    const data = SkillsActionDataSchema.parse(
      expectSuccess(skills(...command)).data,
    )
    const row = data.targets.find(
      (item) => item.tool === 'cursor' && item.scope === 'project',
    )!
    assert.equal(row.action, 'unchanged')
    assert.match(row.hint!, /A newer CLI installed skill version 12/)
    assert.equal(await readFile(legacy(), 'utf8'), marker(12))
    await assert.rejects(lstat(join(target(), 'SKILL.md')), /ENOENT/)
  })

test('ensure keeps a newer legacy-only rule without a folder', async () => {
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  await put(legacy(), marker(12))
  const data = SkillsActionDataSchema.parse(
    expectSuccess(skills('ensure', '--tool', 'cursor', '--scope', 'project'))
      .data,
  )
  const row = data.targets.find(
    (item) => item.tool === 'cursor' && item.scope === 'project',
  )!
  assert.equal(row.action, 'unchanged')
  assert.match(row.hint!, /A newer CLI installed skill version 12/)
  assert.equal(await readFile(legacy(), 'utf8'), marker(12))
  await assert.rejects(lstat(target()), /ENOENT/)
})

test('doctor names a regular user reference collision in a folder without SKILL.md', async () => {
  const path = join(target('.agents', 'user'), 'references/usage.md')
  await put(path, 'personal reference')
  const data = DoctorSkillsDataSchema.parse(
    expectSuccess(run(['doctor'])).data.skills,
  )
  const row = data.targets.find(
    (item) => item.tool === 'codex' && item.scope === 'user',
  )!
  assert.match(row.hint!, /Unowned skill file: references\/usage.md/)
  assert.equal(row.update_command, null)
  assert.equal(await readFile(path, 'utf8'), 'personal reference')
})

test('automatic ensure gives no advice for a folder blocked only by a user references link', async () => {
  const folder = target('.agents', 'user')
  const outside = join(root, 'outside-references')
  await put(join(outside, 'usage.md'), 'untouched')
  await mkdir(folder, { recursive: true })
  await symlink(outside, join(folder, 'references'))
  const data = SkillsActionDataSchema.parse(
    expectSuccess(skills('ensure', '--tool', 'auto')).data,
  )
  const row = data.targets.find(
    (item) => item.tool === 'codex' && item.scope === 'user',
  )!
  assert.equal(row.action, 'update_recommended')
  assert.equal(row.hint, undefined)
  assert.equal(row.update_command, undefined)
  assert.ok(!('suppressHint' in row))
  assert.equal(await readlink(join(folder, 'references')), outside)
  assert.equal(await readFile(join(outside, 'usage.md'), 'utf8'), 'untouched')
})

test('doctor does not combine forced updates when a newer legacy-only rule exists', async () => {
  expectSuccess(skills('install', '--tool', 'claude'))
  expectSuccess(skills('install', '--tool', 'codex'))
  for (const tool of ['.claude', '.agents'])
    await put(join(target(tool), 'references/usage.md'), 'edited')
  await setBundle({ ...initial, 'SKILL.md': marker(11) })
  await put(legacy(), marker(12))
  const data = DoctorSkillsDataSchema.parse(
    expectSuccess(run(['doctor'])).data.skills,
  )
  assert.match(data.update_command!, /--force/)
  for (const command of data.update_command!.split(' && '))
    assert.match(command, / --tool (claude|codex) --scope project /)
  assert.equal(await readFile(legacy(), 'utf8'), marker(12))
})
