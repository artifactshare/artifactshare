import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'vitest'
import { WriteBoundary, WriteBoundaryError } from './write-boundary.js'
import { ensureGitExclude } from './git-exclude.js'

async function fixture(t: TestContext) {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'write-boundary-')),
  )
  t.onTestFinished(() => fs.rm(base, { recursive: true, force: true }))
  const root = join(base, 'output')
  const outside = join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, 'sentinel'), 'unchanged')
  return { base, root, outside }
}

for (const phase of ['create', 'read', 'rename', 'remove'] as const) {
  test(`refuses observed root replacement before ${phase}`, async (t) => {
    const { base, root, outside } = await fixture(t)
    let armed = false
    const boundary = new WriteBoundary({
      checkpoint: async (at) => {
        if (!armed || at !== phase) return
        armed = false
        await fs.rename(root, join(base, 'original'))
        await fs.symlink(outside, root)
      },
    })
    await boundary.record(base, true)
    await boundary.record(root, true)
    await boundary.write(join(root, 'new'), 'new')
    armed = true
    const operation =
      phase === 'create'
        ? boundary.write(join(root, 'next'), 'new')
        : phase === 'read'
          ? boundary.read(join(root, 'new'))
          : phase === 'rename'
            ? boundary.move(join(root, 'new'), join(root, 'next'))
            : boundary.cleanup()
    await assert.rejects(operation, WriteBoundaryError)
    await assert.rejects(boundary.cleanup(), WriteBoundaryError)
    assert.deepEqual(await fs.readdir(outside), ['sentinel'])
    assert.equal(
      await fs.readFile(join(outside, 'sentinel'), 'utf8'),
      'unchanged',
    )
  })
}

test('retains displaced original and removes only owned staging', async (t) => {
  const { base, root } = await fixture(t)
  await fs.writeFile(join(root, 'old'), 'original')
  const boundary = new WriteBoundary()
  await boundary.record(base, true)
  await boundary.tree(root)
  boundary.workspace = await boundary.privateDirectory(base)
  const stage = await boundary.privateDirectory(boundary.workspace)
  await boundary.write(join(stage, 'new'), 'replacement')
  await boundary.replace(stage, root)
  boundary.keep(root)
  await boundary.cleanup()
  assert.deepEqual(await fs.readdir(root), ['new'])
  assert.equal(
    await fs.readFile(join(boundary.backupPaths[0]!, 'old'), 'utf8'),
    'original',
  )
})

