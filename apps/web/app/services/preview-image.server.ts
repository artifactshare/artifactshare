/* Hallmark · component: OG card · genre: editorial · tone: warm precise
 * theme: Artifact Share design system · paper: surface-warm · ink: foreground
 * accent: existing coral brand mark only · contrast: pass · slop: pass
 * pre-emit critique: P5 H5 E5 S5 R5 V4
 */
import lineSeedJapanese400 from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-400-normal.woff2'
import lineSeedJapanese700 from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-700-normal.woff2'
import lineSeedLatin400 from '@fontsource/line-seed-jp/files/line-seed-jp-latin-400-normal.woff2'
import lineSeedLatin700 from '@fontsource/line-seed-jp/files/line-seed-jp-latin-700-normal.woff2'
import { render } from 'takumi-js'
import { connectContent } from '~/lib/connect-content'
import { privateMobileDesignHandoffContent } from '~/lib/private-mobile-design-handoff-content'
import { MESSAGES, type Locale } from '~/i18n/messages'
import { BRAND_OG_MARK } from './brand-og-mark.generated'
import { createHomeCard } from './home-og-card'
import { layoutOgTitle } from './og-title-layout'

const WIDTH = 1200
const HEIGHT = 630
const LATIN_FONT_FAMILY = 'LINE Seed JP Latin'
const JAPANESE_FONT_FAMILY = 'LINE Seed JP Japanese'
const FONT_STACK = `'${LATIN_FONT_FAMILY}','${JAPANESE_FONT_FAMILY}',sans-serif`

const TOKENS = {
  paper: '#fbfaf8',
  ink: '#37352f',
  mutedInk: '#6a675f',
  faintInk: '#8b877e',
  rule: '#dedbd3',
} as const

const FONT_ASSETS = [
  { name: LATIN_FONT_FAMILY, data: lineSeedLatin400, weight: 400 },
  { name: JAPANESE_FONT_FAMILY, data: lineSeedJapanese400, weight: 400 },
  { name: LATIN_FONT_FAMILY, data: lineSeedLatin700, weight: 700 },
  { name: JAPANESE_FONT_FAMILY, data: lineSeedJapanese700, weight: 700 },
]

type CardInput = {
  lang: Locale
  kind: string
  title: string
  subhead?: string | null
  owner?: string | null
  ownerAvatarUrl?: string | null
  footer?: string
  url: string
}

export function renderConnectOgImage(
  locale: Locale,
  _fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  const content = connectContent(locale).og
  return renderCard({
    lang: locale,
    kind: 'MCP & CLI',
    title: content.cardHeadline,
    subhead: content.cardSubhead,
    footer: localizedFooter(locale),
    url: 'artifactshare.com/connect',
  })
}

export function renderShareOgImage(input: {
  title: string
  ownerLabel: string | null
  ownerAvatarUrl: string | null
  urlLabel: string
  fontKv: KVNamespace | undefined
}): Promise<Uint8Array> {
  return renderCard({
    lang: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
      input.title,
    )
      ? 'ja'
      : 'en',
    kind: 'SHARED LINK',
    title: input.title,
    owner: input.ownerLabel,
    ownerAvatarUrl: input.ownerAvatarUrl,
    url: input.urlLabel,
  })
}

export function renderUpdatesEntryOgImage(input: {
  title: string
  locale: Locale
  urlLabel: string
  fontKv: KVNamespace | undefined
}): Promise<Uint8Array> {
  return renderCard({
    lang: input.locale,
    kind: MESSAGES[input.locale]['updates.pageTitle'],
    title: input.title,
    footer: localizedFooter(input.locale),
    url: input.urlLabel,
  })
}

export function renderPrivateMobileDesignHandoffOgImage(
  locale: Locale,
  _fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  const content = privateMobileDesignHandoffContent(locale)
  return renderCard({
    lang: locale,
    kind: 'GUIDE',
    title: content.og.title,
    subhead: content.og.subhead,
    footer: localizedFooter(locale),
    url: `artifactshare.com${content.canonicalPath}`,
  })
}

export function renderHomeOgImage(
  locale: Locale,
  _fontKv: KVNamespace | undefined,
): Promise<Uint8Array> {
  return renderCard({ ...createHomeCard(locale), lang: locale })
}

