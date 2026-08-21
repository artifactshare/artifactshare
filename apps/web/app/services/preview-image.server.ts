import { initWasm, Resvg } from '@resvg/resvg-wasm'
import type { ReactNode } from 'react'
import satori, { init as initSatori } from 'satori/standalone'
import { connectContent } from '~/lib/connect-content'
import { privateMobileDesignHandoffContent } from '~/lib/private-mobile-design-handoff-content'
import { MESSAGES, type Locale } from '~/i18n/messages'
import { BRAND_OG_MARK } from './brand-og-mark.generated'

import resvgWasmModule from '@resvg/resvg-wasm/index_bg.wasm'
import yogaWasmModule from 'satori/yoga.wasm'

const WIDTH = 1200
const HEIGHT = 630
const FONT_FAMILY = 'Geist'
const CJK_FONT_FAMILY = 'NotoSansCJKjp'

// Design-system tokens mirrored for the marketing Open Graph cards (satori can't
// read CSS custom properties). Keep in sync with app/styles/tokens.css: the warm
// background and the two faint corner glows from the logged-out landing hero.
const BRAND_BG = '#fbfaf8'
const BRAND_TEXT = '#37352f'
const BRAND_MUTED = 'rgba(55, 53, 47, 0.65)'
const BRAND_FAINT = 'rgba(55, 53, 47, 0.45)'
const BRAND_GLOW =
  'radial-gradient(circle at 16% 0%, rgba(35, 131, 226, 0.06), transparent 42%), radial-gradient(circle at 84% 100%, rgba(255, 138, 101, 0.1), transparent 46%)'
const GEIST_TTF_URL =
  'https://raw.githubusercontent.com/vercel/geist-font/main/fonts/Geist/ttf/Geist-Regular.ttf'
// Bold weight for the brand wordmark on the marketing cards, matching the
// logged-out landing hero. Only the marketing cards load it.
const GEIST_BOLD_TTF_URL =
  'https://raw.githubusercontent.com/vercel/geist-font/main/fonts/Geist/ttf/Geist-Bold.ttf'
// Serif for the home card headline, matching the landing hero (Zen Old Mincho).
const SERIF_FONT_FAMILY = 'ZenOldMincho'
const ZEN_OLD_MINCHO_BOLD_TTF_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/zenoldmincho/ZenOldMincho-Bold.ttf'
const NOTO_CJKJP_OTF_URL =
  'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'
const CJK_FONT_CACHE_KEY = 'slack-preview:font:noto-sans-jp:2026-05-16'

type SatoriFont = {
  name: string
  data: ArrayBuffer
  weight: 400 | 700
  style: 'normal'
}

let wasmReady: Promise<void> | undefined
let satoriReady: Promise<void> | undefined
let fontData: Promise<ArrayBuffer> | undefined
let boldFontData: Promise<ArrayBuffer> | undefined
let cjkFontData: Promise<ArrayBuffer> | undefined
let serifFontData: Promise<ArrayBuffer> | undefined

export async function renderConnectOgImage(
  locale: Locale,
  fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  return await renderLocalizedMarketingCard(
    createConnectCard(locale) as ReactNode,
    fontKv,
  )
}

async function renderLocalizedMarketingCard(
  card: ReactNode,
  fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  const [font, boldFont, cjkFont] = await Promise.all([
    loadFont(),
    loadBoldFont(),
    loadCjkFont(fontKv),
  ])
  return renderCardToPng(card, [
    { name: FONT_FAMILY, data: font, weight: 400, style: 'normal' },
    { name: FONT_FAMILY, data: boldFont, weight: 700, style: 'normal' },
    { name: CJK_FONT_FAMILY, data: cjkFont, weight: 400, style: 'normal' },
  ])
}

export function renderShareOgImage(input: {
  title: string
  ownerLabel: string | null
  urlLabel: string
  fontKv: KVNamespace | undefined
}): Promise<Uint8Array> {
  return renderLocalizedMarketingCard(
    createShareCard(input) as ReactNode,
    input.fontKv,
  )
}

export function renderUpdatesEntryOgImage(input: {
  title: string
  locale: Locale
  urlLabel: string
  fontKv: KVNamespace | undefined
}): Promise<Uint8Array> {
  return renderLocalizedMarketingCard(
    createUpdatesEntryCard(input) as ReactNode,
    input.fontKv,
  )
}

