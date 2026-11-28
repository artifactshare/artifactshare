import { describe, expect, test } from 'vitest'
import { VIDEO_PLAYBACK_RATES } from '../../app/viewers/video/paths'
import {
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

/** A tag's attributes, so the order they are written in is free. */
function attributesOf(html: string, tag: string) {
  const match = html.match(new RegExp(`<${tag}\\b([^>]*)>`, 'u'))
  expect(match, tag).not.toBeNull()
  return Object.fromEntries(
    [...match![1]!.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/gu)].map(
      (attribute) => [attribute[1]!, attribute[2] ?? true],
    ),
  )
}

describe('video player page', () => {
  test('never puts markup from the file name in the page and never autoplays', () => {
    const html = videoPlayerDocument('/a<b>&"c.mp4')
    expect(html).toContain('<title>a_b_c.mp4</title>')
    expect(attributesOf(html, 'div')['data-file-name']).toBe('a_b_c.mp4')
    expect(html).not.toContain('<b>')
    expect(html).not.toMatch(/\bautoplay\b/)
  })

  test('plays and downloads with native controls until the player script takes over', () => {
    const html = videoPlayerDocument('/demo.mp4')
    expect(attributesOf(html, 'video')).toEqual({
      id: 'video',
      controls: true,
      playsinline: true,
      preload: 'metadata',
      src: '/__as_video/original.mp4',
    })
    expect(attributesOf(html, 'a')).toEqual({
      href: '/__as_video/original.mp4?download=1',
      download: 'demo.mp4',
    })
    expect(attributesOf(html, 'html')).toMatchObject({
      lang: 'en',
      'data-theme': 'system',
    })
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
