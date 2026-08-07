import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'

export const CONNECT_AI_AGENTS_ANCHOR = 'ai-agents'
export const CONNECT_CLAUDE_ANCHOR = 'claude'
export const CONNECT_CHATGPT_ANCHOR = 'chatgpt'
export const CONNECT_CURSOR_ANCHOR = 'cursor'

export function withLang(base: string, locale: Locale, hash?: string): string {
  const normalizedBase = base === '/' ? '' : base
  const path = locale === DEFAULT_LOCALE ? base : `/ja${normalizedBase}`
  return hash ? `${path}#${hash}` : path
}