async function renderCard(input: CardInput): Promise<Uint8Array> {
  let title = layoutOgTitle(input.title, input.subhead ? 68 : 76)
  if (title.lines.length === 3) {
    title = layoutOgTitle(input.title, input.subhead ? 58 : 68)
  }
  const owner = input.owner ? truncateLabel(input.owner, 48) : null
  const titleMarkup = title.lines
    .map(
      (line) =>
        `<span style="display:block;white-space:nowrap">${escapeHtml(line)}</span>`,
    )
    .join('')
  const metadata = [owner ? `by ${owner}` : null, input.url]
    .filter(Boolean)
    .map((item) => escapeHtml(item!))
    .join(' · ')
  const ownerCredit = owner
    ? `<div style="display:flex;align-items:center;gap:10px;width:720px;max-width:720px;overflow:hidden">${input.ownerAvatarUrl ? `<img src="${escapeHtml(input.ownerAvatarUrl)}" width="32" height="32" style="display:block;width:32px;height:32px;flex-grow:0;flex-shrink:0;border-radius:999px;object-fit:cover" />` : `<span style="width:32px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;flex-grow:0;flex-shrink:0;background:${TOKENS.rule};color:${TOKENS.mutedInk};font-size:16px;font-weight:700">${escapeHtml(initialFor(owner))}</span>`}<span style="display:block;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${metadata}</span></div>`
    : `<div style="display:block;max-width:720px">${metadata}</div>`

  try {
    const png = await render(
      `<main style="width:${WIDTH}px;height:${HEIGHT}px;box-sizing:border-box;padding:64px 72px;display:block;overflow:hidden;background:${TOKENS.paper};color:${TOKENS.ink};font-family:${FONT_STACK}">
      <header style="width:1056px;height:44px;display:flex;align-items:center;gap:16px">
        <img src="${BRAND_OG_MARK}" width="44" height="44" style="width:44px;height:44px" />
        <strong style="font-size:30px;font-weight:700;letter-spacing:-0.02em">Artifact Share</strong>
      </header>
      <section style="width:1056px;height:300px;display:flex;flex-direction:column;gap:18px;margin-top:54px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:14px;color:${TOKENS.mutedInk};font-size:18px;font-weight:700;letter-spacing:0.13em">
          <span style="display:block;width:40px;height:2px;background:${TOKENS.ink}"></span>${escapeHtml(input.kind)}
        </div>
        <h1 style="display:flex;flex-direction:column;margin:0;max-width:1056px;color:${TOKENS.ink};font-size:${title.fontSize}px;font-weight:700;line-height:1.14;letter-spacing:-0.025em">${titleMarkup}</h1>
        ${input.subhead ? `<p style="display:block;margin:0;max-width:960px;color:${TOKENS.mutedInk};font-size:28px;font-weight:400;line-height:1.35">${escapeHtml(input.subhead)}</p>` : '<span style="display:block;width:1px;height:1px;overflow:hidden">&#160;</span>'}
      </section>
      <footer style="width:1056px;height:56px;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-top:48px;padding-top:14px;border-top:1px solid ${TOKENS.rule};color:${TOKENS.faintInk};font-size:22px;font-weight:400;line-height:1.2">
        ${ownerCredit}<span style="display:block;width:320px;text-align:right">${escapeHtml(input.footer ?? 'Same URL, every revision.')}</span>
      </footer>
    </main>`,
      {
        width: WIDTH,
        height: HEIGHT,
        format: 'png',
        fonts: FONT_ASSETS,
        fontFamilies: [LATIN_FONT_FAMILY, JAPANESE_FONT_FAMILY],
        lang: input.lang,
        images: input.ownerAvatarUrl
          ? {
              timeout: 1_500,
              maxBytes: 2 * 1024 * 1024,
              allowUrl: (url) => url.toString() === input.ownerAvatarUrl,
            }
          : undefined,
      },
    )
    return new Uint8Array(png)
  } catch (error) {
    if (!input.ownerAvatarUrl) throw error
    return renderCard({ ...input, ownerAvatarUrl: null })
  }
}

function localizedFooter(locale: Locale): string {
  return locale === 'ja'
    ? '同じURLで、更新を重ねる。'
    : 'Same URL, every revision.'
}

function initialFor(value: string): string {
  return [...value.trim()][0]?.toLocaleUpperCase() ?? '?'
}

function truncateLabel(value: string, maxLength: number): string {
  const characters = [...value.trim()]
  return characters.length <= maxLength
    ? characters.join('')
    : `${characters
        .slice(0, maxLength - 1)
        .join('')
        .trimEnd()}…`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
