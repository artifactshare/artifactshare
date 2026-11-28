import { useRouteLoaderData } from 'react-router'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { bindI18n, type Translator } from '~/lib/i18n'

type RootLoaderData = { locale: Locale }

export function useT(): Translator {
  const data = useRouteLoaderData<RootLoaderData>('root')
  return bindI18n(data?.locale ?? DEFAULT_LOCALE)
}
