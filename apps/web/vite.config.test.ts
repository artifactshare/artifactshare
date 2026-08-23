import { describe, expect, test, vi } from 'vitest'
import { sourceRevision } from './vite.config'

describe('capture source revision', () => {
  test('accepts only the unchanged clean startup commit', () => {
    const head = 'a'.repeat(40)
    const clean = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${head}\n` : '',
    )
    expect(sourceRevision(head, clean)).toEqual({ head, clean: true })
  })

  test('rejects a dirty or changed server worktree', () => {
    const startupHead = 'a'.repeat(40)
    const dirty = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${startupHead}\n` : ' M app.tsx\n',
    )
    expect(sourceRevision(startupHead, dirty)).toEqual({
      head: startupHead,
      clean: false,
    })

    const changedHead = 'b'.repeat(40)
    const changed = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${changedHead}\n` : '',
    )
    expect(sourceRevision(startupHead, changed)).toEqual({
      head: startupHead,
      clean: false,
    })
  })
})
