import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const isViteDevMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('~/lib/is-vite-dev', () => ({
  isViteDev: isViteDevMock,
}))

import { loader } from './index'
import { gallerySections } from './+components/registry'

function componentFiles(dir: 'ui' | 'form' | 'layout'): string[] {
  const abs = fileURLToPath(new URL(`../../components/${dir}`, import.meta.url))
  return readdirSync(abs)
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .map((name) => `${dir}/${name.replace(/\.tsx$/, '')}`)
}

const APP_GALLERY_FILES = [
  'app/author-avatar',
  'app/brand-mark',
  'app/icon-button',
  'app/navigation-link',
  'app/public-footer',
]

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

describe('design gallery parity', () => {
  test('every ui / form / layout component file is covered by a section', () => {
    const covered = new Set(gallerySections.map((section) => section.file))
    const expected = [
      ...componentFiles('ui'),
      ...componentFiles('form'),
      ...componentFiles('layout'),
    ]
    expect(gallerySections.length).toBeGreaterThan(0)
    expect(expected.length).toBeGreaterThan(0)
    const missing = expected.filter((file) => !covered.has(file))
    expect(missing).toEqual([])
  })

  test('every section maps to an existing component file', () => {
    const existing = new Set([
      ...componentFiles('ui'),
      ...componentFiles('form'),
      ...componentFiles('layout'),
      ...APP_GALLERY_FILES,
    ])
    const orphan = gallerySections
      .map((section) => section.file)
      .filter((file) => !existing.has(file))
    expect(orphan).toEqual([])
  })

  test('section ids are unique', () => {
    const ids = gallerySections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
