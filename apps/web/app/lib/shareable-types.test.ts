import { describe, expect, test } from 'vitest'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
  EDITABLE_VISIBILITIES,
} from './shareable-types'

describe('shareable visibility policy', () => {
  test('offers direct, project, workspace, and link sharing as editable visibility', () => {
    expect(Array.from(EDITABLE_VISIBILITIES)).toEqual([
      'private',
      'workspace',
      'project',
      'link',
    ])
  })

  test('inbox containers do not offer project sharing', () => {
    expect(availableVisibilitiesFor(true)).toEqual([
      'private',
      'workspace',
      'link',
    ])
    expect(availableVisibilitiesFor(false)).toEqual(['private', 'link'])
    expect(defaultVisibilityFor(true)).toBe('workspace')
    expect(defaultVisibilityFor(false)).toBe('private')
  })

  test('project containers offer project sharing and default to it', () => {
    expect(availableVisibilitiesFor(true, 'project')).toEqual([
      'private',
      'project',
      'workspace',
      'link',
    ])
    expect(availableVisibilitiesFor(false, 'project')).toEqual([
      'private',
      'project',
      'link',
    ])
    expect(defaultVisibilityFor(true, 'project')).toBe('project')
    expect(defaultVisibilityFor(false, 'project')).toBe('project')
  })
})
