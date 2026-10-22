import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { readUploadBoundary } from './upload-boundary.js'
import { uploadBoundarySwap } from './test/upload-boundary-swap.js'

const observed = vi.hoisted(() => ({
  reads: 0,
  closes: 0,
  paths: [] as string[],
  fault: '' as string,
  noFollowUnavailable: false,
  swapFailure: '',
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NOFOLLOW() {
        return observed.noFollowUnavailable ? 0 : actual.constants.O_NOFOLLOW
      },
    },
    createReadStream: () => {
      throw new Error('Unsafe path stream')
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (observed.swapFailure === 'rename')
        throw new Error('synthetic swap rename failure')
      return actual.rename(...args)
    },
    symlink: (...args: Parameters<typeof actual.symlink>) => {
      if (observed.swapFailure === 'symlink')
        throw new Error('synthetic swap symlink failure')
      return actual.symlink(...args)
    },
    readFile: () => {
      throw new Error('Unsafe path read')
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      observed.paths.push(String(args[0]))
      return actual.readdir(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const stat = handle.stat.bind(handle)
      const read = handle.readFile.bind(handle)
      const close = handle.close.bind(handle)
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const result = await stat(...statArgs)
        if (observed.fault === 'identity') result.ino = 0n as never
        if (observed.fault === 'missing-identity')
          result.ino = undefined as never
        if (observed.fault === 'mismatch')
          result.ino = (BigInt(result.ino) + 1n) as never
        return result
      }) as typeof handle.stat
      handle.readFile = (async (
        ...readArgs: Parameters<typeof handle.readFile>
      ) => {
        observed.reads++
        if (observed.fault === 'read') throw new Error('synthetic read failure')
        return read(...readArgs)
      }) as typeof handle.readFile
      handle.close = async () => {
        observed.closes++
        return close()
      }
      return handle
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  observed.reads = 0
  observed.closes = 0
  observed.paths = []
  observed.fault = ''
  observed.noFollowUnavailable = false
  observed.swapFailure = ''
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'upload-boundary-'))
  roots.push(root)
  const selected = join(root, 'selected')
  const external = join(root, 'external')
  await mkdir(selected)
  await mkdir(external)
  await mkdir(join(selected, '.git'))
  await writeFile(join(selected, 'index.html'), '<p>selected</p>')
  await writeFile(join(external, 'index.html'), 'external-sentinel')
  return { root, selected, external }
}

for (const kind of [
  'file',
  'directory',
  'dangling',
  'parent',
  'descendant',
  'descendant-directory',
  'descendant-dangling',
  'junction',
  'descendant-junction',
] as const) {
  test(`upload boundary rejects ${kind} without reading bytes`, async () => {
    const { selected, external } = await fixture()
    const link = join(selected, 'link')
    const directory = [
      'directory',
      'parent',
      'junction',
      'descendant-directory',
      'descendant-junction',
    ].includes(kind)
    await symlink(
      directory
        ? external
        : join(external, kind.includes('dangling') ? 'missing' : 'index.html'),
      link,
      directory ? (kind.includes('junction') ? 'junction' : 'dir') : 'file',
    )
    const path =
      kind === 'parent'
        ? join(link, 'index.html')
        : kind.startsWith('descendant')
          ? selected
          : link
    let reads = 0
    await assert.rejects(
      readUploadBoundary(path, {
        cwd: selected,
        hooks: {
          reading: () => {
            reads++
          },
        },
      }),
      /symbolic link|junction/,
    )
    assert.equal(reads, 0)
    assert.equal(observed.reads, 0)
  })
}

for (const phase of ['enumerated', 'before-open', 'opened'] as const) {
  for (const parent of [false, true]) {
    test(`upload boundary detects ${parent ? 'parent' : 'leaf'} substitution at ${phase}`, async (context) => {
      const { selected, external } = await fixture()
      let reads = 0
      const path = join(selected, 'index.html')
      const swap = uploadBoundarySwap({
        phase,
        parent,
        selected,
        external,
        path,
      })
      await assert.rejects(
        readUploadBoundary(path, {
          cwd: selected,
          hooks: {
            reading: () => {
              reads++
            },
            checkpoint: swap.checkpoint,
          },
        }),
        /link|identity|verified|guarantee unavailable/,
      )
      assert.equal(reads, 0)
      assert.equal(observed.reads, 0)
      if (await swap.assertCompleted())
        context.skip(
          'Windows refused the parent rename while a child handle was open',
        )
      if (phase === 'opened') assert.equal(observed.closes, 1)
    })
  }
}

test('upload boundary preserves bytes, excludes metadata and accepts parent fallback', async () => {
  const { selected, external } = await fixture()
  await mkdir(join(selected, 'node_modules'))
  await symlink(
    external,
    join(selected, 'node_modules', 'unvisited'),
    'junction',
  )
  await writeFile(join(selected, '.hidden'), 'hidden')
  const preparation = readUploadBoundary(selected, { cwd: selected })
  const snapshot = await preparation
  assert.deepEqual(
    snapshot.files.map((file) => [file.relativePath, file.bytes.toString()]),
    [['index.html', '<p>selected</p>']],
  )
  assert.equal(
    observed.paths.some((path) => path.includes('node_modules')),
    false,
  )
  const outside = await readUploadBoundary(join(external, 'index.html'), {
    cwd: selected,
  })
  assert.equal(outside.files[0]!.bytes.toString(), 'external-sentinel')
  await assert.rejects(
    readUploadBoundary('../external/index.html', { cwd: selected }),
    /absolute path explicitly/,
  )
})

