import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { componentCatalog } from './catalog'

function componentFiles(dir: 'ui' | 'form' | 'layout'): string[] {
  const abs = fileURLToPath(new URL(`./${dir}`, import.meta.url))
  return readdirSync(abs)
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .map((name) => `${dir}/${name.replace(/\.tsx$/, '')}`)
}

function sourceOf(file: string): string {
  const abs = fileURLToPath(new URL(`./${file}.tsx`, import.meta.url))
  return readFileSync(abs, 'utf8')
}

/**
 * 記録した代表的な公式差分が部品ソースに現に存在することを固定するマーカー。
 * cva / prop のキーは行頭アンカー (`^\s*key:`) で拾い、`2xs:` やコメント中の部分一致を誤検出しない。
 */
const upstreamDiffMarkers: Record<string, RegExp[]> = {
  'ui/button': [/^\s*xs:/m, /'icon-sm'/],
  'ui/badge': [/^\s*success:/m, /^\s*info:/m, /^\s*warning:/m, /^\s*muted:/m],
  'ui/sheet': [/w-\[340px\]/],
}

describe('component catalog parity', () => {
  const expected = [
    ...componentFiles('ui'),
    ...componentFiles('form'),
    ...componentFiles('layout'),
  ]
  const cataloged = componentCatalog.map((entry) => entry.file)

  test('has entries', () => {
    expect(componentCatalog.length).toBeGreaterThan(0)
    expect(expected.length).toBeGreaterThan(0)
  })

  test('every ui / form / layout component file is in the catalog', () => {
    const covered = new Set(cataloged)
    const missing = expected.filter((file) => !covered.has(file))
    expect(missing).toEqual([])
  })

  test('every catalog entry maps to an existing component file', () => {
    const existing = new Set(expected)
    const orphan = cataloged.filter(
      (file) => !existing.has(file) && !file.startsWith('app/'),
    )
    expect(orphan).toEqual([])
  })

  test('every cataloged app component maps to an existing component file', () => {
    const missing = cataloged
      .filter((file) => file.startsWith('app/'))
      .filter((file) => {
        try {
          sourceOf(file)
          return false
        } catch {
          return true
        }
      })
    expect(missing).toEqual([])
  })

  test('catalog files are unique', () => {
    expect(new Set(cataloged).size).toBe(cataloged.length)
  })

  test('name and purpose are non-empty', () => {
    const blank = componentCatalog.filter(
      (entry) => entry.name.trim() === '' || entry.purpose.trim() === '',
    )
    expect(blank.map((entry) => entry.file)).toEqual([])
  })
})

describe('recorded upstream diffs exist in component source', () => {
  for (const [file, markers] of Object.entries(upstreamDiffMarkers)) {
    test(`${file} still carries its documented diff`, () => {
      const entry = componentCatalog.find((item) => item.file === file)
      expect(
        entry?.upstreamDiff,
        `${file} must record an upstreamDiff`,
      ).toBeTruthy()
      const src = sourceOf(file)
      const absent = markers.filter((re) => !re.test(src)).map(String)
      expect(absent).toEqual([])
    })
  }
})
