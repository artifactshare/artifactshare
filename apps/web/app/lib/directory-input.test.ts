import { describe, expect, test } from 'vitest'
import { configureDirectoryInput } from './directory-input'

describe('configureDirectoryInput', () => {
  test('sets directory picker attributes imperatively', () => {
    const attributes = new Map<string, string>()
    const input = {
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
    } as HTMLInputElement

    configureDirectoryInput(input)

    expect(attributes.get('webkitdirectory')).toBe('')
    expect(attributes.get('directory')).toBe('')
  })

  test('accepts null during ref cleanup', () => {
    expect(() => configureDirectoryInput(null)).not.toThrow()
  })
})
