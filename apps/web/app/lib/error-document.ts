import { createContext, useContext } from 'react'
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '~/i18n/messages'

type DocumentDefaults = { locale: Locale; appOrigin?: string }

export const RequestLocaleContext = createContext<Locale | undefined>(undefined)
export const ApplicationOriginContext = createContext<string | undefined>(
  undefined,
)

export function useErrorDocument(data?: DocumentDefaults) {
  const requestLocale = useContext(RequestLocaleContext)
  const applicationOrigin = useContext(ApplicationOriginContext)
  const html = typeof document === 'undefined' ? null : document.documentElement
  return {
    locale:
      data?.locale ??
      requestLocale ??
      (isSupportedLocale(html?.lang) ? html.lang : DEFAULT_LOCALE),
    appOrigin: data?.appOrigin ?? applicationOrigin ?? html?.dataset.appOrigin,
  }
}
