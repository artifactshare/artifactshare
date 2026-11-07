import { describe, expect, test } from 'vitest'
import { pdfContentDisposition, pdfDownloadFileName } from './pdf-viewer'

describe('PDF download names', () => {
  test('a long name ending in a character outside the BMP is not split', () => {
    const path = `${'a'.repeat(119)}𠮷.pdf`
    const name = pdfDownloadFileName(path)
    expect(name).toBe(`${'a'.repeat(119)}𠮷.pdf`)
    expect(() => pdfContentDisposition(path, true)).not.toThrow()
  })

  test('names are cut at 120 characters, counted by code point', () => {
    const name = pdfDownloadFileName(`${'𠮷'.repeat(130)}.pdf`)
    expect(Array.from(name.replace(/\.pdf$/, ''))).toHaveLength(120)
  })
})
