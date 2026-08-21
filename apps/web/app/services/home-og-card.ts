import type { Locale } from '~/i18n/messages'
import { MESSAGES } from '~/i18n/messages'
import { BRAND_OG_MARK } from './brand-og-mark.generated'

// Kept separate from preview-image.server.ts so the card tree can be tested
// without importing the satori/resvg wasm modules.

const FONT_FAMILY = 'Geist'
const SERIF_FONT_FAMILY = 'ZenOldMincho'
const BRAND_BG = '#fbfaf8'
const BRAND_TEXT = '#37352f'
const BRAND_MUTED = 'rgba(55, 53, 47, 0.65)'
const BRAND_FAINT = 'rgba(55, 53, 47, 0.45)'
const BRAND_GLOW =
  'radial-gradient(circle at 16% 0%, rgba(35, 131, 226, 0.06), transparent 42%), radial-gradient(circle at 84% 100%, rgba(255, 138, 101, 0.1), transparent 46%)'

export { SERIF_FONT_FAMILY as HOME_CARD_SERIF_FONT_FAMILY }

// Home Open Graph card: mirrors the landing hero — the SHARE/COMMENT/UPDATE
// badge, the two-tone serif headline, and the opening promise — sourced from
// the same i18n catalog the page renders from so the card and the page it
// links to never drift.
export function createHomeCard(locale: Locale) {
  // The hero's in-page opening line assumes page context; a social card is
  // seen cold, so the subhead states what the product is. lp.title is the
  // clipped-form (体言止め) variant of the canonical product sentence — the
  // polite です form reads out of place on a card.
  const subhead = MESSAGES[locale]['lp.title']
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '80px',
        backgroundColor: BRAND_BG,
        backgroundImage: BRAND_GLOW,
        color: BRAND_TEXT,
        fontFamily: FONT_FAMILY,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: '18px' },
            children: [
              {
                type: 'img',
                props: {
                  src: BRAND_OG_MARK,
                  width: 44,
                  height: 44,
                  style: { width: '44px', height: '44px' },
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '32px',
                    fontWeight: 700,
                    letterSpacing: '-0.025em',
                    color: BRAND_TEXT,
                  },
                  children: 'Artifact Share',
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: '26px' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px',
                    alignSelf: 'flex-start',
                    padding: '10px 24px',
                    borderRadius: '999px',
                    border: '1.5px solid rgba(55, 53, 47, 0.18)',
                    color: BRAND_MUTED,
                    fontSize: '20px',
                    letterSpacing: '0.16em',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: '12px',
                          height: '12px',
                          borderRadius: '999px',
                          backgroundColor: '#ff6f61',
                        },
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        children: 'SHARE · COMMENT · UPDATE — SAME URL',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    fontFamily: SERIF_FONT_FAMILY,
                    fontWeight: 700,
                    fontSize: '72px',
                    lineHeight: 1.15,
                    letterSpacing: '-0.01em',
                    maxWidth: '1040px',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { color: 'rgba(55, 53, 47, 0.55)' },
                        children: MESSAGES[locale]['lp.hero.titleDim'],
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        children: MESSAGES[locale]['lp.hero.titleMain'],
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '30px',
                    lineHeight: 1.4,
                    color: BRAND_MUTED,
                    maxWidth: '1000px',
                  },
                  children: subhead,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '18px',
              fontSize: '28px',
              color: BRAND_FAINT,
            },
            children: [
              {
                type: 'div',
                props: {
                  children:
                    locale === 'ja'
                      ? 'artifactshare.com/ja'
                      : 'artifactshare.com',
                },
              },
            ],
          },
        },
      ],
    },
  }
}
