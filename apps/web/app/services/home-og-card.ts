import type { Locale } from '~/i18n/messages'
import { MESSAGES } from '~/i18n/messages'

export type HomeOgCardContent = {
  kind: string
  title: string
  subhead: string
  url: string
}

export function createHomeCard(locale: Locale): HomeOgCardContent {
  return {
    kind: 'SHARE · COMMENT · UPDATE',
    title: `${MESSAGES[locale]['lp.hero.titleDim']} ${MESSAGES[locale]['lp.hero.titleMain']}`,
    subhead: MESSAGES[locale]['lp.title'],
    url: locale === 'ja' ? 'artifactshare.com/ja' : 'artifactshare.com',
  }
}
