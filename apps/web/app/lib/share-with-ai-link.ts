import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'

export const SHARE_WITH_AI_EN_PATH = '/share-with-ai'
export const SHARE_WITH_AI_JA_PATH = '/ja/share-with-ai'

export function getShareWithAiPath(locale: Locale): string {
  return locale === DEFAULT_LOCALE
    ? SHARE_WITH_AI_EN_PATH
    : SHARE_WITH_AI_JA_PATH
}
