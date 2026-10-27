import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
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
      assert.match(item.update_command, /skills update/)
  }
  const repaired = expectSuccess(skills('update', '--tool', 'cursor')).data
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
    initial['references/usage.md'],
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
