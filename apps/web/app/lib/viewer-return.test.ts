import { describe, expect, test } from 'vitest'
import {
  currentGalleryReturnTo,
  hasViewerReturnContext,
  viewerReturnTo,
} from './viewer-return'

const VALID_PATHS = [
  '/?tab=recent#top',
  '/projects/codex_check_project_20260601',
  '/recent?q=notes#top',
  '/files?page=2',
]

const REJECTED_PATHS = [
  '/\\\\evil.com',
  '/\t//evil.com',
  '/api/auth/signout',
  '/projects/a/files',
  '/unknown',
  '//evil.com',
]

describe('viewerReturnTo', () => {
  test('allows only gallery root paths with search and hash', () => {
    for (const path of VALID_PATHS) {
      expect(viewerReturnTo({ galleryReturnTo: path })).toBe(path)
    }
  })

  test('allows files and rejects unknown routes', () => {
    expect(viewerReturnTo({ galleryReturnTo: '/files?page=2' })).toBe(
      '/files?page=2',
    )
    expect(viewerReturnTo({ galleryReturnTo: '/unknown' })).toBe('/')
  })

  test('uses a safe fallback when navigation state is absent', () => {
    expect(viewerReturnTo(null, '/projects/project-a')).toBe(
      '/projects/project-a',
    )
    expect(viewerReturnTo(null, '/settings')).toBe('/')
  })

  test('rejects external-looking and non-gallery paths', () => {
    for (const path of REJECTED_PATHS) {
      expect(viewerReturnTo({ galleryReturnTo: path })).toBe('/')
    }
  })
})

describe('currentGalleryReturnTo', () => {
  test('returns recent searches to page one while preserving query and hash', () => {
    expect(
      currentGalleryReturnTo({
        pathname: '/recent',
        search: '?page=4&q=notes',
        hash: '#history',
      }),
    ).toBe('/recent?q=notes#history')
  })

  test('preserves the full location for other galleries', () => {
    expect(
      currentGalleryReturnTo({
        pathname: '/projects/project-a',
        search: '?sort=name',
        hash: '#file-a',
      }),
    ).toBe('/projects/project-a?sort=name#file-a')
  })

  test('preserves files page but keeps recent page-one behavior', () => {
    expect(
      currentGalleryReturnTo({
        pathname: '/files',
        search: '?page=2',
        hash: '',
      }),
    ).toBe('/files?page=2')
    expect(
      currentGalleryReturnTo({
        pathname: '/recent',
        search: '?page=2',
        hash: '',
      }),
    ).toBe('/recent')
  })
})

describe('hasViewerReturnContext', () => {
  test('returns true for valid gallery return paths', () => {
    for (const path of VALID_PATHS) {
      expect(hasViewerReturnContext({ galleryReturnTo: path })).toBe(true)
    }
  })

  test('returns false when navigation state is absent or invalid', () => {
    expect(hasViewerReturnContext(null)).toBe(false)
    expect(hasViewerReturnContext(undefined)).toBe(false)
    expect(hasViewerReturnContext('not-an-object')).toBe(false)
    expect(hasViewerReturnContext({})).toBe(false)
    expect(hasViewerReturnContext({ galleryReturnTo: 42 })).toBe(false)
  })

  test('returns false for external-looking and non-gallery paths', () => {
    for (const path of REJECTED_PATHS) {
      expect(hasViewerReturnContext({ galleryReturnTo: path })).toBe(false)
    }
  })
})
