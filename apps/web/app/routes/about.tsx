import { Fragment } from 'react'
import { Link } from 'react-router'

import {
  GuideHomeLink,
  GuideMain,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import {
  guideOfficialInfoGridClassName,
  guideOfficialInfoSurfaceClassName,
  guideStepsClassName,
} from '~/components/app/guide-styles'
import { PublicFooter } from '~/components/app/public-footer'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { DEFAULT_LOCALE, MESSAGES, type Locale } from '~/i18n/messages'
import { withLang } from '~/lib/connect-link'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import type { Route } from './+types/about'

const EN_CANONICAL = `https://${APEX_HOST}/about`
const JA_CANONICAL = `https://${APEX_HOST}/ja/about`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

function canonicalForLocale(locale: Locale): string {
  return locale === 'ja' ? JA_CANONICAL : EN_CANONICAL
}

export function aboutMeta(locale: Locale) {
  const copy = MESSAGES[locale]
  const canonical = canonicalForLocale(locale)
  return [
    { title: copy['about.meta.title'] },
    { name: 'description', content: copy['about.meta.description'] },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: EN_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: JA_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: EN_CANONICAL,
    },
    ...socialMeta({
      title: copy['about.meta.title'],
      description: copy['about.meta.description'],
      url: canonical,
      image: OG_IMAGE_URL,
      imageAlt: copy['about.meta.title'],
    }),
  ]
}

export function meta({ loaderData }: Route.MetaArgs) {
  return aboutMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

const OFFICIAL_ROWS = [
  ['about.official.label.productName', 'about.official.productName'],
  ['about.official.label.domain', 'about.official.domain'],
  ['about.official.label.operator', 'about.official.operator'],
  ['about.official.label.audience', 'about.official.audience'],
  ['about.official.label.formats', 'about.official.formats'],
  ['about.official.label.sharing', 'about.official.sharing'],
  ['about.official.label.ai', 'about.official.ai'],
  ['about.official.label.plans', 'about.official.plans'],
] as const

export function AboutPage({
  locale,
  regression,
}: {
  locale: Locale
  regression?: {
    regions?: { header?: string; main?: string; footer?: string }
    primary?: string
  }
}) {
  const { t } = useT()

  return (
    <>
      <GuideTopbar data-regression-region={regression?.regions?.header}>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <div data-regression-region={regression?.regions?.main}>
        <GuideShell prose>
          <GuideMain>
            <GuideProse>
              <header>
                <h1>{t('about.hero.title')}</h1>
                <p>{t('about.meta.description')}</p>
                <p>{t('about.hero.intro')}</p>
                <div className="flex flex-wrap items-center gap-[var(--spacing-3)]">
                  <Button asChild variant="default">
                    <Link
                      to={withLang('/start', locale)}
                      data-regression-primary={regression?.primary}
                    >
                      {t('about.cta.primary')}
                    </Link>
                  </Button>
                  <Link to={withLang('/pricing', locale)}>
                    {t('about.cta.secondary')}
                  </Link>
                </div>
              </header>

              <section>
                <h2>{t('about.flow.title')}</h2>
                <p>{t('about.flow.intro')}</p>
                <ol className={guideStepsClassName}>
                  {(['publish', 'comment', 'update'] as const).map((step) => (
                    <li key={step} className="[&_h3]:mt-0">
                      <div>
                        <h3>{t(`about.flow.steps.${step}.title`)}</h3>
                        <p>{t(`about.flow.steps.${step}.body`)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h2>{t('about.audience.title')}</h2>
                <p>{t('about.audience.body')}</p>
              </section>
              <section>
                <h2>{t('about.ai.title')}</h2>
                <p>{t('about.ai.body')}</p>
                <Link to={withLang('/connect', locale)}>
                  {t('about.ai.cta')}
                </Link>
              </section>
              <section>
                <h2>{t('about.official.title')}</h2>
                <div className={guideOfficialInfoSurfaceClassName}>
                  <dl className={guideOfficialInfoGridClassName}>
                    {OFFICIAL_ROWS.map(([labelKey, valueKey]) => (
                      <Fragment key={labelKey}>
                        <dt className="text-muted-foreground text-xs font-medium">
                          {t(labelKey)}
                        </dt>
                        <dd className="m-0 text-sm">{t(valueKey)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <p className="text-muted-foreground text-sm">
                    {t('about.official.note')}
                  </p>
                </div>
              </section>
              <div className="mt-10">
                <p>{t('about.closing')}</p>
                <Button asChild variant="outline">
                  <Link to={withLang('/start', locale)}>
                    {t('about.cta.primary')}
                  </Link>
                </Button>
              </div>
            </GuideProse>
          </GuideMain>
        </GuideShell>
      </div>
      <PublicFooter data-regression-region={regression?.regions?.footer} />
    </>
  )
}

export function loader() {
  return { locale: DEFAULT_LOCALE }
}

export default function AboutRoute({ loaderData }: Route.ComponentProps) {
  return <AboutPage locale={loaderData.locale} />
}