test('upload boundary supports nested cwd, git files and OS aliases above the root', async () => {
  const { selected } = await fixture()
  await rm(join(selected, '.git'), { recursive: true })
  await writeFile(join(selected, '.git'), 'gitdir: unused')
  const nested = join(selected, 'nested')
  await mkdir(nested)
  const path =
    process.platform === 'darwin'
      ? selected.replace(/^\/private\/var\//, '/var/')
      : selected
  const result = await readUploadBoundary('../index.html', { cwd: nested })
  assert.equal(result.files[0]!.bytes.toString(), '<p>selected</p>')
  assert.equal((await readUploadBoundary(path, { cwd: path })).directory, true)
})

test('upload boundary checks size after reading and rejects erased link components', async () => {
  const { selected, external } = await fixture()
  const path = join(selected, 'index.html')
  await assert.rejects(
    readUploadBoundary(path, {
      cwd: selected,
      hooks: {
        checkpoint: async (phase) => {
          if (phase === 'read') await writeFile(path, 'changed')
        },
      },
    }),
    /changed/,
  )
  await symlink(external, join(selected, 'link'), 'junction')
  await assert.rejects(
    readUploadBoundary(`${selected}/link/../index.html`, { cwd: selected }),
    /link/,
  )
})

for (const fault of ['identity', 'missing-identity', 'mismatch', 'read']) {
  test(`upload boundary closes handles on ${fault} failure`, async () => {
    const { selected } = await fixture()
    observed.fault = fault
    await assert.rejects(
      readUploadBoundary(join(selected, 'index.html')),
      /identity|verified|guarantee unavailable/,
    )
    assert.equal(observed.closes, 1)
    assert.equal(observed.reads, fault === 'read' ? 1 : 0)
  })
}

test('upload boundary rejects an alias at the fallback trust root without reading', async () => {
  const { root, external } = await fixture()
  const alias = join(root, 'alias')
  await symlink(
    external,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(
    readUploadBoundary(join(alias, 'index.html'), { cwd: root }),
    (error: Error) => {
      assert.match(error.message, /symbolic link|junction/)
      assert.ok(error.message.includes(alias))
      return true
    },
  )
  assert.equal(observed.reads, 0)
  assert.equal(observed.closes, 0)
})

test('upload boundary permits aliases strictly above the fallback trust root', async () => {
  const { root, external } = await fixture()
  const alias = join(root, 'alias')
  await symlink(
    external,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await mkdir(join(external, 'site'))
  await writeFile(join(external, 'site', 'index.html'), '<p>site</p>')
  const result = readUploadBoundary(join(alias, 'site', 'index.html'), {
    cwd: root,
  })
  assert.equal((await result).files[0]!.bytes.toString(), '<p>site</p>')
})

// Exercise Windows without O_NOFOLLOW on every CI OS as well as native Windows.
test('upload boundary accepts Windows regular files and empty directories with verified identities', async () => {
  const { selected } = await fixture()
  const empty = join(selected, 'empty')
  await mkdir(empty)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  observed.noFollowUnavailable = true
  try {
    const file = await readUploadBoundary(join(selected, 'index.html'), {
      cwd: selected,
    })
    assert.equal(file.files[0]!.bytes.toString(), '<p>selected</p>')
    const directory = await readUploadBoundary(empty, { cwd: selected })
    assert.equal(directory.directory, true)
    assert.deepEqual(directory.files, [])
    assert.equal(observed.reads, 1)
    assert.equal(observed.closes, 1)
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})

test('upload boundary fails closed when a required platform capability is unavailable', async () => {
  const { selected } = await fixture()
  observed.noFollowUnavailable = true
  if (process.platform === 'win32') observed.fault = 'missing-identity'
  await assert.rejects(
    readUploadBoundary(join(selected, 'index.html')),
    /guarantee unavailable/,
  )
  assert.equal(observed.reads, 0)
  assert.equal(observed.closes, process.platform === 'win32' ? 1 : 0)
})

if (process.platform === 'darwin') {
  test('upload boundary accepts the real macOS /tmp alias as the immediate fallback parent', async () => {
    const { root } = await fixture()
    const site = await mkdtemp('/tmp/upload-boundary-site-')
    roots.push(site)
    const html = `/tmp/${basename(site)}.html`
    const markdown = `/tmp/${basename(site)}.md`
    roots.push(html, markdown)
    await writeFile(html, '<p>selected</p>')
    await writeFile(markdown, '# Selected')
    await writeFile(join(site, 'index.html'), '<p>site</p>')
    assert.equal(
      (
        await readUploadBoundary(html, { cwd: root })
      ).files[0]!.bytes.toString(),
      '<p>selected</p>',
    )
    assert.equal(
      (
        await readUploadBoundary(markdown, { cwd: root, fileOnly: true })
      ).files[0]!.bytes.toString(),
      '# Selected',
    )
    assert.equal(
      (
        await readUploadBoundary(site, { cwd: root })
      ).files[0]!.bytes.toString(),
      '<p>site</p>',
    )
    await assert.rejects(
      readUploadBoundary('/tmp', { cwd: root }),
      /symbolic link/,
    )
  })
}

for (const operation of ['rename', 'symlink']) {
  test(`upload boundary race fixture reports ${operation} failure outside the boundary catch`, async () => {
    const { selected, external } = await fixture()
    const path = join(selected, 'index.html')
    const swap = uploadBoundarySwap({
      phase: 'before-open',
      parent: false,
      selected,
      external,
      path,
    })
    observed.swapFailure = operation
    await assert.rejects(
      readUploadBoundary(path, {
        cwd: selected,
        hooks: { checkpoint: swap.checkpoint },
      }),
      /verified/,
    )
    await assert.rejects(swap.assertCompleted(), /synthetic swap/)
    assert.equal(observed.reads, 0)
  })
}
