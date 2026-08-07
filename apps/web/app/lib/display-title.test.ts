import { describe, expect, test } from 'vitest'
import { displayTitle } from './display-title'

describe('displayTitle', () => {
  test('prefers titleOverride', () => {
    expect(
      displayTitle({
        titleOverride: 'Override',
        derivedTitle: 'Derived',
        name: 'File',
      }),
    ).toBe('Override')
  })

  test('falls back to derivedTitle then name', () => {
    expect(
      displayTitle({
        titleOverride: null,
        derivedTitle: 'Derived',
        name: 'File',
      }),
    ).toBe('Derived')
    expect(
      displayTitle({ titleOverride: null, derivedTitle: null, name: 'File' }),
    ).toBe('File')
  })
})
