import { describe, expect, test } from 'vitest'

import {
  highlightTanStackCode,
  normalizeTanStackLanguage,
  TANSTACK_HIGHLIGHT_ALIASES,
  TANSTACK_HIGHLIGHT_LANGUAGES,
} from './tanstack-highlight.server'

const INITIAL_LANGUAGES = [
  'css',
  'diff',
  'dockerfile',
  'html',
  'js',
  'json',
  'jsx',
  'markdown',
  'python',
  'shell',
  'sql',
  'toml',
  'ts',
  'tsx',
  'yaml',
]

const INITIAL_ALIASES = {
  'angular-html': 'html',
  'angular-ts': 'ts',
  bash: 'shell',
  cjs: 'js',
  cmd: 'shell',
  console: 'shell',
  docker: 'dockerfile',
  htm: 'html',
  javascript: 'js',
  'js-vue': 'js',
  json5: 'json',
  jsonc: 'json',
  md: 'markdown',
  mjs: 'js',
  patch: 'diff',
  py: 'python',
  sh: 'shell',
  typescript: 'ts',
  xml: 'html',
  yml: 'yaml',
  zsh: 'shell',
}

describe('TanStack syntax highlighting registry', () => {
  test('registers the explicit initial language set', () => {
    expect(TANSTACK_HIGHLIGHT_LANGUAGES).toEqual(INITIAL_LANGUAGES)
    expect(TANSTACK_HIGHLIGHT_ALIASES).toEqual(INITIAL_ALIASES)
  })

  test.each(Object.entries(INITIAL_ALIASES))(
    'normalizes the %s alias to %s',
    (alias, expected) => {
      expect(TANSTACK_HIGHLIGHT_ALIASES[alias]).toBe(expected)
      expect(normalizeTanStackLanguage(alias)).toBe(expected)
    },
  )

  test.each(INITIAL_LANGUAGES)(
    'preserves the complete source while highlighting %s',
    (language) => {
      const source = 'const value = "<artifact>"\n'
      const result = highlightTanStackCode(source, language)

      expect(result.lang).toBe(language)
      expect(result.tokens.map((token) => token.value).join('')).toBe(source)
      expect(result.html).toContain(`data-language="${language}"`)
    },
  )

  test.each([undefined, '', 'ruby', 'unknown-language'])(
    'falls back from %s to readable plaintext',
    (language) => {
      const source = '<script>alert("still text")</script>'
      const result = highlightTanStackCode(source, language)

      expect(result.lang).toBe('plaintext')
      expect(result.tokens).toEqual([{ value: source }])
      expect(result.html).toContain('data-language="plaintext"')
      expect(result.html).toContain(
        '&lt;script&gt;alert(&quot;still text&quot;)&lt;/script&gt;',
      )
      expect(result.html).not.toContain('<script>')
    },
  )
})
