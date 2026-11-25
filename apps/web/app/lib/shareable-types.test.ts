import { describe, expect, test } from 'vitest'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
  EDITABLE_VISIBILITIES,
} from './shareable-types'

// Which visibilities are offered is the policy; the order they are listed in
// belongs to the picker that renders them.
const offered = (values: readonly string[]) => {
  expect(new Set(values).size).toBe(values.length)
  return new Set(values)
}

describe('shareable visibility policy', () => {
  test('offers direct, project, workspace, and link sharing as editable visibility', () => {
    expect(offered([...EDITABLE_VISIBILITIES])).toEqual(
      new Set(['private', 'workspace', 'project', 'link']),
    )
  })

  test('inbox containers do not offer project sharing', () => {
    expect(offered(availableVisibilitiesFor(true))).toEqual(
      new Set(['private', 'workspace', 'link']),
    )
    expect(offered(availableVisibilitiesFor(false))).toEqual(
      new Set(['private', 'link']),
    )
    expect(defaultVisibilityFor(true)).toBe('workspace')
    expect(defaultVisibilityFor(false)).toBe('private')
  })

  test('project containers offer project sharing and default to it', () => {
    expect(offered(availableVisibilitiesFor(true, 'project'))).toEqual(
      new Set(['private', 'project', 'workspace', 'link']),
    )
    expect(offered(availableVisibilitiesFor(false, 'project'))).toEqual(
      new Set(['private', 'project', 'link']),
    )
    expect(defaultVisibilityFor(true, 'project')).toBe('project')
    expect(defaultVisibilityFor(false, 'project')).toBe('project')
  })
})
