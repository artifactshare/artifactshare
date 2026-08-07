import { renderMarkdown } from '~/lib/markdown'
import privacyEnMd from '~/legal/privacy.en.md?raw'
import privacyJaMd from '~/legal/privacy.ja.md?raw'
import termsEnMd from '~/legal/terms.en.md?raw'
import termsJaMd from '~/legal/terms.ja.md?raw'
import tokushohoEnMd from '~/legal/tokushoho.en.md?raw'
import tokushohoJaMd from '~/legal/tokushoho.ja.md?raw'
import type { Locale } from '~/i18n/messages'

interface LegalDoc {
  en: string
  ja: string
}

const PRIVACY: LegalDoc = {
  en: renderMarkdown(privacyEnMd),
  ja: renderMarkdown(privacyJaMd),
}

const TERMS: LegalDoc = {
  en: renderMarkdown(termsEnMd),
  ja: renderMarkdown(termsJaMd),
}

const TOKUSHOHO: LegalDoc = {
  en: renderMarkdown(tokushohoEnMd),
  ja: renderMarkdown(tokushohoJaMd),
}

export function privacyHtml(locale: Locale): string {
  return PRIVACY[locale] ?? PRIVACY.en
}

export function termsHtml(locale: Locale): string {
  return TERMS[locale] ?? TERMS.en
}

export function tokushohoHtml(locale: Locale): string {
  return TOKUSHOHO[locale] ?? TOKUSHOHO.en
}
