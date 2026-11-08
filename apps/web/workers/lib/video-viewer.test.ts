import { describe, expect, test } from 'vitest'
import {
  VIDEO_PLAYBACK_RATES,
  videoContentDisposition,
  videoDownloadFileName,
  videoPlayerAsset,
  videoPlayerDocument,
} from './video-viewer'
import { VIDEO_VIEWER_SCRIPT } from './video-viewer-script.generated'
import { VIDEO_VIEWER_STYLE } from './video-viewer-style.generated'

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
    expect(html).toContain('data-file-name="a_b_c.mp4"')
    expect(html).not.toContain('<b>')
    expect(html).toContain('preload="metadata"')
    expect(html).not.toMatch(/\bautoplay\b/)
  })

  test('plays and downloads with native controls until the player script takes over', () => {
    const html = videoPlayerDocument('/demo.mp4')
    expect(html).toContain(
      '<video id="video" controls playsinline preload="metadata" src="/__as_video/original.mp4">',
    )
    expect(html).toContain(
      '<a href="/__as_video/original.mp4?download=1" download="demo.mp4">',
    )
    expect(html).toContain('<html lang="en" data-theme="system"')
  })

  test('offers playback speeds from 0.5× to 2×', () => {
    expect(VIDEO_PLAYBACK_RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
  })

  test('dispatches only the fixed script and style paths to the built player', () => {
    expect(videoPlayerAsset('/__as_video/viewer.js')).toEqual({
      body: VIDEO_VIEWER_SCRIPT,
      contentType: 'text/javascript; charset=utf-8',
    })
    expect(videoPlayerAsset('/__as_video/viewer.css')).toEqual({
      body: VIDEO_VIEWER_STYLE,
      contentType: 'text/css; charset=utf-8',
    })
    expect(videoPlayerAsset('/__as_video/original.mp4')).toBeNull()
    expect(videoPlayerAsset('/__as_video/viewer.js.map')).toBeNull()
  })
})
