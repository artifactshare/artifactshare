import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'vitest'
import {
  prepareUploadSelection,
  uploadReadError,
  type UploadBoundaryDependencies,
} from './upload-boundary.js'

async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'upload-boundary-')),
  )
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'selected')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'report.html'), '<p>selected</p>')
  const outside = path.join(root, 'outside.html')
  await fs.writeFile(outside, 'outside sentinel')
  return { root, cwd, outside }
}

async function rejection(
  action: Promise<unknown>,
  reason: string,
  display: string,
) {
  await assert.rejects(action, (error) => {
    const safe = uploadReadError(error, display)
    assert.equal(safe.code, 'validation_failed')
    assert.equal(safe.details?.reason, reason)
    assert.equal(safe.details?.path, display)
    assert.ok(safe.message.includes(display))
    assert.ok(safe.hint.length > 0)
    return true
  })
}

async function link(
  t: TestContext,
  target: string,
  name: string,
  directory = false,
) {
  try {
    await fs.symlink(target, name, directory ? 'junction' : 'file')
  } catch (error) {
    if (process.platform !== 'win32') throw error
    assert.ok(
      ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!),
    )
    t.skip('Windows refused link creation on this filesystem')
  }
}

for (const input of [
  '../outside.html',
  'report.html/../x.html',
  'link/..',
  './a/../../x',
  '/a/../x',
  'C:\\a\\..\\x',
  'D:..\\x',
  'a\\..\\x',
]) {
  test(`rejects traversal before filesystem access: ${input}`, async (t) => {
    const { cwd } = await fixture(t)
    let calls = 0
    await rejection(
      prepareUploadSelection(input, false, {
        cwd,
        lstat: async () => {
          calls++
          throw new Error('unexpected lstat')
        },
        realpath: async () => {
          calls++
          throw new Error('unexpected realpath')
        },
      }),
      'parent_traversal',
      input,
    )
    assert.equal(calls, 0)
  })
}

for (const variant of [
  'file',
  'directory',
  'parent',
  'descendant',
  'descendant-directory',
  'dangling',
]) {
  test(`rejects ${variant} links without opening content`, async (t) => {
    const { cwd, outside, root } = await fixture(t)
    const name = path.join(cwd, 'linked')
    const directory = ['directory', 'parent', 'descendant-directory'].includes(
      variant,
    )
    await link(
      t,
      variant === 'dangling'
        ? path.join(root, 'missing')
        : directory
          ? root
          : outside,
      name,
      directory,
    )
    const input =
      variant === 'parent'
        ? 'linked/outside.html'
        : variant.startsWith('descendant') || variant === 'dangling'
          ? '.'
          : 'linked'
    let opens = 0
    await rejection(
      prepareUploadSelection(input, false, {
        cwd,
        open: async () => {
          opens++
          throw new Error('sentinel must not be opened')
        },
      }),
      'link',
      input === '.' ? 'linked' : input,
    )
    assert.equal(opens, 0)
  })
}

test('physical cwd aliases and explicit absolute linked parents work', async (t) => {
  const { cwd, root } = await fixture(t)
  const alias = path.join(root, 'alias')
  await link(t, cwd, alias, true)
  let realpaths = 0
  const selection = await prepareUploadSelection('report.html', false, {
    cwd: alias,
    realpath: async (name) => {
      realpaths++
      return fs.realpath(name)
    },
  })
  assert.equal(await selection.files[0]!.blob.text(), '<p>selected</p>')
  assert.equal(realpaths, 2)
  const absolute = await prepareUploadSelection(path.join(alias, 'report.html'))
  assert.equal(await absolute.files[0]!.blob.text(), '<p>selected</p>')
})

for (const input of ['.', './', '././']) {
  test(`physical cwd alias accepts directory selection ${input}`, async (t) => {
    const { cwd, root } = await fixture(t)
    const alias = path.join(root, 'alias')
    await link(t, cwd, alias, true)
    const selection = await prepareUploadSelection(input, false, { cwd: alias })
    assert.equal(selection.directory, true)
    assert.deepEqual(
      selection.files.map((file) => file.name),
      ['report.html'],
    )
    assert.equal(await selection.files[0]!.blob.text(), '<p>selected</p>')
  })
}

