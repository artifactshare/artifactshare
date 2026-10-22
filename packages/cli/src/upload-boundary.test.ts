import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  prepareAppend,
  prepareUpload,
  explicitUploadPath,
  resolveUploadInput,
  uploadBoundaryError,
  type UploadCheckpoint,
} from './upload-boundary.js'
import { contentTypeFor, prepareUploadPayload } from './files.js'

let root: string
let selected: string
let sentinel: string
let reads: string[]
let closes: number
let opens: number
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'upload-boundary-')),
  )
  selected = path.join(root, 'selected')
  await fs.mkdir(selected)
  await fs.writeFile(path.join(selected, 'index.html'), '<h1>selected</h1>')
  sentinel = path.join(root, 'outside.html')
  await fs.writeFile(sentinel, 'outside sentinel')
  reads = []
  closes = 0
  opens = 0
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      opens++
      const read = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementation(
        (...readArgs: Parameters<typeof handle.readFile>) => {
          reads.push(String(args[0]))
          return read(...readArgs)
        },
      )
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closes++
        await close()
      })
      return handle
    },
  )
})
afterEach(async () => {
  expect(reads).not.toContain(sentinel)
  expect(closes).toBe(opens)
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function rejected(input: string, reason: string, cwd = selected) {
  await expect(
    prepareUpload(input, contentTypeFor, { cwd }),
  ).rejects.toMatchObject({ reason })
  expect(reads).toEqual([])
}

for (const directory of [false, true]) {
  test(`rejects selected ${directory ? 'directory junction' : 'file link'} and trailing separators`, async () => {
    const link = path.join(root, 'link')
    await fs.symlink(
      directory ? selected : sentinel,
      link,
      directory ? 'junction' : 'file',
    )
    await rejected(link, 'link')
    if (directory) await rejected(link + path.sep, 'link')
  })
}
test('rejects dangling selected links', async () => {
  const link = path.join(selected, 'dangling')
  await fs.symlink(path.join(root, 'missing'), link, 'file')
  await rejected(link, 'link')
})
test('relative parent links fail; explicitly selected ancestors and aliased cwd work', async () => {
  const alias = path.join(root, 'alias')
  await fs.symlink(selected, alias, 'junction')
  await rejected(path.join('alias', 'index.html'), 'link', root)
  expect(await prepareAppend(path.join(alias, 'index.html'))).toBe(
    '<h1>selected</h1>',
  )
  expect(await prepareAppend('index.html', { cwd: alias })).toBe(
    '<h1>selected</h1>',
  )
})
for (const directory of [false, true]) {
  test(`absolute ${directory ? 'directory' : 'file'} selection accepts canonical basename casing`, async () => {
    const canonical = directory ? selected : path.join(selected, 'index.html')
    const input = path.join(
      path.dirname(canonical),
      path.basename(canonical).toUpperCase(),
    )
    // Model a case-insensitive filesystem whose realpath returns stored casing,
    // including on Linux where the real filesystem may be case-sensitive.
    const lstat = fs.lstat
    const realpath = fs.realpath
    vi.spyOn(fs, 'lstat').mockImplementation(
      (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === input) args[0] = canonical
        return lstat(...args)
      },
    )
    vi.spyOn(fs, 'realpath').mockImplementation(
      (...args: Parameters<typeof fs.realpath>) => {
        if (args[0] === input) args[0] = canonical
        return realpath(...args)
      },
    )
    expect(await fs.realpath(input)).toBe(canonical)
    expect(input).not.toBe(canonical)
    const prepared = await prepareUpload(input, contentTypeFor)
    expect(prepared.directory).toBe(directory)
    expect(prepared.files).toHaveLength(1)
    expect(await prepared.files[0]!.blob.text()).toBe('<h1>selected</h1>')
    expect(reads).toEqual([path.join(selected, 'index.html')])
  })
}

test('absolute selections accept basename case aliases on a real case-insensitive filesystem', async (context) => {
  const input = path.join(selected, 'INDEX.HTML')
  const alias = await fs
    .lstat(input, { bigint: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  if (alias === null) context.skip('The temporary filesystem is case-sensitive')
  const original = await fs.lstat(path.join(selected, 'index.html'), {
    bigint: true,
  })
  expect(alias!.dev).toBe(original.dev)
  expect(alias!.ino).toBe(original.ino)
  expect(await prepareAppend(input)).toBe('<h1>selected</h1>')
  const prepared = await prepareUpload(
    path.join(root, 'SELECTED'),
    contentTypeFor,
  )
  expect(prepared.directory).toBe(true)
  expect(await prepared.files[0]!.blob.text()).toBe('<h1>selected</h1>')
  expect(reads).toHaveLength(2)
})

test('rejects escape and prefix sibling before reading', async () => {
  await rejected('../outside.html', 'escape')
  await rejected('../selected-sibling/x.html', 'escape')
})
test('raw intermediate file traversal is invalid', async () => {
  await rejected(`index.html${path.sep}..${path.sep}index.html`, 'invalid')
})
test('ordinary directory traversal preserves raw semantics', async () => {
  await fs.mkdir(path.join(selected, 'dir'))
  if (process.platform === 'win32') {
    await rejected('dir/../index.html', 'invalid')
  } else {
    expect(await prepareAppend('dir/../index.html', { cwd: selected })).toBe(
      '<h1>selected</h1>',
    )
  }
})
for (const kind of ['file', 'directory', 'dangling'] as const) {
  test(`rejects included descendant ${kind} links without reads`, async () => {
    const target =
      kind === 'directory'
        ? root
        : kind === 'file'
          ? sentinel
          : path.join(root, 'missing')
    await fs.symlink(
      target,
      path.join(selected, 'linked'),
      kind === 'directory' ? 'junction' : 'file',
    )
    await rejected(selected, 'link')
  })
}
test('name exclusions survive disappearance and replacement with links', async () => {
  for (const name of ['.hidden', '__MACOSX', 'node_modules']) {
    await fs.mkdir(path.join(selected, name))
  }
  await fs.writeFile(path.join(selected, 'Thumbs.db'), 'ignored')
  const readdir = fs.readdir
  vi.spyOn(fs, 'readdir').mockImplementationOnce(
    async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await readdir(...args)
      for (const name of ['.hidden', '__MACOSX', 'node_modules', 'Thumbs.db']) {
        const target = path.join(selected, name)
        await fs.rm(target, { recursive: true, force: true })
        await fs.symlink(sentinel, target, 'file')
      }
      return entries
    },
  )
  const result = await prepareUpload(selected, contentTypeFor)
  expect(result.files.map((file) => file.name)).toEqual(['index.html'])
  expect(reads).toEqual([path.join(selected, 'index.html')])
})

for (const stage of [
  'enumerated',
  'beforeOpen',
  'afterOpen',
  'afterRead',
] satisfies UploadCheckpoint[]) {
  for (const target of ['leaf', 'parent', 'root'] as const) {
    for (const link of [false, true]) {
      test(`${stage}: ${target} ${link ? 'link' : 'identity'} replacement`, async (context) => {
        const dir = path.join(selected, 'dir')
        await fs.mkdir(dir)
        await fs.rename(
          path.join(selected, 'index.html'),
          path.join(dir, 'index.html'),
        )
        const leaf = path.join(dir, 'index.html')
        const victim =
          target === 'leaf' ? leaf : target === 'parent' ? dir : selected
        let mutated = false
        let refused: string | undefined
        const result = prepareUpload(selected, contentTypeFor, {
          checkpoint: async (point) => {
            if (point !== stage || mutated || refused) return
            try {
              await fs.rename(victim, victim + '-old')
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (
                process.platform !== 'win32' ||
                !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
              )
                throw error
              refused = code
              return
            }
            if (link)
              await fs.symlink(
                target === 'leaf' ? sentinel : root,
                victim,
                target === 'leaf' ? 'file' : 'junction',
              )
            else if (target === 'leaf')
              await fs.writeFile(victim, '<h1>selected</h1>')
            else await fs.mkdir(victim)
            mutated = true
          },
        })
        const error = await result.then(
          () => null,
          (failure: unknown) => failure,
        )
        if (refused) {
          expect(process.platform).toBe('win32')
          expect(['EPERM', 'EACCES', 'EBUSY']).toContain(refused)
          expect(mutated).toBe(false)
          context.skip(
            'skipped-by-platform: Windows refused the open-file swap',
          )
        }
        expect(mutated).toBe(true)
        expect(error).toMatchObject({ reason: link ? 'link' : 'changed' })
        expect(reads.length).toBe(stage === 'afterRead' ? 1 : 0)
      })
    }
  }
}
test('mtime and size changes fail but ctime alone is ignored', async () => {
  const file = path.join(selected, 'index.html')
  await prepareUpload(file, contentTypeFor, {
    checkpoint: async (stage) => {
      if (stage === 'afterOpen') {
        // Hard-link creation changes ctime without changing mode, size or mtime.
        await fs.link(file, path.join(root, 'hardlink'))
      }
    },
  })
  await expect(
    prepareUpload(file, contentTypeFor, {
      checkpoint: async (stage) => {
        if (stage === 'afterOpen')
          await fs.utimes(file, new Date(0), new Date(0))
      },
    }),
  ).rejects.toMatchObject({ reason: 'changed' })
  await expect(
    prepareUpload(file, contentTypeFor, {
      checkpoint: async (stage) => {
        if (stage === 'afterRead') await fs.writeFile(file, 'changed size')
      },
    }),
  ).rejects.toMatchObject({ reason: 'changed' })
})
test('missing identity fails closed and zero device remains valid', async () => {
  const lstat = fs.lstat
  vi.spyOn(fs, 'lstat').mockImplementationOnce(
    async (...args: Parameters<typeof fs.lstat>) => {
      const value = await lstat(...args)
      return Object.assign(value, { ino: 0n })
    },
  )
  await rejected(selected, 'unsupported')
})
test.each(['EACCES', 'EIO'])(
  'unrelated %s retains code and nonserialized cause',
  async (code) => {
    const cause = Object.assign(new Error('private diagnostic'), { code })
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(cause)
    const error = await prepareUpload(selected, contentTypeFor).catch(
      uploadBoundaryError,
    )
    expect(error).toMatchObject({ code, cause })
    expect(JSON.stringify(error)).not.toContain('private diagnostic')
  },
)
test('append rejects directories before any reads; missing paths have their own reason', async () => {
  await expect(prepareAppend(selected)).rejects.toMatchObject({
    reason: 'type',
  })
  await rejected(path.join(root, 'missing'), 'missing')
})
test('prepared forms reuse original bytes after source removal', async () => {
  const prepared = await prepareUpload(selected, contentTypeFor)
  await fs.rm(selected, { recursive: true })
  const first = await prepareUploadPayload(prepared)
  const second = await prepareUploadPayload(prepared)
  expect(first.payload?.kind).toBe('static_site')
  expect(second.payload?.kind).toBe('static_site')
  expect(await prepared.files[0]!.blob.text()).toBe('<h1>selected</h1>')
  expect(reads).toHaveLength(1)
})
test('Windows drive-relative inputs are explicit on every host', () => {
  expect(explicitUploadPath('C:index.html', path.win32)).toBe(true)
  expect(explicitUploadPath('D:index.html', path.win32)).toBe(true)
  expect(path.win32.resolve('C:\\work', 'C:index.html')).toBe(
    'C:\\work\\index.html',
  )
  expect(path.win32.resolve('D:\\work', 'D:index.html')).toBe(
    'D:\\work\\index.html',
  )
  expect(explicitUploadPath('index.html', path.win32)).toBe(false)
})
test.skipIf(process.platform !== 'darwin')(
  'macOS /tmp and /var ancestors are trusted',
  async () => {
    for (const parent of [
      '/tmp',
      tmpdir().replace(/^\/private\/var\//, '/var/'),
    ]) {
      const dir = await fs.mkdtemp(`${parent}/upload-boundary-`)
      try {
        await fs.writeFile(path.join(dir, 'index.md'), 'markdown')
        expect(await prepareAppend(path.join(dir, 'index.md'))).toBe('markdown')
      } finally {
        await fs.rm(dir, { recursive: true })
      }
    }
  },
)

test('zero device identity is accepted when the inode is stable', async () => {
  const lstat = fs.lstat
  vi.spyOn(fs, 'lstat').mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      return Object.assign(await lstat(...args), { dev: 0n })
    },
  )
  const observedOpen = vi.mocked(fs.open).getMockImplementation()!
  vi.mocked(fs.open).mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await observedOpen(...args)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementation(
        async (...statArgs: Parameters<typeof handle.stat>) => {
          return Object.assign(await stat(...statArgs), { dev: 0n })
        },
      )
      return handle
    },
  )
  expect(await prepareAppend(path.join(selected, 'index.html'))).toBe(
    '<h1>selected</h1>',
  )
  expect(reads).toHaveLength(1)
})