export function renderPrivateMobileDesignHandoffOgImage(
  locale: Locale,
  fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  const content = privateMobileDesignHandoffContent(locale)
  return renderLocalizedMarketingCard(
    createMarketingCard({
      headline: content.og.title,
      subhead: content.og.subhead,
      url: `artifactshare.com${content.canonicalPath}`,
      pill: 'Guide',
    }) as ReactNode,
    fontKv,
  )
}

// A branded Open Graph card for the home landing page. English only (the apex
// stays a bare, single-language card), so it skips the CJK fallback font.
export async function renderHomeOgImage(): Promise<Uint8Array> {
  const [font, boldFont, serifFont] = await Promise.all([
    loadFont(),
    loadBoldFont(),
    loadSerifFont(),
  ])
  return renderCardToPng(createHomeCard() as ReactNode, [
    { name: FONT_FAMILY, data: font, weight: 400, style: 'normal' },
    { name: FONT_FAMILY, data: boldFont, weight: 700, style: 'normal' },
    { name: SERIF_FONT_FAMILY, data: serifFont, weight: 700, style: 'normal' },
  ])
}

// Shared satori → resvg → PNG plumbing for every card. Callers pick which fonts
// to load; the wasm + satori init are memoized across calls.
async function renderCardToPng(
  card: ReactNode,
  fonts: SatoriFont[],
): Promise<Uint8Array> {
  await Promise.all([loadSatori(), loadResvg()])
  const svg = await satori(card, { width: WIDTH, height: HEIGHT, fonts })
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      fontBuffers: fonts.map((f) => new Uint8Array(f.data)),
    },
  })
  try {
    const image = renderer.render()
    try {
      return image.asPng()
    } finally {
      image.free()
    }
  } finally {
    renderer.free()
  }
}

function loadSatori(): Promise<void> {
  satoriReady ??= initSatori(yogaWasmModule)
  return satoriReady!
}

function loadResvg(): Promise<void> {
  wasmReady ??= initWasm(resvgWasmModule)
  return wasmReady
}

function loadFont(): Promise<ArrayBuffer> {
  fontData ??= fetchFont(GEIST_TTF_URL)
  return fontData
}

function loadBoldFont(): Promise<ArrayBuffer> {
  boldFontData ??= fetchFont(GEIST_BOLD_TTF_URL)
  return boldFontData
}

function loadSerifFont(): Promise<ArrayBuffer> {
  serifFontData ??= fetchFont(ZEN_OLD_MINCHO_BOLD_TTF_URL)
  return serifFontData
}

function loadCjkFont(fontKv: KVNamespace | undefined): Promise<ArrayBuffer> {
  cjkFontData ??= loadCjkFontFromKv(fontKv)
  return cjkFontData
}

async function loadCjkFontFromKv(
  fontKv: KVNamespace | undefined,
): Promise<ArrayBuffer> {
  const cached = await fontKv?.get(CJK_FONT_CACHE_KEY, 'arrayBuffer')
  if (cached) return cached

  const font = await fetchFont(NOTO_CJKJP_OTF_URL)
  await fontKv?.put(CJK_FONT_CACHE_KEY, font)
  return font
}

