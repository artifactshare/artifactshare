import { describe, expect, test } from 'vitest'
import {
  artifactSupportsComments,
  detectArtifactType,
  detectArtifactTypeForUpload,
  hasMp4Signature,
  hasPdfMagic,
  renderTypeFromKind,
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

  test('selects pdf only by a .pdf suffix in any case, never by MIME', () => {
    expect(detectArtifactTypeForUpload('', 'report.pdf')).toBe('pdf')
    expect(detectArtifactTypeForUpload('application/pdf', 'REPORT.PDF')).toBe(
      'pdf',
    )
    expect(detectArtifactTypeForUpload('application/pdf', 'report.bin')).toBe(
      null,
    )
    expect(detectArtifactTypeForUpload('application/pdf', 'report')).toBe(null)
  })
})

describe('hasPdfMagic', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  test('requires %PDF- at byte zero', () => {
    expect(hasPdfMagic(bytes('%PDF-1.4\n%synthetic\n'))).toBe(true)
    expect(hasPdfMagic(bytes('%PDF-garbage'))).toBe(true)
    expect(hasPdfMagic(bytes(' %PDF-1.4'))).toBe(false)
    expect(hasPdfMagic(bytes('%PDF'))).toBe(false)
    expect(hasPdfMagic(bytes('%pdf-1.4'))).toBe(false)
    expect(hasPdfMagic(new Uint8Array())).toBe(false)
  })
})

describe('hasMp4Signature', () => {
  const bytes = (...parts: Array<string | number[]>) =>
    new Uint8Array(
      parts.flatMap((part) =>
        typeof part === 'string' ? [...new TextEncoder().encode(part)] : part,
      ),
    )

  test('requires the ftyp box type at bytes 4-7', () => {
    expect(hasMp4Signature(bytes([0, 0, 0, 0x18], 'ftypisom'))).toBe(true)
    expect(hasMp4Signature(bytes([0, 0, 0, 0x20], 'ftyp'))).toBe(true)
    expect(hasMp4Signature(bytes('ftyp', [0, 0, 0, 0]))).toBe(false)
    expect(hasMp4Signature(bytes([0, 0, 0, 0x18], 'FTYP'))).toBe(false)
    expect(hasMp4Signature(bytes([0, 0, 0], 'ftyp'))).toBe(false)
    expect(hasMp4Signature(new Uint8Array())).toBe(false)
  })
})

describe('detectArtifactTypeForUpload video', () => {
  test('selects video only by a .mp4 suffix in any case, never by MIME', () => {
    expect(detectArtifactTypeForUpload('', 'demo.mp4')).toBe('video')
    expect(detectArtifactTypeForUpload('video/mp4', 'DEMO.MP4')).toBe('video')
    expect(detectArtifactTypeForUpload('video/mp4', 'demo.mov')).toBeNull()
    expect(detectArtifactTypeForUpload('video/mp4', 'demo')).toBeNull()
  })
})

describe('renderTypeFromKind', () => {
  test('maps the pdf kind to the pdf render type', () => {
    expect(renderTypeFromKind('pdf')).toBe('pdf')
    expect(renderTypeFromKind('static_site')).toBeNull()
  })

  test('maps the video kind to the video render type', () => {
    expect(renderTypeFromKind('video')).toBe('video')
  })
})

describe('artifactSupportsComments', () => {
  test('enables comments for html, md, and static_site', () => {
    expect(artifactSupportsComments('html')).toBe(true)
    expect(artifactSupportsComments('md')).toBe(true)
    expect(artifactSupportsComments('static_site')).toBe(true)
  })

  test('enables overall comments for pdf', () => {
    expect(artifactSupportsComments('pdf')).toBe(true)
  })

  test('enables overall comments for video', () => {
    expect(artifactSupportsComments('video')).toBe(true)
  })

  test('disables comments for unrenderable artifacts', () => {
    expect(artifactSupportsComments(null)).toBe(false)
  })
})