test('failed publication restores original without deleting it', async (t) => {
  const { base, root } = await fixture(t)
  await fs.writeFile(join(root, 'old'), 'original')
  let calls = 0
  const boundary = new WriteBoundary({
    rename: async (a, b) => {
      if (++calls === 2) throw new Error('injected failure')
      await fs.rename(a, b)
    },
  })
  await boundary.record(base, true)
  await boundary.tree(root)
  boundary.workspace = await boundary.privateDirectory(base)
  const stage = await boundary.privateDirectory(boundary.workspace)
  await boundary.write(join(stage, 'new'), 'replacement')
  await assert.rejects(boundary.replace(stage, root))
  await boundary.cleanup()
  assert.equal(await fs.readFile(join(root, 'old'), 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(base), ['output', 'outside'])
})

test('cleanup refuses unknown children and preserves their contents', async (t) => {
  const { base } = await fixture(t)
  const boundary = new WriteBoundary()
  await boundary.record(base, true)
  const directory = await boundary.privateDirectory(base)
  await fs.writeFile(join(directory, 'unowned'), 'keep')
  await assert.rejects(boundary.cleanup())
  assert.equal(await fs.readFile(join(directory, 'unowned'), 'utf8'), 'keep')
})

test('atomic config publication rejects a leaf replacement', async (t) => {
  const { root, outside } = await fixture(t)
  const file = join(root, 'config.local.json')
  await fs.writeFile(file, '{"custom":true}')
  const boundary = new WriteBoundary({
    checkpoint: async (phase) => {
      if (phase !== 'rename') return
      await fs.unlink(file)
      await fs.symlink(join(outside, 'sentinel'), file)
    },
  })
  await boundary.record(root, true)
  await boundary.read(file)
  await assert.rejects(boundary.atomicWrite(file, '{}'), WriteBoundaryError)
  assert.equal(
    await fs.readFile(join(outside, 'sentinel'), 'utf8'),
    'unchanged',
  )
})

for (const target of ['.git', '.git/info', '.git/info/exclude']) {
  test(`Git exclude warns on linked ${target}`, async (t) => {
    const { root, outside } = await fixture(t)
    if (target !== '.git') await fs.mkdir(join(root, '.git'))
    if (target.endsWith('/exclude')) await fs.mkdir(join(root, '.git/info'))
    await fs.symlink(
      target.endsWith('/exclude') ? join(outside, 'sentinel') : outside,
      join(root, target),
    )
    const result = await ensureGitExclude(root)
    assert.equal(result.applied, false)
    assert.match(result.warning!, /add .artifactshare\/config.local.json/)
    assert.equal(
      await fs.readFile(join(outside, 'sentinel'), 'utf8'),
      'unchanged',
    )
    assert.deepEqual(await fs.readdir(outside), ['sentinel'])
  })
}

test('Git exclude preserves comments, adds once, and refuses redirect metadata', async (t) => {
  const { root } = await fixture(t)
  await fs.mkdir(join(root, '.git/info'), { recursive: true })
  const path = join(root, '.git/info/exclude')
  await fs.writeFile(path, '# keep')
  assert.equal((await ensureGitExclude(root)).applied, true)
  assert.equal((await ensureGitExclude(root)).applied, false)
  assert.equal(
    await fs.readFile(path, 'utf8'),
    '# keep\n.artifactshare/config.local.json\n',
  )
  await fs.writeFile(join(root, '.git/commondir'), '../elsewhere')
  assert.match((await ensureGitExclude(root)).warning!, /manually/)
})

test('unavailable stable identity fails before creation', async (t) => {
  const { root } = await fixture(t)
  const boundary = new WriteBoundary({
    lstat: async (path) => {
      const stat = await fs.lstat(path, { bigint: true })
      stat.ino = 0n
      return stat
    },
  })
  await assert.rejects(boundary.record(root, true), WriteBoundaryError)
  assert.deepEqual(await fs.readdir(root), [])
})

test('physical-parent redirects fail by identity', async (t) => {
  const { root, outside } = await fixture(t)
  const file = join(root, 'file')
  await fs.writeFile(file, 'selected')
  const boundary = new WriteBoundary({
    realpath: async (path) =>
      path === file ? join(outside, 'sentinel') : fs.realpath(path),
  })
  await boundary.record(root, true)
  await assert.rejects(boundary.record(file), WriteBoundaryError)
  assert.equal(
    await fs.readFile(join(outside, 'sentinel'), 'utf8'),
    'unchanged',
  )
})

test('failed restore retains backup and never removes its containing workspace', async (t) => {
  const { base, root } = await fixture(t)
  await fs.writeFile(join(root, 'original'), 'recover me')
  let calls = 0
  const boundary = new WriteBoundary({
    rename: async (source, target) => {
      if (++calls > 1) throw new Error('private failure text')
      await fs.rename(source, target)
    },
  })
  await boundary.record(base, true)
  await boundary.tree(root)
  boundary.workspace = await boundary.privateDirectory(base)
  const stage = await boundary.privateDirectory(boundary.workspace)
  await boundary.write(join(stage, 'new'), 'new')
  await assert.rejects(boundary.replace(stage, root))
  await boundary.cleanup()
  assert.equal(
    await fs.readFile(join(boundary.backupPaths[0]!, 'original'), 'utf8'),
    'recover me',
  )
  assert.deepEqual(await fs.readdir(boundary.workspace), [
    boundary.backupPaths[0]!.split('/').at(-1),
  ])
})

test('rollback refuses a newly arrived destination', async (t) => {
  const { base, root } = await fixture(t)
  await fs.writeFile(join(root, 'original'), 'recover me')
  let calls = 0
  const boundary = new WriteBoundary({
    rename: async (source, target) => {
      if (++calls === 2) {
        await fs.mkdir(root)
        await fs.writeFile(join(root, 'newcomer'), 'do not overwrite')
        throw new Error('publication failed')
      }
      await fs.rename(source, target)
    },
  })
  await boundary.record(base, true)
  await boundary.tree(root)
  boundary.workspace = await boundary.privateDirectory(base)
  const stage = await boundary.privateDirectory(boundary.workspace)
  await assert.rejects(boundary.replace(stage, root), WriteBoundaryError)
  await assert.rejects(boundary.cleanup(), WriteBoundaryError)
  assert.equal(
    await fs.readFile(join(root, 'newcomer'), 'utf8'),
    'do not overwrite',
  )
  assert.equal(
    await fs.readFile(join(boundary.backupPaths[0]!, 'original'), 'utf8'),
    'recover me',
  )
})

test('Git exclude directory swap warns without touching outside data', async (t) => {
  const { base, root, outside } = await fixture(t)
  await fs.mkdir(join(root, '.git/info'), { recursive: true })
  const result = await ensureGitExclude(root, {
    checkpoint: async (phase) => {
      if (phase === 'rename') {
        await fs.rename(join(root, '.git/info'), join(base, 'old-info'))
        await fs.symlink(outside, join(root, '.git/info'))
      }
    },
  })
  assert.match(result.warning!, /manually/)
  assert.deepEqual(await fs.readdir(outside), ['sentinel'])
})

test('rollback rechecks the output parent before restoring', async (t) => {
  const { base, root, outside } = await fixture(t)
  const parent = join(root, 'parent')
  const destination = join(parent, 'artifact')
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(join(destination, 'original'), 'keep')
  let calls = 0
  const boundary = new WriteBoundary({
    rename: async (source, target) => {
      if (++calls === 2) throw new Error('publication failed')
      await fs.rename(source, target)
    },
    checkpoint: async (phase) => {
      if (phase !== 'rollback') return
      await fs.rename(parent, join(root, 'old-parent'))
      await fs.symlink(outside, parent)
    },
  })
  await boundary.record(root, true)
  await boundary.tree(parent)
  boundary.workspace = await boundary.privateDirectory(base)
  const staged = await boundary.privateDirectory(boundary.workspace)
  await assert.rejects(
    boundary.replace(staged, destination),
    WriteBoundaryError,
  )
  assert.deepEqual(await fs.readdir(outside), ['sentinel'])
  assert.equal(
    await fs.readFile(join(boundary.backupPaths[0]!, 'original'), 'utf8'),
    'keep',
  )
})

for (const replaced of ['source', 'destination']) {
  test(`rename refuses a replaced ${replaced} leaf`, async (t) => {
    const { root, outside } = await fixture(t)
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    const boundary = new WriteBoundary({
      checkpoint: async (phase) => {
        if (phase !== 'rename') return
        if (replaced === 'source') await fs.unlink(source)
        await fs.symlink(
          join(outside, 'sentinel'),
          replaced === 'source' ? source : destination,
        )
      },
    })
    await boundary.record(root, true)
    await boundary.write(source, 'created')
    await assert.rejects(boundary.move(source, destination), WriteBoundaryError)
    assert.equal(
      await fs.readFile(join(outside, 'sentinel'), 'utf8'),
      'unchanged',
    )
  })
}

test('staging replacement before creation cannot redirect writes', async (t) => {
  const { root, outside } = await fixture(t)
  let stage = ''
  const boundary = new WriteBoundary({
    checkpoint: async (phase, path) => {
      if (phase !== 'create' || path !== join(stage, 'new')) return
      await fs.rename(stage, join(root, 'old-stage'))
      await fs.symlink(outside, stage)
    },
  })
  stage = await boundary.privateDirectory(root)
  await assert.rejects(
    boundary.write(join(stage, 'new'), 'new'),
    WriteBoundaryError,
  )
  assert.deepEqual(await fs.readdir(outside), ['sentinel'])
})

test('verified file handles close when the path changes after open', async (t) => {
  const { root, outside } = await fixture(t)
  const source = join(root, 'config')
  await fs.writeFile(source, '{}')
  let closed = false
  const boundary = new WriteBoundary({
    open: async (path, flags) => {
      const handle = await fs.open(path, flags)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        closed = true
        await close()
      }
      await fs.rename(source, join(root, 'old-config'))
      await fs.symlink(join(outside, 'sentinel'), source)
      return handle
    },
  })
  await boundary.record(root, true)
  await assert.rejects(boundary.read(source), WriteBoundaryError)
  assert.equal(closed, true)
  assert.equal(
    await fs.readFile(join(outside, 'sentinel'), 'utf8'),
    'unchanged',
  )
})