for (const input of ['.', './', '.\\', '.\\.\\']) {
  test(`Windows junction cwd uses physical root for ${input}`, async (t) => {
    const { cwd, root } = await fixture(t)
    const alias = path.join(root, 'alias')
    await link(t, cwd, alias, true)
    const windowsAlias = 'C:\\alias'
    const windowsRoot = 'C:\\selected'
    const translate = (name: string) => {
      const resolved = path.win32.resolve(name)
      if (resolved === windowsAlias) return alias
      if (resolved === windowsRoot) return cwd
      assert.equal(resolved, path.win32.join(windowsRoot, 'report.html'))
      return path.join(cwd, 'report.html')
    }
    let aliasInspections = 0
    const selection = await prepareUploadSelection(input, false, {
      cwd: windowsAlias,
      paths: path.win32,
      realpath: async (name) => {
        if (name === windowsAlias) return windowsRoot
        assert.equal(name, path.win32.join(windowsRoot, 'report.html'))
        return name
      },
      lstat: (name) => {
        const translated = translate(name)
        if (translated === alias) aliasInspections++
        return fs.lstat(translated, { bigint: true })
      },
      readdir: (name) => fs.readdir(translate(name)),
      open: (name, flags) => fs.open(translate(String(name)), flags),
    })
    assert.equal(aliasInspections, 0)
    assert.equal(selection.directory, true)
    assert.deepEqual(
      selection.files.map((file) => file.name),
      ['report.html'],
    )
    assert.equal(await selection.files[0]!.blob.text(), '<p>selected</p>')
  })
}

test('case aliases use filesystem identity, with capability probe', async (t) => {
  const { cwd } = await fixture(t)
  const alias = path.join(cwd, 'Report.html')
  if (!(await fs.lstat(alias).catch(() => null)))
    t.skip('Filesystem is case-sensitive')
  assert.equal(
    (await prepareUploadSelection('Report.html', false, { cwd })).files.length,
    1,
  )
})

for (const variant of ['relative', 'absolute', 'component'] as const) {
  test(`typed short-name alias accepts the same identity: ${variant}`, async (t) => {
    const { cwd } = await fixture(t)
    const directory = path.join(cwd, 'Program Files')
    await fs.mkdir(directory)
    const stored = path.join(directory, 'Long Report.html')
    await fs.writeFile(stored, 'selected alias')
    const aliasDirectory = path.join(cwd, 'PROGRA~1')
    const aliasFile = path.join(directory, 'LONGRE~1.HTM')
    const translate = (name: string) => {
      if (name === aliasDirectory) return directory
      if (name === path.join(aliasDirectory, 'LONGRE~1.HTM')) return stored
      if (name === aliasFile) return stored
      return name
    }
    const input =
      variant === 'absolute'
        ? aliasFile
        : path.join(
            variant === 'component' ? 'PROGRA~1' : 'Program Files',
            'LONGRE~1.HTM',
          )
    let opens = 0
    const selection = await prepareUploadSelection(input, false, {
      cwd,
      lstat: (name) => fs.lstat(translate(name), { bigint: true }),
      realpath: (name) => fs.realpath(translate(name)),
      open: async (name, flags) => {
        opens++
        assert.equal(translate(String(name)), stored)
        return fs.open(stored, flags)
      },
    })
    assert.equal(opens, 1)
    assert.equal(selection.files.length, 1)
    assert.equal(await selection.files[0]!.blob.text(), 'selected alias')
  })
}

for (const [typedName, storedName] of [
  ['Σ.html', 'σ.html'],
  ['σ.html', 'σ.html'],
  ['ς.html', 'σ.html'],
  ['ς[1]+.html', 'σ[1]+.html'],
] as const) {
  test(`Unicode sigma alias ${typedName} accepts the same file identity`, async (t) => {
    const { cwd } = await fixture(t)
    const stored = path.join(cwd, storedName)
    const typed = path.join(cwd, typedName)
    await fs.writeFile(stored, 'selected sigma')
    let reads = 0
    const selection = await prepareUploadSelection(typedName, false, {
      cwd,
      lstat: (name) =>
        fs.lstat(name === typed ? stored : name, { bigint: true }),
      realpath: (name) => fs.realpath(name === typed ? stored : name),
      open: async (name, flags) => {
        assert.equal(String(name), typed)
        reads++
        return fs.open(stored, flags)
      },
    })
    assert.equal(reads, 1)
    assert.equal(selection.files.length, 1)
    assert.equal(await selection.files[0]!.blob.text(), 'selected sigma')
  })
}

