import { createHighlighter } from '@tanstack/highlight/core'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { html } from '@tanstack/highlight/languages/html'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { python } from '@tanstack/highlight/languages/python'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { toml } from '@tanstack/highlight/languages/toml'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'
import { createThemeCss } from '@tanstack/highlight/theme'
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'

const languageDefinitions = [
  css,
  diff,
  dockerfile,
  html,
  js,
  json,
  jsx,
  markdown,
  python,
  shell,
  sql,
  toml,
  ts,
  tsx,
  yaml,
] as const

const highlighter = createHighlighter({ languages: languageDefinitions })

export const TANSTACK_HIGHLIGHT_LANGUAGES = Object.freeze(
  highlighter.listLanguages(),
)

export const TANSTACK_HIGHLIGHT_ALIASES = Object.freeze(
  Object.fromEntries(
    languageDefinitions.flatMap((definition) =>
      (definition.aliases ?? []).map((alias) => [alias, definition.name]),
    ),
  ),
)

export const TANSTACK_HIGHLIGHT_CSS = createThemeCss({
  light: githubDarkTheme,
})

export function highlightTanStackCode(code: string, language?: string) {
  return highlighter.highlight(code, language ? { lang: language } : {})
}

export function normalizeTanStackLanguage(language?: string) {
  return highlighter.normalizeLanguage(language)
}
