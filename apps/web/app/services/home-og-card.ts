import type { Locale } from '~/i18n/messages'
import { MESSAGES } from '~/i18n/messages'

export type HomeOgCardContent = {
  kind: string
  title: string
  subhead: string
  footer: string
  url: string
}

export function createHomeCard(locale: Locale): HomeOgCardContent {
  return {
    kind: 'SHARE · COMMENT · UPDATE',
    title: `${MESSAGES[locale]['lp.hero.titleDim']} ${MESSAGES[locale]['lp.hero.titleMain']}`,
    subhead: MESSAGES[locale]['lp.title'],
    footer:
      locale === 'ja'
        ? '同じURLで、更新を重ねる。'
        : 'Same URL, every revision.',
    url: locale === 'ja' ? 'artifactshare.com/ja' : 'artifactshare.com',
  }
}