test('macOS NFC input reaches NFD stored filename', async (t) => {
  const { cwd } = await fixture(t)
  if (process.platform !== 'darwin') t.skip('macOS normalization behavior')
  await fs.writeFile(path.join(cwd, 'cafe\u0301.md'), 'hello')
  assert.equal(
    await (
      await prepareUploadSelection('caf\u00e9.md', false, { cwd })
    ).files[0]!.blob.text(),
    'hello',
  )
})

test('name exclusions happen before inspection, including reparse-like entries', async (t) => {
  const { cwd } = await fixture(t)
  const excluded = [
    '.hidden',
    '__MACOSX',
    'node_modules',
    'Thumbs.db',
    'desktop.ini',
  ]
  const inspected: string[] = []
  const selected = await prepareUploadSelection('.', false, {
    cwd,
    readdir: async () => ['report.html', ...excluded],
    realpath: async (name) => {
      assert.ok(!excluded.includes(path.basename(name)))
      return fs.realpath(name)
    },
    lstat: async (name) => {
      inspected.push(path.basename(name))
      assert.ok(!excluded.includes(path.basename(name)))
      return fs.lstat(name, { bigint: true })
    },
  })
  assert.deepEqual(
    selected.files.map((f) => f.name),
    ['report.html'],
  )
  assert.ok(inspected.includes('report.html'))
})

test('ctime changes and hidden entries disappearing do not invalidate content', async (t) => {
  const { cwd } = await fixture(t)
  await fs.writeFile(path.join(cwd, '.hidden'), 'hidden')
  const selected = await prepareUploadSelection('.', false, {
    cwd,
    lstat: async (name) =>
      Object.assign(await fs.lstat(name, { bigint: true }), {
        ctimeNs: BigInt(Date.now()),
      }),
    checkpoint: async (phase) => {
      if (phase === 'before_open') await fs.rm(path.join(cwd, '.hidden'))
    },
  })
  assert.equal(await selected.files[0]!.blob.text(), '<p>selected</p>')
})

for (const phase of [
  'entry',
  'before_open',
  'after_open',
  'after_read',
] as const) {
  for (const directory of [false, true]) {
    test(`detects ${directory ? 'parent' : 'leaf'} replacement at ${phase}`, async (t) => {
      const { cwd } = await fixture(t)
      const sub = path.join(cwd, 'sub')
      await fs.mkdir(sub)
      const leaf = path.join(sub, 'page.html')
      await fs.writeFile(leaf, 'original')
      let swapped = false
      let reads = 0
      let closes = 0
      let refused = false
      const result = prepareUploadSelection('.', false, {
        cwd,
        checkpoint: async (at, name) => {
          if (at !== phase || name !== leaf || swapped) return
          const target = directory ? sub : leaf
          try {
            await fs.rename(target, `${target}-old`)
          } catch (error) {
            if (process.platform !== 'win32') throw error
            assert.ok(
              ['EPERM', 'EACCES', 'EBUSY'].includes(
                (error as NodeJS.ErrnoException).code!,
              ),
            )
            refused = true
            throw error
          }
          if (directory) await fs.mkdir(sub)
          await fs.writeFile(leaf, 'replacement')
          swapped = true
        },
        open: async (...args) => {
          assert.equal(
            args[1],
            constants.O_RDONLY |
              (constants.O_NOFOLLOW ?? 0) |
              (constants.O_NONBLOCK ?? 0),
          )
          const handle = await fs.open(...args)
          const read = handle.readFile.bind(handle)
          const close = handle.close.bind(handle)
          handle.readFile = (() => {
            reads++
            return read()
          }) as typeof handle.readFile
          handle.close = () => {
            closes++
            return close()
          }
          return handle
        },
      })
      const outcome = await result.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      if (refused) {
        assert.equal(swapped, false)
        t.skip('Windows refused replacement of an open selection')
      }
      // At entry the leaf has not been recorded yet: a regular replacement is
      // the selected file. Replace a recorded parent to test enumeration races.
      if (phase === 'entry' && !directory) {
        const selection = outcome.value!
        assert.equal(swapped, true)
        assert.equal(
          await selection.files
            .find((f) => f.name === 'sub/page.html')!
            .blob.text(),
          'replacement',
        )
      } else {
        assert.equal(swapped, true)
        assert.ok(outcome.error)
        assert.equal(
          uploadReadError(outcome.error, '.').details?.reason,
          'changed',
        )
        if (phase === 'entry') assert.equal(reads, 0)
        if (phase === 'before_open') assert.equal(reads, 1) // report.html precedes sub/page.html
        if (phase === 'after_open') assert.equal(reads, 1)
        assert.equal(
          closes,
          phase === 'after_open' || phase === 'after_read'
            ? 2
            : phase === 'entry'
              ? 0
              : 1,
        )
      }
    })
  }
}

