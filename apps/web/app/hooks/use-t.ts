import { useRouteLoaderData } from 'react-router'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { bindI18n, type Translator } from '~/lib/i18n'

type RootLoaderData = { locale: Locale }

/**
 * Component-side translator. Reads locale from root loader.
 *
 *   const { t, tPlural, locale } = useT();
 *   <button>{t("vw.copyUrl")}</button>
 *   <span>{tPlural("tb.fileCount", count)}</span>
 */
export function useT(): Translator {
  const data = useRouteLoaderData<RootLoaderData>('root')
  return bindI18n(data?.locale ?? DEFAULT_LOCALE)
}
