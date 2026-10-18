import fontUri from '@fontsource/line-seed-jp/files/line-seed-jp-latin-400-normal.woff2?inline'

// Shared with the actual export browser tests and the existing local capture seed.
// These contain no application capabilities or production identifiers.
export const PDF_FIXTURE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAIAAADmAupWAAAAaklEQVR4nO3PMQqAQBAEwXumf/D3BorZhUZutrADBZMOdK33voo951Es8bsSo4GBgYGjooGBgT/wzKy+L3BCNDAwMHBUNDBwAZ6Z1fcFTogGBgYGjooGBi7AM7P6vsAJ0cDAwMBR0cDA/9u1gcplojvHQQAAAABJRU5ErkJggg=='
export const PDF_FIXTURE_FONT = fontUri
const html = (content: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:24px;color:#37352f;font:16px/1.6 sans-serif}h1{font-size:32px}</style></head><body>${content}</body></html>`
export type PdfFixtureFile = {
  path: string
  mime: string
  body: string | Uint8Array<ArrayBuffer>
}
export function decodeFixtureData(uri: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), (c) =>
    c.charCodeAt(0),
  )
}

export const PDF_EXPORT_FIXTURES = [
  {
    name: 'PDF report.html',
    kind: 'html_page' as const,
    path: '/index.html',
    source: html(
      `<h1>Export review</h1><p>Short, intrinsic-height HTML with an embedded image.</p><img width="64" height="40" src="${PDF_FIXTURE_IMAGE}" alt="Fixture image"><p>FINAL-PDF-MARKER</p>`,
    ),
  },
  {
    name: 'PDF diagram.md',
    kind: 'markdown_page' as const,
    path: '/index.md',
    source:
      '# Export review\n\n```mermaid\nflowchart LR\n  Source --> PDF\n```\n\nFINAL-PDF-MARKER',
  },
  {
    name: 'PDF long report.html',
    kind: 'html_page' as const,
    path: '/index.html',
    source: html(
      '<h1>Long report</h1><div style="height:41000px">Paged content</div><p>FINAL-PDF-MARKER</p>',
    ),
  },
  {
    name: 'PDF unavailable image.html',
    kind: 'html_page' as const,
    path: '/index.html',
    source: html(
      '<h1>Unavailable image</h1><img src="missing.png" alt="Required image">',
    ),
  },
  {
    name: 'PDF selected guide',
    kind: 'static_site' as const,
    path: '/guide/report.html',
    source:
      '<!doctype html><html lang="en"><head><link rel="stylesheet" href="../styles/main.css"></head><body><h1>Selected guide page</h1><img src="../images/mark.png" width="80" height="40" alt="Embedded fixture"><p>FINAL-PDF-MARKER</p></body></html>',
  },
] as const

export function pdfFixtureFiles(index: number): PdfFixtureFile[] {
  const fixture = PDF_EXPORT_FIXTURES[index]
  if (!fixture) throw new Error('Unknown PDF fixture')
  const files: PdfFixtureFile[] = [
    {
      path: fixture.path,
      mime: fixture.kind === 'markdown_page' ? 'text/markdown' : 'text/html',
      body: fixture.source,
    },
  ]
  if (fixture.kind === 'static_site')
    files.push(
      {
        path: '/index.html',
        mime: 'text/html',
        body: '<a href="/guide/report.html">Open guide</a>',
      },
      {
        path: '/styles/main.css',
        mime: 'text/css',
        body: '@import "nested/theme.css" layer(theme); body{margin:24px;font:18px/1.6 ExportFixture,sans-serif}',
      },
      {
        path: '/styles/nested/theme.css',
        mime: 'text/css',
        body: '@font-face{font-family:ExportFixture;src:url("../../fonts/report.woff2?v=1")} h1{font-family:ExportFixture;color:#1766ad;background-image:url("/images/mark.png#fixture")}',
      },
      {
        path: '/fonts/report.woff2',
        mime: 'font/woff2',
        body: decodeFixtureData(fontUri),
      },
      {
        path: '/images/mark.png',
        mime: 'image/png',
        body: decodeFixtureData(PDF_FIXTURE_IMAGE),
      },
    )
  return files
}