for (const errno of ['EACCES', 'EMFILE', 'EIO', 'EPERM']) {
  test(`filesystem ${errno} retains safe recovery and original cause`, async (t) => {
    const { cwd } = await fixture(t)
    const cause = Object.assign(new Error('sensitive filesystem message'), {
      code: errno,
    })
    await assert.rejects(
      prepareUploadSelection('report.html', false, {
        cwd,
        lstat: async () => {
          throw cause
        },
      }),
      (error) => {
        const safe = uploadReadError(error, 'report.html')
        assert.equal(safe.code, 'upload_read_failed')
        assert.equal(safe.details?.errno, errno)
        assert.equal((safe as { cause?: unknown }).cause, cause)
        assert.equal(safe.recovery.kind, 'retry_later')
        assert.ok(!JSON.stringify(safe).includes('sensitive'))
        return true
      },
    )
  })
}

test('missing identities fail closed but device zero is supported', async (t) => {
  const { cwd } = await fixture(t)
  await rejection(
    prepareUploadSelection('report.html', false, {
      cwd,
      lstat: async (name) =>
        Object.assign(await fs.lstat(name, { bigint: true }), { ino: 0n }),
    }),
    'unsupported_guarantee',
    'report.html',
  )
  const deps: UploadBoundaryDependencies = {
    cwd,
    lstat: async (name) =>
      Object.assign(await fs.lstat(name, { bigint: true }), { dev: 0n }),
    open: async (...args) => {
      const handle = await fs.open(...args)
      const stat = handle.stat.bind(handle)
      handle.stat = (async () =>
        Object.assign(await stat({ bigint: true }), {
          dev: 0n,
        })) as typeof handle.stat
      return handle
    },
  }
  assert.equal(
    (await prepareUploadSelection('report.html', false, deps)).files.length,
    1,
  )
})

test('typed-path identity mismatch is outside cwd, not a spelling comparison', async (t) => {
  const { cwd, outside } = await fixture(t)
  let calls = 0
  await rejection(
    prepareUploadSelection('report.html', false, {
      cwd,
      lstat: async (name) => {
        if (name === path.join(cwd, 'report.html') && ++calls === 2)
          return fs.lstat(outside, { bigint: true })
        return fs.lstat(name, { bigint: true })
      },
    }),
    'outside_cwd',
    'report.html',
  )
})

for (const input of [
  'C:report.html',
  'D:report.html',
  'report.html.',
  'report.html ',
]) {
  test(`Windows path helpers preserve identity for ${input}`, async (t) => {
    const { cwd } = await fixture(t)
    const root = 'C:\\selected'
    const actual = path.join(cwd, 'report.html')
    let realpaths = 0
    const resolvedInput = path.win32.resolve(root, input)
    const parent = path.win32.dirname(resolvedInput)
    const translate = (name: string) =>
      name === root || name === parent ? cwd : actual
    const result = await prepareUploadSelection(input, false, {
      cwd: root,
      paths: path.win32,
      realpath: async (name) => {
        realpaths++
        return name === root || name === parent
          ? root
          : path.win32.join(root, 'report.html')
      },
      lstat: (name) => fs.lstat(translate(name), { bigint: true }),
      open: (name, flags) => fs.open(translate(String(name)), flags),
    })
    assert.equal(await result.files[0]!.blob.text(), '<p>selected</p>')
    assert.equal(realpaths, 2)
  })
}

test('missing selection and append directory rejection are specific', async (t) => {
  const { cwd } = await fixture(t)
  await rejection(
    prepareUploadSelection('missing', false, { cwd }),
    'not_found',
    'missing',
  )
  await rejection(
    prepareUploadSelection('.', true, {
      cwd,
      readdir: async () => {
        throw new Error('must not enumerate')
      },
    }),
    'invalid_type',
    '.',
  )
})

