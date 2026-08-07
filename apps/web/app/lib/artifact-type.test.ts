import { describe, expect, test } from 'vitest'
import {
  artifactSupportsComments,
  detectArtifactType,
  detectArtifactTypeForUpload,
} from './artifact-type'

describe('detectArtifactType', () => {
  test('detects HTML by MIME', () => {
    expect(detectArtifactType('text/html', 'page.html')).toBe('html')
    expect(detectArtifactType('text/html; charset=utf-8', 'page.html')).toBe(
      'html',
    )
  })

  test('detects Markdown by MIME', () => {
    expect(detectArtifactType('text/markdown', 'notes.md')).toBe('md')
  })

  test('detects Markdown via extension when MIME is text/plain', () => {
    expect(detectArtifactType('text/plain', 'README.md')).toBe('md')
    expect(detectArtifactType('text/plain', 'doc.markdown')).toBe('md')
    expect(detectArtifactType('application/octet-stream', 'a.md')).toBe('md')
  })

  test('rejects plain text without .md extension', () => {
    expect(detectArtifactType('text/plain', 'notes.txt')).toBeNull()
    expect(detectArtifactType('text/plain', 'README')).toBeNull()
  })

  test('rejects unsupported types', () => {
    expect(detectArtifactType('application/pdf', 'doc.pdf')).toBeNull()
    expect(detectArtifactType('image/png', 'pic.png')).toBeNull()
  })

  test('extension match is case-insensitive', () => {
    expect(detectArtifactType('text/plain', 'NOTES.MD')).toBe('md')
  })
})

describe('detectArtifactTypeForUpload', () => {
  test('prioritizes upload filename extension over missing MIME', () => {
    expect(detectArtifactTypeForUpload('', 'page.html')).toBe('html')
    expect(detectArtifactTypeForUpload('', 'page.htm')).toBe('html')
    expect(detectArtifactTypeForUpload('', 'notes.md')).toBe('md')
  })

  test('uses the terminal extension', () => {
    expect(detectArtifactTypeForUpload('text/html', 'page.html.md')).toBe('md')
  })

  test('falls back to MIME semantics', () => {
    expect(detectArtifactTypeForUpload('text/html', 'page')).toBe('html')
    expect(detectArtifactTypeForUpload('text/plain', 'notes.txt')).toBeNull()
  })
})

describe('artifactSupportsComments', () => {
  test('enables comments for html, md, and static_site', () => {
    expect(artifactSupportsComments('html')).toBe(true)
    expect(artifactSupportsComments('md')).toBe(true)
    expect(artifactSupportsComments('static_site')).toBe(true)
  })

  test('disables comments for unrenderable artifacts', () => {
    expect(artifactSupportsComments(null)).toBe(false)
  })
})
