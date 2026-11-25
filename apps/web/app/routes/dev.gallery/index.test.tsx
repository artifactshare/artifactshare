import { beforeEach, describe, expect, test, vi } from 'vitest'

const isViteDevMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('~/lib/is-vite-dev', () => ({
  isViteDev: isViteDevMock,
}))

import { loader } from './index'
import { gallerySections } from './+components/registry'

beforeEach(() => {
  isViteDevMock.mockReset()
  isViteDevMock.mockReturnValue(true)
})

describe('/dev/gallery loader', () => {
  test('returns 404 outside Vite dev', () => {
    isViteDevMock.mockReturnValueOnce(false)
    try {
      loader()
      expect.unreachable('loader should throw a 404 Response')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response)
      expect((thrown as Response).status).toBe(404)
    }
  })

  test('does not throw in Vite dev', () => {
    expect(loader()).toBeNull()
  })
})

describe('design gallery', () => {
  test('section ids are unique', () => {
    const ids = gallerySections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