test('rejects an included leaf changed to a link during enumeration without reads', async (t) => {
  const { cwd, outside } = await fixture(t)
  const leaf = path.join(cwd, 'report.html')
  const probe = path.join(cwd, 'probe')
  await link(t, outside, probe)
  await fs.rm(probe)
  let swapped = false
  let opens = 0
  await assert.rejects(
    prepareUploadSelection('.', false, {
      cwd,
      checkpoint: async (phase, name) => {
        if (phase !== 'entry' || name !== leaf) return
        await fs.rm(leaf)
        await fs.symlink(outside, leaf, 'file')
        swapped = true
      },
      open: async () => {
        opens++
        throw new Error('must not open sentinel')
      },
    }),
    (error) => {
      assert.equal(swapped, true)
      const safe = uploadReadError(error, '.')
      assert.equal(safe.details?.reason, 'link')
      assert.equal(safe.details?.path, 'report.html')
      return true
    },
  )
  assert.equal(opens, 0)
})

test('special files fail before opening', async (t) => {
  const { cwd } = await fixture(t)
  await rejection(
    prepareUploadSelection('report.html', false, {
      cwd,
      lstat: async (name) => {
        const stat = await fs.lstat(name, { bigint: true })
        if (name.endsWith('report.html')) stat.isFile = () => false
        return stat
      },
    }),
    'invalid_type',
    'report.html',
  )
})

test('no-follow failure names the missing guarantee and retains cause', async (t) => {
  const { cwd } = await fixture(t)
  if (!constants.O_NOFOLLOW) t.skip('Platform does not expose O_NOFOLLOW')
  const cause = Object.assign(new Error('unavailable'), { code: 'ENOTSUP' })
  await assert.rejects(
    prepareUploadSelection('report.html', false, {
      cwd,
      open: async () => {
        throw cause
      },
    }),
    (error) => {
      const safe = uploadReadError(error, 'report.html')
      assert.equal(safe.details?.reason, 'unsupported_guarantee')
      assert.match(safe.hint, /O_NOFOLLOW/)
      assert.equal((safe as { cause?: unknown }).cause, cause)
      return true
    },
  )
})

for (const change of [
  'size',
  'mode',
  'read-error',
  'checkpoint-error',
] as const) {
  test(`closes the handle and rejects ${change} after open`, async (t) => {
    const { cwd } = await fixture(t)
    let closed = 0
    let reads = 0
    const cause = Object.assign(new Error('internal error'), { code: 'EIO' })
    await assert.rejects(
      prepareUploadSelection('report.html', false, {
        cwd,
        checkpoint: async (phase, name) => {
          if (change === 'checkpoint-error' && phase === 'after_open')
            throw cause
          if (change === 'size' && phase === 'after_read')
            await fs.appendFile(name, 'changed')
        },
        open: async (...args) => {
          const handle = await fs.open(...args)
          const close = handle.close.bind(handle)
          const read = handle.readFile.bind(handle)
          const stat = handle.stat.bind(handle)
          handle.close = () => {
            closed++
            return close()
          }
          handle.readFile = (async () => {
            reads++
            if (change === 'read-error') throw cause
            return read()
          }) as typeof handle.readFile
          if (change === 'mode')
            handle.stat = (async () => {
              const result = await stat({ bigint: true })
              return Object.assign(result, { mode: result.mode ^ 0o100n })
            }) as typeof handle.stat
          return handle
        },
      }),
      (error) => {
        const safe = uploadReadError(error, 'report.html')
        if (change === 'read-error' || change === 'checkpoint-error') {
          assert.equal(safe.code, 'upload_read_failed')
          assert.equal((safe as { cause?: unknown }).cause, cause)
        } else assert.equal(safe.details?.reason, 'changed')
        return true
      },
    )
    assert.equal(closed, 1)
    assert.equal(
      reads,
      change === 'mode' || change === 'checkpoint-error' ? 0 : 1,
    )
  })
}

for (const name of ['x:d', 'x:']) {
  test(`accepts a regular POSIX directory named ${name} within physical cwd`, async (t) => {
    if (process.platform === 'win32') t.skip('Colon-prefixed POSIX names')
    const { cwd } = await fixture(t)
    await fs.mkdir(path.join(cwd, name))
    await fs.writeFile(path.join(cwd, name, 'report.html'), 'selected content')
    let realpaths = 0
    const selection = await prepareUploadSelection(
      `${name}/report.html`,
      false,
      {
        cwd,
        realpath: async (directory) => {
          realpaths++
          return fs.realpath(directory)
        },
      },
    )
    assert.equal(realpaths, 3)
    assert.equal(await selection.files[0]!.blob.text(), 'selected content')
  })
}

