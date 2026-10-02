import { expect, test } from 'vitest'
import { browserFramePoint } from './browser-frame-point'

test.each([1, 0.75, 1.25])(
  'mouse coordinates follow iframe scale %s',
  (scale) => {
    expect(
      browserFramePoint(
        { x: 40, y: 60, width: 800 * scale, height: 600 * scale },
        { width: 800, height: 600 },
        { x: 320, y: 100 },
      ),
    ).toEqual({ x: 40 + 320 * scale, y: 60 + 100 * scale })
  },
)
