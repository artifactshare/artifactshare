import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import type { Locale } from '~/i18n/messages'
const state = vi.hoisted(() => ({ on: false, locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(state.locale) }))
vi.mock('react-router', () => ({
  useFetcher: () => ({ state: 'idle' }),
  useRouteLoaderData: () => ({
    analyticsConsent: { shouldLoadAnalytics: state.on },
  }),
}))
import Analytics from './analytics'
test.each(['en', 'ja'] as const)(
  'consent buttons expose the selected state in %s',
  (locale) => {
    state.locale = locale
    for (const on of [false, true]) {
      state.on = on
      const html = renderToStaticMarkup(<Analytics />)
      expect(
        [...html.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1]),
      ).toEqual([String(on), String(!on)])
      expect(html).toContain(
        bindI18n(locale).t('analyticsConsent.settings.title'),
      )
    }
  },
)