test('nonblocking open checks regular-file type before reading', async (t) => {
  const { cwd } = await fixture(t)
  let opened = false
  let reads = 0
  let closed = false
  await rejection(
    prepareUploadSelection('report.html', false, {
      cwd,
      open: async (...args) => {
        assert.equal(
          args[1],
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        )
        const handle = await fs.open(...args)
        opened = true
        const stat = handle.stat.bind(handle)
        const close = handle.close.bind(handle)
        handle.stat = (async () => {
          const result = await stat({ bigint: true })
          result.isFile = () => false
          return result
        }) as typeof handle.stat
        handle.readFile = (async () => {
          reads++
          throw new Error('non-regular handle must not be read')
        }) as typeof handle.readFile
        handle.close = async () => {
          closed = true
          await close()
        }
        return handle
      },
    }),
    'changed',
    'report.html',
  )
  assert.equal(opened, true)
  assert.equal(reads, 0)
  assert.equal(closed, true)
})

for (const primary of ['boundary', 'read', 'none'] as const) {
  test(`close failure preserves the primary ${primary} failure`, async (t) => {
    const { cwd } = await fixture(t)
    const readError = Object.assign(new Error('read failed'), { code: 'EIO' })
    const closeError = Object.assign(new Error('close failed'), { code: 'EIO' })
    let closed = 0
    await assert.rejects(
      prepareUploadSelection('report.html', false, {
        cwd,
        open: async (...args) => {
          const handle = await fs.open(...args)
          const close = handle.close.bind(handle)
          const stat = handle.stat.bind(handle)
          if (primary === 'boundary')
            handle.stat = (async () => {
              const result = await stat({ bigint: true })
              result.size++
              return result
            }) as typeof handle.stat
          if (primary === 'read')
            handle.readFile = (async () => {
              throw readError
            }) as typeof handle.readFile
          handle.close = async () => {
            closed++
            await close()
            throw closeError
          }
          return handle
        },
      }),
      (error) => {
        const safe = uploadReadError(error, 'report.html')
        assert.equal(safe.details?.path, 'report.html')
        if (primary === 'boundary') {
          assert.equal(safe.code, 'validation_failed')
          assert.equal(safe.details?.reason, 'changed')
        } else {
          assert.equal(safe.code, 'upload_read_failed')
          assert.equal(
            (safe as { cause?: unknown }).cause,
            primary === 'read' ? readError : closeError,
          )
        }
        return true
      },
    )
    assert.equal(closed, 1)
  })
}

for (const variant of [
  'relative',
  'absolute',
  'component',
  'descendant',
  'file',
] as const) {
  for (const location of variant === 'descendant'
    ? ['outside', 'sibling', 'sibling-case']
    : ['outside']) {
    test(`rejects a ${location} redirect reported as an ordinary ${variant} entry`, async (t) => {
      const { cwd, root, outside } = await fixture(t)
      const redirected = path.join(cwd, 'assets')
      const target = path.join(
        location === 'outside' ? root : cwd,
        location === 'sibling-case' ? 'ASSETS' : 'node_modules',
      )
      const fileTarget =
        location === 'outside' ? outside : path.join(cwd, 'report.html')
      await fs.mkdir(target)
      await fs.writeFile(path.join(target, 'page.html'), 'outside sentinel')
      // The seam models a reparse redirect without requiring platform privileges.
      const input =
        variant === 'absolute'
          ? redirected
          : variant === 'component'
            ? 'assets/page.html'
            : variant === 'descendant'
              ? '.'
              : 'assets'
      let redirectInspected = false
      let opens = 0
      let descents = 0
      await assert.rejects(
        prepareUploadSelection(input, false, {
          cwd,
          lstat: async (name) => {
            if (name === redirected) {
              redirectInspected = true
              return fs.lstat(variant === 'file' ? fileTarget : target, {
                bigint: true,
              })
            }
            return fs.lstat(name, { bigint: true })
          },
          realpath: async (name) =>
            name === redirected
              ? variant === 'file'
                ? fileTarget
                : target
              : fs.realpath(name),
          readdir: async (name) => {
            if (name === cwd) return ['assets']
            descents++
            return fs.readdir(target)
          },
          open: async () => {
            opens++
            throw new Error('outside content must not be opened')
          },
        }),
        (error) => {
          assert.equal(redirectInspected, true)
          const safe = uploadReadError(error, input)
          assert.equal(safe.code, 'validation_failed')
          assert.equal(safe.details?.reason, 'link')
          assert.equal(
            safe.details?.path,
            variant === 'descendant' ? 'assets' : input,
          )
          return true
        },
      )
      assert.equal(opens, 0)
      assert.equal(descents, 0)
    })
  }
}

