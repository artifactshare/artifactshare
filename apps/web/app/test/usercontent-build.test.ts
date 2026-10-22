import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { sharedUsercontentBuild } from './usercontent-build'

test('concurrent engines share completed output until the last engine closes', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const build = vi.fn(async (directory: string) => {
    await pending
    await writeFile(join(directory, 'asset.js'), 'immutable')
  })
  const acquire = sharedUsercontentBuild(build)
  const first = acquire()
  const second = acquire()
  finish()
  const [one, two] = await Promise.all([first, second])
  try {
    expect(build).toHaveBeenCalledTimes(1)
    expect(one.directory).toBe(two.directory)
    await one.release()
    await one.release()
    expect(await readFile(join(two.directory, 'asset.js'), 'utf8')).toBe(
      'immutable',
    )
  } finally {
    await Promise.all([one.release(), two.release()])
  }
  await expect(access(one.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('failed builds clean their output and do not poison the next acquisition', async () => {
  const directories: string[] = []
  const acquire = sharedUsercontentBuild(async (directory) => {
    directories.push(directory)
    await writeFile(join(directory, 'partial'), 'unfinished')
    if (directories.length === 1) throw new Error('build failed')
  })
  const failed = await Promise.allSettled([acquire(), acquire()])
  expect(failed.map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ])
  await expect(access(directories[0])).rejects.toMatchObject({ code: 'ENOENT' })
  const next = await acquire()
  try {
    expect(directories).toHaveLength(2)
    expect(next.directory).not.toBe(directories[0])
  } finally {
    await next.release()
  }
  await expect(access(next.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