test('handle identity uses bigint precision and never reads a mismatching handle', async () => {
  const lstat = fs.lstat
  vi.spyOn(fs, 'lstat').mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      return Object.assign(await lstat(...args), { ino: 2n ** 54n })
    },
  )
  const observedOpen = vi.mocked(fs.open).getMockImplementation()!
  vi.mocked(fs.open).mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await observedOpen(...args)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementation(
        async (...statArgs: Parameters<typeof handle.stat>) => {
          return Object.assign(await stat(...statArgs), { ino: 2n ** 54n + 1n })
        },
      )
      return handle
    },
  )
  await rejected(path.join(selected, 'index.html'), 'changed')
})

test('a read error preserves its code/cause and closes the handle', async () => {
  const cause = Object.assign(new Error('read failed'), { code: 'EIO' })
  const observedOpen = vi.mocked(fs.open).getMockImplementation()!
  vi.mocked(fs.open).mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await observedOpen(...args)
      vi.mocked(handle.readFile).mockRejectedValue(cause)
      return handle
    },
  )
  const error = await prepareAppend(path.join(selected, 'index.html')).catch(
    uploadBoundaryError,
  )
  expect(error).toMatchObject({ code: 'EIO', cause })
  expect(opens).toBe(1)
  expect(closes).toBe(1)
})

