import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  rename,
  lstat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  readUploadBoundary,
  UploadBoundaryError,
  uploadInputPath,
} from './upload-boundary.js'
import { uploadBoundarySwap } from './test/upload-boundary-swap.js'

const observed = vi.hoisted(() => ({
  reads: 0,
  closes: 0,
  paths: [] as string[],
  fault: '' as string,
  noFollowUnavailable: false,
  swapFailure: '',
  inspected: [] as string[],
  readIdentities: [] as bigint[],
  ctimeChange: false,
  openError: undefined as Error | undefined,
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
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      observed.inspected.push(String(args[0]))
      return actual.lstat(...args)
    },
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
      if (observed.openError) throw observed.openError
      const handle = await actual.open(...args)
      const stat = handle.stat.bind(handle)
      const read = handle.readFile.bind(handle)
      const close = handle.close.bind(handle)
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const result = await stat(...statArgs)
        if (observed.ctimeChange && 'ctimeNs' in result)
          result.ctimeNs += 1_000_000n
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
        observed.readIdentities.push((await stat({ bigint: true })).ino)
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
  observed.inspected = []
  observed.readIdentities = []
  observed.ctimeChange = false
  observed.openError = undefined
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

for (const phase of ['before-open', 'read'] as const) {
  test(`upload boundary accepts ctime-only changes at ${phase}`, async () => {
    const { selected } = await fixture()
    const snapshot = await readUploadBoundary(join(selected, 'index.html'), {
      cwd: selected,
      hooks: {
        checkpoint: async (point) => {
          if (point === phase) observed.ctimeChange = true
        },
      },
    })
    assert.equal(observed.ctimeChange, true)
    assert.equal(snapshot.files[0]!.bytes.toString(), '<p>selected</p>')
    assert.equal(observed.reads, 1)
  })
}

for (const operation of ['delete', 'replace'] as const) {
  test(`upload boundary ignores excluded entries that ${operation} during preparation`, async () => {
    const { selected, external } = await fixture()
    const ignored = [
      '.DS_Store',
      '.index.swp',
      'Thumbs.db',
      'desktop.ini',
      'node_modules',
      '__MACOSX',
    ]
    for (const name of ignored) await writeFile(join(selected, name), 'ignored')
    let changed = false
    const result = await readUploadBoundary(selected, {
      cwd: selected,
      hooks: {
        checkpoint: async (phase) => {
          if (phase !== 'enumerated') return
          for (const name of ignored) {
            const path = join(selected, name)
            await rm(path)
            if (operation === 'replace')
              await symlink(join(external, 'index.html'), path, 'file')
          }
          changed = true
        },
      },
    })
    assert.equal(changed, true)
    assert.deepEqual(
      result.files.map((file) => file.relativePath),
      ['index.html'],
    )
    for (const name of ignored)
      assert.equal(observed.inspected.includes(join(selected, name)), false)
    assert.equal(observed.reads, 1)
  })
}

for (const phase of ['before-open', 'opened', 'read'] as const) {
  test(`upload boundary detects a parent below the trust root replaced at ${phase}`, async (context) => {
    const { selected, external } = await fixture()
    const parent = join(selected, 'site')
    await mkdir(parent)
    const path = join(parent, 'index.html')
    await writeFile(path, '<p>inside</p>')
    const outsideIdentity = (
      await lstat(join(external, 'index.html'), { bigint: true })
    ).ino
    const swap = uploadBoundarySwap({
      phase,
      parent: true,
      selected: parent,
      external,
      path,
    })
    let rejection: unknown
    await assert.rejects(
      readUploadBoundary(parent, {
        cwd: selected,
        hooks: { checkpoint: swap.checkpoint },
      }),
      (error: unknown) => {
        rejection = error
        return true
      },
    )
    const blockedByOpenHandle = await swap.assertCompleted()
    assert.equal(observed.readIdentities.includes(outsideIdentity), false)
    assert.equal(observed.reads, phase === 'read' ? 1 : 0)
    assert.equal(observed.closes, 1)
    if (blockedByOpenHandle)
      context.skip(
        'Windows refused the parent rename while a child handle was open',
      )
    assert.ok(rejection instanceof UploadBoundaryError)
    assert.match(rejection.message, /link|identity|verified/)
  })
}

for (const code of ['EACCES', 'EMFILE', 'EISDIR', undefined]) {
  test(`upload boundary preserves a safe diagnostic and cause for ${code ?? 'TypeError'}`, async () => {
    const { selected } = await fixture()
    const cause = Object.assign(new TypeError('external-sentinel test-token'), {
      code,
    })
    observed.openError = cause
    await assert.rejects(
      readUploadBoundary(join(selected, 'index.html')),
      (error: unknown) => {
        assert.ok(error instanceof UploadBoundaryError)
        assert.equal(error.cause, cause)
        assert.ok(error.message.includes(join(selected, 'index.html')))
        if (code) assert.ok(error.message.includes(`(${code})`))
        if (code === 'EACCES') assert.match(error.message, /permission denied/)
        assert.doesNotMatch(
          error.message + error.hint,
          /external-sentinel|test-token/,
        )
        assert.doesNotMatch(error.hint, /link target/)
        return true
      },
    )
    assert.equal(observed.reads, 0)
  })
}

test('upload boundary gives failure-specific recovery hints', async () => {
  const { selected } = await fixture()
  const missing = join(selected, 'missing.html')
  await assert.rejects(readUploadBoundary(missing), (error: unknown) => {
    assert.ok(error instanceof UploadBoundaryError)
    assert.match(error.message, /path was not found/)
    assert.equal(error.hint, `Check the path and retry: ${missing}`)
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
  await assert.rejects(
    readUploadBoundary(selected, { fileOnly: true }),
    (error: unknown) => {
      assert.ok(error instanceof UploadBoundaryError)
      assert.match(error.hint, /Select a regular file/)
      return true
    },
  )
  observed.fault = 'mismatch'
  await assert.rejects(
    readUploadBoundary(join(selected, 'index.html')),
    (error: unknown) => {
      assert.ok(error instanceof UploadBoundaryError)
      assert.equal(error.hint, 'Retry once the files stop changing.')
      return true
    },
  )
  observed.fault = 'missing-identity'
  await assert.rejects(
    readUploadBoundary(join(selected, 'index.html')),
    (error: unknown) => {
      assert.ok(error instanceof UploadBoundaryError)
      assert.match(
        error.hint,
        /platform or filesystem lacks the required upload safety guarantee/,
      )
      return true
    },
  )
})

for (const linked of [false, true]) {
  test(`upload boundary discovers a repository through an ancestor alias with inner link=${linked}`, async () => {
    const { root, selected, external } = await fixture()
    const alias = join(root, 'alias')
    await symlink(root, alias, 'junction')
    await mkdir(join(external, 'site'))
    await writeFile(join(external, 'site', 'index.html'), 'external-sentinel')
    const docs = join(selected, 'docs')
    if (linked) {
      await symlink(external, docs, 'junction')
    } else {
      await mkdir(join(docs, 'site'), { recursive: true })
      await writeFile(join(docs, 'site', 'index.html'), '<p>inside</p>')
    }
    const input = join(alias, 'selected', 'docs', 'site', 'index.html')
    if (linked) {
      await assert.rejects(
        readUploadBoundary(input, { cwd: selected }),
        (error: unknown) => {
          assert.ok(error instanceof UploadBoundaryError)
          assert.ok(error.message.includes(join(alias, 'selected', 'docs')))
          assert.match(error.hint, /Copy the file/)
          return true
        },
      )
      assert.equal(observed.reads, 0)
    } else {
      const result = await readUploadBoundary(input, { cwd: selected })
      assert.equal(result.files[0]!.bytes.toString(), '<p>inside</p>')
      assert.equal(observed.reads, 1)
    }
  })
}

test('upload boundary checks relative parents outside Git from cwd', async () => {
  const { root, external } = await fixture()
  await mkdir(join(external, 'site'))
  await writeFile(join(external, 'site', 'index.html'), 'external-sentinel')
  await symlink(external, join(root, 'build'), 'junction')
  await assert.rejects(
    readUploadBoundary('build/site/index.html', { cwd: root }),
    /symbolic link|junction/,
  )
  assert.equal(observed.reads, 0)
})

test('upload boundary explains relative repository escapes separately from links', async () => {
  const { selected } = await fixture()
  await assert.rejects(
    readUploadBoundary('../external/index.html', { cwd: selected }),
    (error: unknown) => {
      assert.ok(error instanceof UploadBoundaryError)
      assert.equal(
        error.hint,
        'Pass the absolute path to share a file outside this repository.',
      )
      assert.ok(error.message.includes('../external/index.html'))
      return true
    },
  )
  assert.equal(observed.reads, 0)
})

test('upload boundary preserves Windows drive-relative components from the drive current directory', () => {
  const cwd = String.raw`C:\repo`
  for (const input of [
    'C:report.html',
    'C:site',
    String.raw`C:link\..\report.html`,
  ]) {
    assert.equal(
      uploadInputPath(input, cwd, win32),
      `${cwd}\\${input.slice(2)}`,
    )
  }
  assert.equal(
    uploadInputPath('D:report.html', cwd, win32),
    `${win32.resolve(cwd, 'D:.')}\\report.html`,
  )
})

if (process.platform === 'win32') {
  test('upload boundary accepts drive-relative files and directories and rejects links', async () => {
    const { selected, external } = await fixture()
    const drive = win32.parse(selected).root.slice(0, 2)
    const file = await readUploadBoundary(`${drive}index.html`, {
      cwd: selected,
    })
    assert.equal(file.files[0]!.bytes.toString(), '<p>selected</p>')
    await mkdir(join(selected, 'site'))
    await writeFile(join(selected, 'site', 'index.html'), '<p>site</p>')
    const directory = await readUploadBoundary(`${drive}site`, {
      cwd: selected,
    })
    assert.equal(directory.directory, true)
    assert.equal(directory.files[0]!.bytes.toString(), '<p>site</p>')
    await symlink(external, join(selected, 'link'), 'junction')
    observed.reads = 0
    await assert.rejects(
      readUploadBoundary(`${drive}link`, { cwd: selected }),
      /symbolic link|junction/,
    )
    assert.equal(observed.reads, 0)
  })
}

for (const marker of ['file', 'directory'] as const) {
  for (const inputKind of ['relative', 'absolute', 'ancestor alias'] as const) {
    for (const directory of [false, true]) {
      test(`upload boundary rejects a nested Git ${marker} reached through a link for ${inputKind} ${directory ? 'directory' : 'file'} input`, async () => {
        const { root, selected, external } = await fixture()
        const nested = join(external, 'nested')
        await mkdir(nested)
        if (marker === 'file')
          await writeFile(join(nested, '.git'), 'gitdir: unused')
        else await mkdir(join(nested, '.git'))
        await writeFile(join(nested, 'index.html'), 'external-sentinel')
        const link = join(selected, 'vendor')
        await symlink(external, link, 'junction')
        const suffix = directory
          ? join('vendor', 'nested')
          : join('vendor', 'nested', 'index.html')
        let input = inputKind === 'relative' ? suffix : join(selected, suffix)
        let offending = link
        if (inputKind === 'ancestor alias') {
          const alias = join(root, 'alias')
          await symlink(root, alias, 'junction')
          input = join(alias, 'selected', suffix)
          offending = join(alias, 'selected', 'vendor')
        }
        await assert.rejects(
          readUploadBoundary(input, { cwd: selected }),
          (error: unknown) => {
            assert.ok(error instanceof UploadBoundaryError)
            assert.ok(error.message.includes(offending))
            assert.match(error.hint, /Copy the file/)
            return true
          },
        )
        assert.equal(observed.reads, 0)
        assert.equal(observed.paths.length, 0)
      })
    }
  }
}

test('upload boundary keeps cwd protection when a relative link reaches a Git marker outside Git', async () => {
  const { root, external } = await fixture()
  await mkdir(join(external, 'nested'))
  await mkdir(join(external, 'nested', '.git'))
  await writeFile(join(external, 'nested', 'index.html'), 'external-sentinel')
  await symlink(external, join(root, 'vendor'), 'junction')
  await assert.rejects(
    readUploadBoundary(join('vendor', 'nested', 'index.html'), { cwd: root }),
    /symbolic link|junction/,
  )
  assert.equal(observed.reads, 0)
})

test('upload boundary accepts a regular nested repository through an ancestor alias', async () => {
  const { root, selected } = await fixture()
  const nested = join(selected, 'nested')
  await mkdir(nested)
  await writeFile(join(nested, '.git'), 'gitdir: unused')
  await writeFile(join(nested, 'index.html'), '<p>nested</p>')
  const alias = join(root, 'alias')
  await symlink(root, alias, 'junction')
  const result = await readUploadBoundary(join(alias, 'selected', 'nested'), {
    cwd: selected,
  })
  assert.deepEqual(
    result.files.map((file) => [file.relativePath, file.bytes.toString()]),
    [['index.html', '<p>nested</p>']],
  )
})

for (const marker of ['file', 'directory'] as const) {
  test(`upload boundary trusts aliases above the nearest Git ${marker} inside an outer repository`, async () => {
    const { root, selected, external } = await fixture()
    const home = join(root, 'home')
    await mkdir(join(home, '.git'), { recursive: true })
    const project = join(external, 'project')
    await mkdir(project)
    if (marker === 'file')
      await writeFile(join(project, '.git'), 'gitdir: unused')
    else await mkdir(join(project, '.git'))
    await writeFile(join(project, 'index.html'), '<p>project</p>')
    await symlink(external, join(home, 'code'), 'junction')
    const input = join(home, 'code', 'project', 'index.html')
    const result = await readUploadBoundary(input, { cwd: selected })
    assert.equal(result.files[0]!.bytes.toString(), '<p>project</p>')
    assert.equal(observed.reads, 1)
    assert.deepEqual(observed.readIdentities, [
      (await lstat(join(project, 'index.html'), { bigint: true })).ino,
    ])
  })
}

for (const linked of [false, true]) {
  test(`upload boundary retains cwd's worktree through a direct root alias with inner link=${linked}`, async () => {
    const { root, selected, external } = await fixture()
    const alias = join(root, 'alias')
    await symlink(selected, alias, 'junction')
    const docs = join(selected, 'docs')
    if (linked) await symlink(external, docs, 'junction')
    else await mkdir(docs)
    const nested = join(linked ? external : docs, 'private')
    await mkdir(join(nested, '.git'), { recursive: true })
    await writeFile(
      join(nested, 'index.html'),
      linked ? 'external-sentinel' : '<p>inside</p>',
    )
    const input = join(alias, 'docs', 'private', 'index.html')
    if (linked) {
      await assert.rejects(
        readUploadBoundary(input, { cwd: selected }),
        (error: unknown) => {
          assert.ok(error instanceof UploadBoundaryError)
          assert.ok(error.message.includes(join(alias, 'docs')))
          assert.match(error.hint, /Copy the file/)
          return true
        },
      )
      assert.equal(observed.reads, 0)
      assert.deepEqual(observed.readIdentities, [])
    } else {
      const result = await readUploadBoundary(input, { cwd: selected })
      assert.equal(result.files[0]!.bytes.toString(), '<p>inside</p>')
      assert.equal(observed.reads, 1)
      assert.deepEqual(observed.readIdentities, [
        (await lstat(join(nested, 'index.html'), { bigint: true })).ino,
      ])
    }
  })
}

for (const marker of ['file', 'directory'] as const) {
  for (const directory of [false, true]) {
    test(`upload boundary rejects an alias entering a worktree descendant before a nested Git ${marker} for ${directory ? 'directory' : 'file'} input`, async () => {
      const { root, selected, external } = await fixture()
      const subdirectory = join(selected, 'docs')
      await mkdir(subdirectory)
      const alias = join(root, 'alias')
      await symlink(subdirectory, alias, 'junction')
      await symlink(external, join(subdirectory, 'linked'), 'junction')
      const nested = join(external, 'private')
      await mkdir(nested)
      if (marker === 'file')
        await writeFile(join(nested, '.git'), 'gitdir: unused')
      else await mkdir(join(nested, '.git'))
      await writeFile(join(nested, 'index.html'), 'external-sentinel')
      const input = directory
        ? join(alias, 'linked', 'private')
        : join(alias, 'linked', 'private', 'index.html')
      await assert.rejects(
        readUploadBoundary(input, { cwd: selected }),
        (error: unknown) => {
          assert.ok(error instanceof UploadBoundaryError)
          assert.ok(error.message.includes(alias))
          assert.match(error.hint, /Copy the file/)
          return true
        },
      )
      assert.equal(observed.reads, 0)
      assert.deepEqual(observed.readIdentities, [])
      assert.deepEqual(observed.paths, [])
    })
  }
}
