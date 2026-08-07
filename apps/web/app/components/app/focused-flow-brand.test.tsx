import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { FocusedFlowBrand } from './focused-flow-brand'

let mockedLocale = 'en' as 'en' | 'ja'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockedLocale,
    t: (key: string) =>
      key === 'vw.homeLink'
        ? mockedLocale === 'ja'
          ? 'Artifact Share のホーム'
          : 'Artifact Share home'
        : key,
  }),
}))

describe('FocusedFlowBrand', () => {
  test.each([
    ['en', 'Artifact Share home'],
    ['ja', 'Artifact Share のホーム'],
  ] as const)(
    'renders the shared brand contract for %s',
    (locale, homeLabel) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <FocusedFlowBrand />
        </MemoryRouter>,
      )

      expect(html).toContain('href="/"')
      expect(html).toContain(`aria-label="${homeLabel}"`)
      expect(html).toContain('bg-[url(/favicon.svg)]')
      expect(html).toContain('>Artifact Share<')
      expect(html).toContain('mb-4')
    },
  )
})
