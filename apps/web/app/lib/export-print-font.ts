import japaneseRegular from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-400-normal.woff2?inline'
import japaneseBold from '@fontsource/line-seed-jp/files/line-seed-jp-japanese-700-normal.woff2?inline'
import latinRegular from '@fontsource/line-seed-jp/files/line-seed-jp-latin-400-normal.woff2?inline'
import latinBold from '@fontsource/line-seed-jp/files/line-seed-jp-latin-700-normal.woff2?inline'
import license from '@fontsource/line-seed-jp/LICENSE?raw'

// Fixed build inputs, never artifact-selected URLs. Keep the OFL attribution in
// the distributed stylesheet, including the opaque print document.
export const PRINT_FONT_FAMILY = 'ArtifactSharePrintJP'
export const PRINT_FONT_STYLE = `/* ${license.replaceAll('*/', '* /')} */\n${[
  [400, japaneseRegular, ''],
  [700, japaneseBold, ''],
  [
    400,
    latinRegular,
    'unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD;',
  ],
  [
    700,
    latinBold,
    'unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD;',
  ],
]
  .map(([weight, uri, range]) => {
    if (
      typeof uri !== 'string' ||
      !uri.startsWith('data:font/woff2;base64,') ||
      uri.length > 2 * 1024 * 1024
    )
      throw new Error('Invalid bundled print font')
    return `@font-face{font-family:${PRINT_FONT_FAMILY};font-style:normal;font-weight:${weight};font-display:block;src:url("${uri}") format("woff2");${range}}`
  })
  .join('\n')}`
