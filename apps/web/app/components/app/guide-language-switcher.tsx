import { Fragment } from 'react'
import { Link } from 'react-router'
import { Inline } from '~/components/layout/inline'
import { LOCALE_LABEL, SUPPORTED_LOCALES, type Locale } from '~/i18n/messages'
import { guideLanguageSwitcherLinksClassName } from '~/components/app/guide-styles'

export function GuideLanguageSwitcher({
  locale,
  hrefFor,
}: {
  locale: Locale
  hrefFor: (code: Locale) => string
}) {
  return (
    <Inline gap="2" align="center" asChild>
      <nav
        className={guideLanguageSwitcherLinksClassName}
        aria-label={locale === 'ja' ? '言語' : 'Language'}
      >
        {SUPPORTED_LOCALES.map((code, index) => (
          <Fragment key={code}>
            {index > 0 && (
              <span className="text-faint" aria-hidden="true">
                ·
              </span>
            )}
            {code === locale ? (
              <span aria-current="true">{LOCALE_LABEL[code]}</span>
            ) : (
              <Link to={hrefFor(code)}>{LOCALE_LABEL[code]}</Link>
            )}
          </Fragment>
        ))}
      </nav>
    </Inline>
  )
}