test('physical parent aliases are accepted by identity and resolved only once', async (t) => {
  const { cwd, root } = await fixture(t)
  const dir = path.join(cwd, 'assets')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'page.html'), 'selected')
  const alias = path.join(root, 'physical-parent-alias')
  const calls = new Map<string, number>()
  const selection = await prepareUploadSelection('.', false, {
    cwd,
    realpath: async (name) => {
      calls.set(name, (calls.get(name) ?? 0) + 1)
      if (name === path.join(dir, 'page.html'))
        return path.join(alias, 'page.html')
      return fs.realpath(name)
    },
    lstat: (name) => fs.lstat(name === alias ? dir : name, { bigint: true }),
  })
  assert.deepEqual(
    selection.files.map((file) => file.name),
    ['assets/page.html', 'report.html'],
  )
  assert.equal(await selection.files[0]!.blob.text(), 'selected')
  assert.equal(calls.size, 4)
  for (const count of calls.values()) assert.equal(count, 1)
})

for (const errno of ['EACCES', 'EIO']) {
  test(`physical-path ${errno} keeps the offending descendant and cause`, async (t) => {
    const { cwd } = await fixture(t)
    const cause = Object.assign(new Error('internal path error'), {
      code: errno,
    })
    await assert.rejects(
      prepareUploadSelection('.', false, {
        cwd,
        realpath: async (name) => {
          if (name.endsWith('report.html')) throw cause
          return fs.realpath(name)
        },
      }),
      (error) => {
        const safe = uploadReadError(error, '.')
        assert.equal(safe.code, 'upload_read_failed')
        assert.equal(safe.details?.path, 'report.html')
        assert.equal(safe.details?.errno, errno)
        assert.equal((safe as { cause?: unknown }).cause, cause)
        return true
      },
    )
  })
}

test('listed entry disappearance is changed with retry recovery', async (t) => {
  const { cwd } = await fixture(t)
  await rejection(
    prepareUploadSelection('.', false, {
      cwd,
      checkpoint: async (phase, name) => {
        if (phase === 'entry') await fs.unlink(name)
      },
    }),
    'changed',
    'report.html',
  )
})

test('relative path through a regular file is not_found', async (t) => {
  const { cwd } = await fixture(t)
  await rejection(
    prepareUploadSelection('report.html/index.html', false, { cwd }),
    'not_found',
    'report.html/index.html',
  )
})

test('typed Markdown alias returns stored filename', async (t) => {
  const { cwd } = await fixture(t)
  const stored = path.join(cwd, 'report.md')
  await fs.writeFile(stored, '# report')
  const translate = (name: string) =>
    name === path.join(cwd, 'REPORT.MD') ? stored : name
  const selection = await prepareUploadSelection('REPORT.MD', false, {
    cwd,
    lstat: (name) => fs.lstat(translate(name), { bigint: true }),
    realpath: (name) => fs.realpath(translate(name)),
    open: (name, flags) => fs.open(translate(String(name)), flags),
  })
  assert.equal(selection.files[0]!.name, 'report.md')
})

test('single-file payload uses stored Markdown kind, name, and content type', async (t) => {
  const { prepareUploadPayload } = await import('./files.js')
  const { cwd } = await fixture(t)
  const stored = path.join(cwd, 'report.md')
  await fs.writeFile(stored, '# report')
  const translate = (name: string) =>
    name === path.join(cwd, 'REPORT.MD') ? stored : name
  const result = await prepareUploadPayload('REPORT.MD', {
    cwd,
    lstat: (name) => fs.lstat(translate(name), { bigint: true }),
    realpath: (name) => fs.realpath(translate(name)),
    open: (name, flags) => fs.open(translate(String(name)), flags),
  })
  assert.equal(result.error, undefined)
  assert.equal(result.payload!.kind, 'markdown_page')
  const file = result.payload!.form.get('file') as File
  assert.equal(file.name, 'report.md')
  assert.equal(file.type, 'text/markdown')
})
