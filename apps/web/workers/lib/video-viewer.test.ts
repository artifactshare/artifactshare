import { describe, expect, test } from 'vitest'
import {
  VIDEO_PLAYBACK_RATES,
  videoContentDisposition,
  videoDownloadFileName,
  videoPlayerAsset,
  videoPlayerDocument,
} from './video-viewer'

describe('video download names', () => {
  test('keeps Unicode letters, drops unsafe characters and always ends in .mp4', () => {
    expect(videoDownloadFileName('/録画/デモ <1>.MP4')).toBe('デモ _1.mp4')
    expect(videoDownloadFileName(null)).toBe('video.mp4')
    expect(videoDownloadFileName('/../.mp4')).toBe('video.mp4')
  })

  test('a long name ending in a character outside the BMP is not split', () => {
    const path = `${'a'.repeat(119)}𠮷.mp4`
    expect(videoDownloadFileName(path)).toBe(`${'a'.repeat(119)}𠮷.mp4`)
    expect(() => videoContentDisposition(path, true)).not.toThrow()
  })

  test('the header has an ASCII fallback and the UTF-8 name', () => {
    expect(videoContentDisposition('/デモ.mp4', true)).toBe(
      `attachment; filename="__.mp4"; filename*=UTF-8''${encodeURIComponent('デモ.mp4')}`,
    )
    expect(videoContentDisposition('/demo.mp4', false)).toMatch(/^inline;/)
  })
})

describe('video player page', () => {
  test('never puts markup from the file name in the page and never autoplays', () => {
    const html = videoPlayerDocument('/a<b>&"c.mp4')
    expect(html).toContain('<title>a_b_c.mp4</title>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('preload="metadata"')
    expect(html).not.toMatch(/\bautoplay\b/)
  })

  test('offers playback speeds from 0.5× to 2×', () => {
    expect(VIDEO_PLAYBACK_RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
    const html = videoPlayerDocument('/demo.mp4')
    for (const rate of VIDEO_PLAYBACK_RATES)
      expect(html).toContain(`<option value="${rate}"`)
  })

  test('dispatches only the fixed script and style paths', () => {
    expect(videoPlayerAsset('/__as_video/viewer.js')?.contentType).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(videoPlayerAsset('/__as_video/viewer.css')?.contentType).toBe(
      'text/css; charset=utf-8',
    )
    expect(videoPlayerAsset('/__as_video/original.mp4')).toBeNull()
    expect(videoPlayerAsset('/__as_video/viewer.js.map')).toBeNull()
  })
})