test('directory and filename exclusions apply only to matching entry types', async () => {
  await fs.writeFile(path.join(selected, 'node_modules'), 'included file')
  await fs.mkdir(path.join(selected, 'Thumbs.db'))
  await fs.writeFile(
    path.join(selected, 'Thumbs.db', 'entry.md'),
    'included directory',
  )
  const prepared = await prepareUpload(selected, contentTypeFor)
  expect(prepared.files.map((file) => file.name)).toEqual([
    'index.html',
    'node_modules',
    'Thumbs.db/entry.md',
  ])
})

test('links with excluded directory or filename names cannot hide unknown targets', async () => {
  await fs.symlink(sentinel, path.join(selected, 'Thumbs.db'), 'file')
  await rejected(selected, 'link')
  await fs.rm(path.join(selected, 'Thumbs.db'))
  await fs.symlink(root, path.join(selected, 'node_modules'), 'junction')
  await rejected(selected, 'link')
})

test('Windows current-drive and other-drive selections use drive resolution, not cwd containment', () => {
  const win = path.win32
  const cwd = 'C:\\work'
  expect(resolveUploadInput('C:index.html', cwd, cwd, win)).toEqual({
    explicit: true,
    expected: 'C:\\work\\index.html',
  })
  const driveResolver = vi.fn((_cwd: string, input: string) =>
    win.resolve('D:\\saved', input),
  )
  expect(
    resolveUploadInput('D:index.html', cwd, cwd, win, driveResolver),
  ).toEqual({ explicit: true, expected: 'D:\\saved\\index.html' })
  expect(driveResolver).toHaveBeenCalledWith(cwd, 'D:index.html')
  expect(resolveUploadInput('index.html', 'C:\\alias', cwd, win)).toEqual({
    explicit: false,
    expected: 'C:\\work\\index.html',
  })
  expect(() =>
    resolveUploadInput('..\\work-sibling\\index.html', cwd, cwd, win),
  ).toThrow(expect.objectContaining({ reason: 'escape' }))
})
