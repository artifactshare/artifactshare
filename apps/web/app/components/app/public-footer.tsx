import { Fragment } from 'react'
import {
  IconBrandGithub as GitHub,
  IconDeviceDesktop as Monitor,
  IconMoon as Moon,
  IconSun as Sun,
} from '@tabler/icons-react'
import { Link, useFetcher, useLocation, useRouteLoaderData } from 'react-router'
import { BrandMark } from '~/components/app/brand-mark'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'
import { IconButton } from '~/components/app/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { useT } from '~/hooks/use-t'
import { LOCALE_LABEL, SUPPORTED_LOCALES, type Locale } from '~/i18n/messages'
import { DEFAULT_APP_THEME, isAppTheme, type AppTheme } from '~/lib/app-theme'
import { withLang } from '~/lib/connect-link'
import { isPublicPagePath } from '~/lib/guide-locale'
import { cn } from '~/lib/utils'

export function PublicFooter({
  variant = 'full',
  'data-regression-region': regressionRegion,
}: {
  variant?: 'full' | 'minimal'
  'data-regression-region'?: string
}) {
  const { t, locale } = useT()
  const { openBanner } = useAnalyticsConsent()
  const location = useLocation()
  const fetcher = useFetcher()
  const rootData = useRouteLoaderData<{ appTheme?: AppTheme }>('root')
  const submittedTheme = fetcher.formData?.get('theme')
  const appTheme = isAppTheme(submittedTheme)
    ? submittedTheme
    : isAppTheme(rootData?.appTheme)
      ? rootData.appTheme
      : DEFAULT_APP_THEME
  const legal = [
    ['/privacy', t('lp.privacy')],
    ['/terms', t('lp.terms')],
    ['/tokushoho', t('lp.tokushoho')],
  ] as const
  const product = [
    ['/about', t('footer.about')],
    ['/connect', t('footer.connect')],
    ['/share-with-ai', t('footer.shareWithAi')],
    ['/pricing', t('lp.pricing')],
    ['/updates', t('updates.pageTitle')],
  ] as const
  const linkClass =
    'text-muted-foreground focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:rounded-[var(--r-sm)] text-xs no-underline hover:text-foreground hover:underline'
  const columnHeadingClass =
    'text-faint m-0 text-xs font-semibold tracking-widest uppercase'
  const links = (items: readonly (readonly [string, string])[]) =>
    items.map(([path, label]) => (
      <Link key={path} to={withLang(path, locale)} className={linkClass}>
        {label}
      </Link>
    ))
  const barePath = location.pathname.replace(/^\/ja(?=\/|$)/, '') || '/'
  // Minimal invite footers keep their existing compact navigation.
  const showLocaleSwitch = variant === 'full' && isPublicPagePath(barePath)
  const localeHref = (code: Locale) =>
    `${withLang(barePath, code)}${location.search}${location.hash}`
  const themeChange = (next: AppTheme) => {
    if (next === appTheme) return
    document.documentElement.dataset.theme = next
    fetcher.submit({ theme: next }, { method: 'POST', action: '/set-theme' })
  }
  const settingClass =
    'text-faint focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:rounded-[var(--r-sm)] hover:text-foreground'
  const themeOptions = [
    ['system', t('menu.appThemeSystem'), Monitor],
    ['light', t('menu.appThemeLight'), Sun],
    ['dark', t('menu.appThemeDark'), Moon],
  ] as const
  const ThemeIcon =
    themeOptions.find(([theme]) => theme === appTheme)?.[2] ?? Monitor
  return (
    <footer
      data-slot="public-footer"
      data-variant={variant}
      data-regression-region={regressionRegion}
      className={cn('border-divider w-full border-t px-6 py-8 text-left')}
    >
      {variant === 'full' ? (
        <div className="max-w-guide-shell-max max-stack:flex-col mx-auto flex flex-wrap gap-x-16 gap-y-8">
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Link
              to="/"
              aria-label={t('vw.homeLink')}
              className={cn(
                'text-foreground flex items-center gap-2 self-start text-sm font-semibold no-underline hover:opacity-70',
                'focus-visible:outline-ring focus-visible:rounded-[var(--r-sm)] focus-visible:outline-2 focus-visible:outline-offset-2',
              )}
            >
              <BrandMark size={16} aria-hidden="true" /> Artifact Share
            </Link>
            <p className="max-w-landing-sub-max text-muted-foreground m-0 text-xs">
              {t('lp.invite.about')}
            </p>
            <p className="text-muted-foreground m-0 text-xs">
              {t('footer.operatedBy')}{' '}
              <a
                className={linkClass}
                href="https://www.techtalk.jp"
                target="_blank"
                rel="noreferrer"
              >
                {t('footer.operatorName')}
              </a>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className={columnHeadingClass}>{t('footer.colProduct')}</h2>
            {links(product)}
            <a
              className={cn(linkClass, 'flex items-center gap-1')}
              href="https://github.com/artifactshare/artifactshare"
              target="_blank"
              rel="noreferrer"
            >
              <GitHub className="size-3.5" aria-hidden="true" />
              GitHub
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className={columnHeadingClass}>{t('footer.colLegal')}</h2>
            {links(legal)}
            <button
              type="button"
              className={linkClass}
              onClick={(event) => openBanner(event.currentTarget)}
            >
              {t('analyticsConsent.change')}
            </button>
          </div>
        </div>
      ) : null}
      <div
        className={cn(
          'max-w-guide-shell-max text-faint mx-auto flex flex-wrap items-center gap-x-6 gap-y-2 text-xs',
          variant === 'full' && 'mt-8',
        )}
      >
        {variant === 'minimal' ? (
          <>
            {links(legal)}
            <button
              type="button"
              className={linkClass}
              onClick={(event) => openBanner(event.currentTarget)}
            >
              {t('analyticsConsent.change')}
            </button>
          </>
        ) : null}
        <span suppressHydrationWarning>
          © {new Date().getFullYear()} Artifact Share
        </span>
        <nav
          className="flex items-center gap-2"
          aria-label={locale === 'ja' ? '設定' : 'Settings'}
        >
          {showLocaleSwitch ? (
            <>
              <span aria-label={locale === 'ja' ? '言語' : 'Language'}>
                {SUPPORTED_LOCALES.map((code, index) => (
                  <Fragment key={code}>
                    {index > 0 && <span aria-hidden="true"> · </span>}
                    {code === locale ? (
                      <span aria-current="true">{LOCALE_LABEL[code]}</span>
                    ) : (
                      <Link className={settingClass} to={localeHref(code)}>
                        {LOCALE_LABEL[code]}
                      </Link>
                    )}
                  </Fragment>
                ))}
              </span>
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                icon={ThemeIcon}
                size="sm"
                aria-label={t('menu.appTheme')}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuRadioGroup
                value={appTheme}
                onValueChange={(next) => themeChange(next as AppTheme)}
              >
                {themeOptions.map(([theme, label, Icon]) => (
                  <DropdownMenuRadioItem key={theme} value={theme}>
                    <Icon aria-hidden="true" />
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
      </div>
    </footer>
  )
}
