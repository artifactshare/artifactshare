// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest'
import { configureDirectoryInput } from './directory-input'

describe('configureDirectoryInput', () => {
  test('marks a real file input as a directory picker', () => {
    const input = document.createElement('input')
    input.type = 'file'

    configureDirectoryInput(input)

    expect(input.hasAttribute('webkitdirectory')).toBe(true)
    expect(input.hasAttribute('directory')).toBe(true)
  })

  test('accepts null during ref cleanup', () => {
    expect(() => configureDirectoryInput(null)).not.toThrow()
  })
})
