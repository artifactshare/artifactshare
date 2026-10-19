import japaneseRegular from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-400-normal.woff2?inline'
import japaneseBold from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-700-normal.woff2?inline'
import latinRegular from '@fontsource/line-seed-jp/files/line-seed-jp-latin-400-normal.woff2?inline'
import latinBold from '@fontsource/line-seed-jp/files/line-seed-jp-latin-700-normal.woff2?inline'
import license from '@fontsource/line-seed-jp/LICENSE?raw'

// Fixed build inputs, never artifact-selected URLs. Keep the OFL attribution in
// the distributed stylesheet, including the opaque print document.
export const PRINT_FONT_FAMILY = 'ArtifactSharePrintJP'
export type PrintFontFace = {
  weight: string
  data: string
  unicodeRange?: string
}
export const PRINT_FONT_ATTRIBUTION = `/* ${license.replaceAll('*/', '* /')} */`
export const PRINT_FONT_FACES: PrintFontFace[] = [
  [400, japaneseRegular, undefined],
  [700, japaneseBold, undefined],
  [
    400,
    latinRegular,
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD',
  ],
  [
    700,
    latinBold,
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD',
  ],
].map(([weight, uri, unicodeRange]) => {
  if (
    typeof uri !== 'string' ||
    !uri.startsWith('data:font/woff2;base64,') ||
    uri.length > 2 * 1024 * 1024
  )
    throw new Error('Invalid bundled print font')
  return {
    weight: String(weight),
    data: uri.slice(uri.indexOf(',') + 1),
    unicodeRange: typeof unicodeRange === 'string' ? unicodeRange : undefined,
  }
})

// The trusted, same-origin popup can use ordinary CSS font loading. Its opaque
// child receives these same bytes as binary FontFace sources, without a URL load.
export const PRINT_FONT_STYLE = `${PRINT_FONT_ATTRIBUTION}\n${PRINT_FONT_FACES.map(
  ({ weight, data, unicodeRange }) =>
    `@font-face{font-family:${PRINT_FONT_FAMILY};font-style:normal;font-weight:${weight};font-display:block;src:url("data:font/woff2;base64,${data}") format("woff2");${unicodeRange ? `unicode-range:${unicodeRange};` : ''}}`,
).join('\n')}`
