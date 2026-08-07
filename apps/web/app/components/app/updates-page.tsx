import { Link } from 'react-router'

import {
  GuideHomeLink,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import { PublicFooter } from '~/components/app/public-footer'
import {
  guideHeroClassName,
  guideLeadClassName,
  guideSubInlineLinksClassName,
} from '~/components/app/guide-styles'
import { Badge } from '~/components/ui/badge'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { withLang } from '~/lib/connect-link'
import { cn } from '~/lib/utils'
import type {
  UpdateDetail,
  UpdateListItem,
  UpdateKind,
  UpdateProduct,
} from '~/lib/updates-types'

const UPDATE_DATE_EN = new Intl.DateTimeFormat('en', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

const PRODUCT_FILTERS: ReadonlyArray<UpdateProduct | null> = [
  null,
  'web',
  'cli',
  'agent',
  'mcp',
  'admin',
]

const entrySurfaceClassName =
  'border-border scroll-mt-scroll-anchor border-t py-8 first:border-t-0 first:pt-0'

const entryTitleClassName =
  'text-foreground text-xl font-semibold tracking-tight no-underline hover:text-link'

const entryMetaClassName = 'text-muted-foreground text-sm'

const filterLinkClassName = cn(
  guideSubInlineLinksClassName,
  'mb-8',
  '[&_a[data-active=true]]:text-foreground [&_a[data-active=true]]:font-semibold [&_a[data-active=true]]:no-underline',
)

function parseUpdateDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!))
}

function UpdatesEntryHtml({ html }: { html: string }) {
  return (
    // react-doctor-disable-next-line react-doctor/dangerous-html-sink
    <GuideProse
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered from
      // checked-in markdown entries, no user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function formatUpdateDate(date: string, locale: Locale): string {
  const parsed = parseUpdateDate(date)
  if (locale === 'ja') {
    return `${parsed.getUTCFullYear()}年${parsed.getUTCMonth() + 1}月${parsed.getUTCDate()}日`
  }
  return UPDATE_DATE_EN.format(parsed)
}

function kindVariant(kind: UpdateKind): 'success' | 'muted' | 'warning' {
  if (kind === 'new') return 'success'
  if (kind === 'improve') return 'muted'
  return 'warning'
}

function productFilterKey(product: UpdateProduct | null): string {
  return product ?? 'all'
}

function productFilterHref(
  product: UpdateProduct | null,
  locale: Locale,
): string {
  const base = withLang('/updates', locale)
  return product ? `${base}?product=${product}` : base
}

function entryHref(slug: string, locale: Locale): string {
  return withLang(`/updates/${slug}`, locale)
}

function UpdatesBadges({
  entry,
  productLabel,
  kindLabel,
}: {
  entry: Pick<UpdateListItem, 'products' | 'kind'>
  productLabel: (product: UpdateProduct) => string
  kindLabel: (kind: UpdateKind) => string
}) {
  return (
    <Inline gap="2" wrap>
      {entry.products.map((product) => (
        <Badge key={product} variant="info">
          {productLabel(product)}
        </Badge>
      ))}
      <Badge variant={kindVariant(entry.kind)}>{kindLabel(entry.kind)}</Badge>
    </Inline>
  )
}

export function UpdatesListPage({
  locale,
  entries,
  product,
}: {
  locale: Locale
  entries: UpdateListItem[]
  product?: UpdateProduct
}) {
  const { t } = useT()

  const productLabel = (value: UpdateProduct) => t(`updates.product.${value}`)
  const kindLabel = (value: UpdateKind) => t(`updates.kind.${value}`)
  const filterLabel = (value: UpdateProduct | null) =>
    value ? productLabel(value) : t('updates.filterAll')

  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell prose>
        <header className={guideHeroClassName}>
          <h1>{t('updates.pageTitle')}</h1>
          <p className={guideLeadClassName}>{t('updates.lead')}</p>
        </header>

        <nav
          aria-label={t('updates.filterLabel')}
          className={filterLinkClassName}
        >
          <Inline gap="2" align="center" wrap>
            {PRODUCT_FILTERS.map((value, index) => (
              <Inline key={productFilterKey(value)} gap="2" align="center">
                {index > 0 && (
                  <span className="text-faint" aria-hidden="true">
                    ·
                  </span>
                )}
                <Link
                  to={productFilterHref(value, locale)}
                  data-active={value === (product ?? null) ? 'true' : undefined}
                  aria-current={
                    value === (product ?? null) ? 'page' : undefined
                  }
                >
                  {filterLabel(value)}
                </Link>
              </Inline>
            ))}
          </Inline>
        </nav>

        <Stack gap="0">
          {entries.map((entry) => (
            <article key={entry.slug} className={entrySurfaceClassName}>
              <Stack gap="3">
                <time className={entryMetaClassName} dateTime={entry.date}>
                  {formatUpdateDate(entry.date, locale)}
                </time>
                <h2 className="m-0 text-xl font-semibold tracking-tight">
                  <Link
                    to={entryHref(entry.slug, locale)}
                    className={entryTitleClassName}
                  >
                    {entry.title}
                  </Link>
                </h2>
                <UpdatesBadges
                  entry={entry}
                  productLabel={productLabel}
                  kindLabel={kindLabel}
                />
                <UpdatesEntryHtml html={entry.summaryHtml} />
                {entry.detailsHref ? (
                  <p className="m-0">
                    <Link
                      to={entry.detailsHref}
                      className="text-link hover:text-link-hover underline underline-offset-2"
                    >
                      {t('updates.details')}
                    </Link>
                  </p>
                ) : null}
                {entry.hasMore ? (
                  <p className="m-0">
                    <Link
                      to={entryHref(entry.slug, locale)}
                      className="text-link hover:text-link-hover underline underline-offset-2"
                    >
                      {t('updates.readMore')}
                    </Link>
                  </p>
                ) : null}
              </Stack>
            </article>
          ))}
        </Stack>
      </GuideShell>
      <PublicFooter />
    </>
  )
}

export function UpdatesDetailPage({
  locale,
  entry,
}: {
  locale: Locale
  entry: UpdateDetail
}) {
  const { t } = useT()

  const productLabel = (value: UpdateProduct) => t(`updates.product.${value}`)
  const kindLabel = (value: UpdateKind) => t(`updates.kind.${value}`)

  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell prose>
        <header className="mb-8">
          <time className={entryMetaClassName} dateTime={entry.date}>
            {formatUpdateDate(entry.date, locale)}
          </time>
          <h1 className="m-0 mt-3 text-3xl leading-tight font-bold tracking-tight">
            {entry.title}
          </h1>
          <div className="mt-4">
            <UpdatesBadges
              entry={entry}
              productLabel={productLabel}
              kindLabel={kindLabel}
            />
          </div>
        </header>

        <UpdatesEntryHtml html={entry.bodyHtml} />

        {entry.detailsHref ? (
          <p className="mt-8">
            <Link
              to={entry.detailsHref}
              className="text-link hover:text-link-hover underline underline-offset-2"
            >
              {t('updates.details')}
            </Link>
          </p>
        ) : null}

        <p className="mt-8">
          <Link
            to={withLang('/updates', locale)}
            className="text-link hover:text-link-hover underline underline-offset-2"
          >
            {t('updates.backToList')}
          </Link>
        </p>
      </GuideShell>
      <PublicFooter />
    </>
  )
}