test('tree preflight scales linearly and writes do not revisit unrelated leaves', async (t) => {
  const { base, root } = await fixture(t)
  let calls = 0
  const boundary = new WriteBoundary({
    lstat: async (path) => {
      calls++
      return fs.lstat(path, { bigint: true })
    },
  })
  for (let i = 0; i < 200; i++)
    await fs.writeFile(join(root, `existing-${i}`), 'original')
  await boundary.record(base, true)
  await boundary.tree(root)
  assert.ok(calls < 5000, `preflight used ${calls} identity reads`)
  calls = 0
  await boundary.write(join(root, 'new'), 'created')
  assert.ok(calls < 100, `one write used ${calls} identity reads`)
})

test('watched output identity is checked while writing sibling staging', async (t) => {
  const { base, root, outside } = await fixture(t)
  let armed = false
  const boundary = new WriteBoundary({
    checkpoint: async (phase) => {
      if (!armed || phase !== 'create') return
      armed = false
      await fs.rename(root, join(base, 'original'))
      await fs.symlink(outside, root)
    },
  })
  boundary.watch(root)
  await boundary.record(base, true)
  await boundary.record(root, true)
  const staging = await boundary.privateDirectory(base)
  armed = true
  await assert.rejects(
    boundary.write(join(staging, 'new'), 'new'),
    WriteBoundaryError,
  )
  assert.deepEqual(await fs.readdir(staging), [])
  assert.deepEqual(await fs.readdir(outside), ['sentinel'])
})
