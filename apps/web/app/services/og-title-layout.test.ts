import { describe, expect, test } from 'vitest'
import { layoutOgTitle } from './og-title-layout'

describe('layoutOgTitle', () => {
  test('keeps Japanese punctuation with a phrase', () => {
    const result = layoutOgTitle(
      '「これで伝わる？」を、公開前にチームで確かめる。',
    )
    expect(
      result.segments.slice(1).every((part) => !/^[、。）」]/u.test(part)),
    ).toBe(true)
    expect(
      result.segments.slice(0, -1).every((part) => !/[（「]$/u.test(part)),
    ).toBe(true)
    expect(
      result.lines.slice(1).every((line) => !/^[、。）」]/u.test(line)),
    ).toBe(true)
    expect(
      result.lines.slice(0, -1).every((line) => !/[（「]$/u.test(line)),
    ).toBe(true)
  })

  test('does not leave a one or two character final segment', () => {
    const result = layoutOgTitle('成果物を共有してコメントを受け取り、更新する')
    expect([...result.segments.at(-1)!].length).toBeGreaterThan(2)
  })

  test('keeps an English title as one word-wrappable run', () => {
    const title =
      'Share your work, discuss the details, and keep every revision at the same URL.'
    expect(layoutOgTitle(title).segments.join(' ')).toBe(title)
    expect(layoutOgTitle(title).lines.length).toBeLessThanOrEqual(3)
  })

  test('balances two lines at phrase boundaries instead of filling the first line', () => {
    const result = layoutOgTitle('HTML の社内シェアは、 AI に言うだけ。')
    expect(result.lines).toEqual(['HTMLの社内シェアは、', 'AIに言うだけ。'])
  })

  test('uses the same balancing strategy for arbitrary Japanese copy', () => {
    const result = layoutOgTitle(
      '成果物をチームに届けて、同じURLで改善を続ける。',
    )

    expect(result.lines.length).toBeGreaterThan(1)
    expect(result.lines.length).toBeLessThanOrEqual(3)
    expect(result.lines.join('')).toBe(result.text)
    expect(result.lines.slice(1).every((line) => !/^[、。]/u.test(line))).toBe(
      true,
    )
  })

  test('balances against the capped font size used by cards with a subhead', () => {
    const result = layoutOgTitle('AI に Artifact Share を接続する', 68)

    expect(result.fontSize).toBe(68)
    expect(result.lines.join('')).toBe(result.text)
  })

  test('wraps a mixed Japanese title instead of replacing it with an ellipsis', () => {
    const title = 'ソフトウェアファクトリー 2026'
    const result = layoutOgTitle(title)

    expect(result.lines.join('')).toBe(title)
    expect(result.lines).not.toEqual(['…'])
    expect(
      result.lines
        .slice(1)
        .every((line) => !/^[ァィゥェォッャュョー]/u.test(line)),
    ).toBe(true)
  })

  test('preserves word boundaries around incidental Japanese text', () => {
    const title = 'Deploy the v2.3 API 手順書 for the internal team release'
    const result = layoutOgTitle(title)

    expect(result.text).toContain('API 手順書 for')
    expect(result.lines.join('')).toBe(result.text)
  })

  test('stops shrinking at 48px and truncates overlong text', () => {
    const result = layoutOgTitle(
      '共有した成果物を同じURLで何度でも更新しながら、コメントを受け取り、公開範囲を管理し、チーム全員で内容を確認して次の版へ進めるための、とても長いタイトルです',
    )
    expect(result.fontSize).toBe(48)
    expect(result.text).toMatch(/…$/u)
    expect([...result.text].length).toBeLessThanOrEqual(66)
  })

  test('does not split surrogate pairs when truncating', () => {
    const result = layoutOgTitle(`${'a'.repeat(95)}😀tail`)
    expect(result.text).not.toContain('\uFFFD')
    expect([...result.text].at(-1)).toBe('…')
  })

  test('does not split an oversized URL token', () => {
    const url = `https://example.com/${'a'.repeat(120)}`
    const result = layoutOgTitle(url)
    expect(result.text).toBe('…')
    expect(result.lines).toEqual(['…'])
    expect(result.lines.join('')).not.toContain('https://')
  })

  test('does not split an oversized URL containing Japanese text', () => {
    const url = `https://example.com/${'a'.repeat(80)}/日本語`
    const result = layoutOgTitle(url)

    expect(result.lines).toEqual(['…'])
    expect(result.lines.join('')).not.toContain('https://')
  })
})
