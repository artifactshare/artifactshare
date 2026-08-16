import { describe, expect, test } from 'vitest'
import { sandboxFrameSurfaceClassName } from './sandbox-frame'

describe('sandboxFrameSurfaceClassName', () => {
  test('keeps unstyled HTML on a readable light default', () => {
    const className = sandboxFrameSurfaceClassName(false)

    expect(className).toContain('bg-white')
    expect(className).toContain('[color-scheme:light]')
    expect(className).not.toContain('dark:[color-scheme:dark]')
  })

  test('lets rendered Markdown follow the app theme', () => {
    const className = sandboxFrameSurfaceClassName(true)

    expect(className).toContain('bg-background')
    expect(className).toContain('dark:[color-scheme:dark]')
    expect(className).toContain('[[data-theme=light]_&]:[color-scheme:light]')
  })
})