async function fetchFont(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to load preview font: ${response.status}`)
  return response.arrayBuffer()
}

// Home Open Graph card: mirrors the landing hero — the SHARE/COMMENT/UPDATE
// badge, the two-tone serif headline, and the opening promise — sourced from
// the same i18n catalog the page renders from (English only) so the card and
// the page it links to never drift.
function createHomeCard() {
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
                        children: MESSAGES.en['lp.hero.titleDim'],
                      },
                    },
                    {
                      type: 'div',
                      props: { children: MESSAGES.en['lp.hero.titleMain'] },
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
                  children: `${MESSAGES.en['lp.hero.bodyLead']}${MESSAGES.en['lp.hero.bodyQuote']}`,
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
              { type: 'div', props: { children: 'artifactshare.com' } },
            ],
          },
        },
      ],
    },
  }
}

function createConnectCard(locale: Locale) {
  const { cardHeadline, cardSubhead } = connectContent(locale).og
  return createMarketingCard({
    headline: cardHeadline,
    subhead: cardSubhead,
    pill: 'MCP & CLI',
    url: 'artifactshare.com/connect',
  })
}

function createUpdatesEntryCard(input: {
  title: string
  locale: Locale
  urlLabel: string
}) {
  const title = truncate(input.title, 86)
  const pill = MESSAGES[input.locale]['updates.pageTitle']
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px',
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
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '26px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    alignSelf: 'flex-start',
                    padding: '12px 22px',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(35, 131, 226, 0.1)',
                    color: '#2383e2',
                    fontSize: '24px',
                  },
                  children: pill,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: title.length > 52 ? '64px' : '76px',
                    lineHeight: 1.06,
                    maxWidth: '1040px',
                    fontWeight: 700,
                  },
                  children: title,
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
              justifyContent: 'space-between',
              gap: '24px',
              fontSize: '26px',
              color: BRAND_FAINT,
            },
            children: [
              {
                type: 'div',
                props: { children: input.urlLabel },
              },
              {
                type: 'div',
                props: {
                  style: {
                    width: '320px',
                    height: '10px',
                    borderRadius: '999px',
                    background:
                      'linear-gradient(90deg, #2383e2 0%, #f76b58 100%)',
                  },
                  children: '',
                },
              },
            ],
          },
        },
      ],
    },
  }
}

function createShareCard(input: {
  title: string
  ownerLabel: string | null
  urlLabel: string
}) {
  const title = truncate(input.title, 86)
  const ownerLabel = input.ownerLabel ? truncate(input.ownerLabel, 48) : null
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px',
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
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '26px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    alignSelf: 'flex-start',
                    padding: '12px 22px',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(35, 131, 226, 0.1)',
                    color: '#2383e2',
                    fontSize: '24px',
                  },
                  children: 'Shared link',
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: title.length > 52 ? '64px' : '76px',
                    lineHeight: 1.06,
                    maxWidth: '1040px',
                    fontWeight: 700,
                  },
                  children: title,
                },
              },
              ...(ownerLabel
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '32px',
                          color: BRAND_MUTED,
                        },
                        children: `by ${ownerLabel}`,
                      },
                    },
                  ]
                : []),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '24px',
              fontSize: '26px',
              color: BRAND_FAINT,
            },
            children: [
              {
                type: 'div',
                props: { children: input.urlLabel },
              },
              {
                type: 'div',
                props: {
                  style: {
                    width: '320px',
                    height: '10px',
                    borderRadius: '999px',
                    background:
                      'linear-gradient(90deg, #2383e2 0%, #f76b58 100%)',
                  },
                  children: '',
                },
              },
            ],
          },
        },
      ],
    },
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const sliced = value.slice(0, maxLength - 1).trimEnd()
  const last = sliced.charCodeAt(sliced.length - 1)
  const safe =
    last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1).trimEnd() : sliced
  return `${safe}…`
}

// Shared layout for the marketing Open Graph cards (home, /connect): the brand
// mark and wordmark, the headline and subhead, and a footer row. `pill` is an
// optional label shown before the URL.
function createMarketingCard(input: {
  headline: string
  subhead: string
  url: string
  pill?: string
}) {
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
                // The brand logo as an inline PNG data URI (BRAND_OG_MARK is
                // @generated from docs/brand/icon.svg by docs/brand/build.sh).
                // Inlined, not fetched — same single source as the favicon, no
                // runtime request, so the card can't drift from it.
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
            style: { display: 'flex', flexDirection: 'column', gap: '28px' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '82px',
                    lineHeight: 1.04,
                    maxWidth: '1000px',
                  },
                  children: input.headline,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '36px',
                    lineHeight: 1.3,
                    color: BRAND_MUTED,
                    maxWidth: '1000px',
                  },
                  children: input.subhead,
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
              ...(input.pill
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '10px 20px',
                          borderRadius: '999px',
                          backgroundColor: BRAND_TEXT,
                          color: BRAND_BG,
                          fontSize: '24px',
                        },
                        children: input.pill,
                      },
                    },
                  ]
                : []),
              {
                type: 'div',
                props: { children: input.url },
              },
            ],
          },
        },
      ],
    },
  }
}
