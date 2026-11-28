import { useEffect, useRef, useState } from 'react'
import {
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconFileText,
  IconX,
} from '@tabler/icons-react'
import { Link, useRouteLoaderData } from 'react-router'
import { BrandMark } from '~/components/app/brand-mark'
import { PublicFooter } from '~/components/app/public-footer'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { MCP_CONNECTOR_URL } from '~/lib/mcp-metadata'
import { cn } from '~/lib/utils'
import { AiBrandMark } from './landing-icons'

const SAMPLES = {
  mock: {
    ja: 'https://artifactshare.com/a/3kfkaseiki',
    en: 'https://artifactshare.com/a/eio7kdav1k',
  },
  kpi: {
    ja: 'https://artifactshare.com/a/z0pxvsducu',
    en: 'https://artifactshare.com/a/owcpuixuqq',
  },
  research: {
    ja: 'https://artifactshare.com/a/k2md9883g0',
    en: 'https://artifactshare.com/a/cro460ml2k',
  },
  minutes: {
    ja: 'https://artifactshare.com/a/k1llhb081t',
    en: 'https://artifactshare.com/a/95f5bg4q29',
  },
} as const

const CLAUDE_CONNECTOR_DEEPLINK = `https://claude.ai/new?modal=add-custom-connector&connectorName=Artifact+Share&connectorUrl=${encodeURIComponent(MCP_CONNECTOR_URL)}#settings/customize-connectors`
const CURSOR_INSTALL_DEEPLINK = `https://cursor.com/en/install-mcp?name=artifactshare&config=${btoa(JSON.stringify({ url: MCP_CONNECTOR_URL }))}`

const CONTAINER = 'mx-auto max-w-guide-shell-max px-5 md:px-8'
const H2 =
  'font-sans text-[length:var(--lp-text-h2)] leading-[var(--lh-landing-heading)] font-bold tracking-[var(--tracking-landing-heading)] text-foreground text-balance'
const LEAD =
  'mt-3 max-w-[var(--max-width-landing-lead)] text-[length:var(--lp-text-body)] text-muted-foreground text-pretty'
const BTN_BRAND =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-semibold whitespace-nowrap text-foreground transition-colors duration-150 hover:bg-muted active:scale-96'
const CODEBOX =
  'flex items-center gap-3 rounded-md border border-border bg-muted py-2.5 pr-3 pl-4 font-mono text-[length:var(--lp-text-caption)] text-muted-foreground'

const HERO_SOURCES = [
  { id: 'claude', label: 'Claude Code', brand: 'claude' as const, rev: 'v1' },
  { id: 'codex', label: 'Codex', brand: 'chatgpt' as const, rev: 'v2' },
  { id: 'cursor', label: 'Cursor', brand: 'cursor' as const, rev: 'v3' },
  { id: 'chatgpt', label: 'ChatGPT', brand: 'chatgpt' as const, rev: 'v4' },
] as const

function CopyButton({ value }: { value: string }) {
  const { t } = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )
  const settle = (outcome: 'copied' | 'failed') => {
    setState(outcome)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setState('idle'), 1500)
  }
  const copy = async () => {
    const write = navigator.clipboard?.writeText(value)
    if (!write) {
      settle('failed')
      return
    }
    try {
      await write
      settle('copied')
    } catch {
      settle('failed')
    }
  }
  return (
    <>
      <button
        type="button"
        className="border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground inline-flex flex-none cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1 font-sans text-xs font-semibold transition-[color,border-color,transform] duration-150 active:scale-96"
        onClick={() => void copy()}
      >
        {state === 'copied' ? (
          <IconCheck className="text-success size-3" aria-hidden="true" />
        ) : state === 'failed' ? (
          <IconX className="text-destructive size-3" aria-hidden="true" />
        ) : (
          <IconCopy className="size-3" aria-hidden="true" />
        )}
        {t('lp.hero.copy')}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === 'copied'
          ? t('lp.hero.copied')
          : state === 'failed'
            ? t('lp.connect.copyFailedButton')
            : ''}
      </span>
    </>
  )
}

function Codebox({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className={CODEBOX}>
      <span
        className={cn('flex-1 [overflow-wrap:anywhere]', !mono && 'font-sans')}
      >
        {value}
      </span>
      <CopyButton value={value} />
    </div>
  )
}

function ConnectorButtons() {
  const { t, locale } = useT()
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <a
        className={BTN_BRAND}
        href={CLAUDE_CONNECTOR_DEEPLINK}
        target="_blank"
        rel="noopener noreferrer"
      >
        <AiBrandMark
          brand="claude"
          className="fill-foreground size-3.5 flex-none"
          aria-hidden="true"
        />
        {t('lp.works.addClaude')}
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger className={BTN_BRAND}>
          <AiBrandMark
            brand="chatgpt"
            className="fill-foreground size-3.5 flex-none"
            aria-hidden="true"
          />
          {t('lp.works.addChatgpt')}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-75 p-4 text-[length:var(--lp-text-caption)] leading-[var(--lh-prose)]"
        >
          <b>{t('lp.works.chatgpt.title')}</b>
          <ol className="text-muted-foreground mt-1.5 ml-4 list-decimal">
            <li>{t('lp.works.chatgpt.s1')}</li>
            <li>{t('lp.works.chatgpt.s2')}</li>
            <li>
              {t('lp.works.chatgpt.s3pre')}
              <span className="font-mono text-[length:var(--lp-text-meta)]">
                artifactshare.com/mcp
              </span>
              {t('lp.works.chatgpt.s3post')}
            </li>
          </ol>
          <Link
            className="text-primary hover:text-primary-hover mt-2 inline-block text-xs font-semibold"
            to={withLang('/connect', locale, 'chatgpt')}
          >
            {t('lp.works.chatgpt.more')}
          </Link>
        </DropdownMenuContent>
      </DropdownMenu>
      <a
        className={BTN_BRAND}
        href={CURSOR_INSTALL_DEEPLINK}
        target="_blank"
        rel="noopener noreferrer"
      >
        <AiBrandMark
          brand="cursor"
          className="fill-foreground size-3.5 flex-none"
          aria-hidden="true"
        />
        {t('lp.works.addCursor')}
      </a>
    </div>
  )
}

function HeroStage() {
  const { t, locale } = useT()
  const [activeId, setActiveId] = useState<(typeof HERO_SOURCES)[number]['id']>(
    HERO_SOURCES[0].id,
  )
  const active =
    HERO_SOURCES.find((item) => item.id === activeId) ?? HERO_SOURCES[0]
  const shot =
    locale === 'ja'
      ? { src: '/landing/hero-share-ja.webp', width: 1493, height: 1260 }
      : { src: '/landing/hero-share-en.webp', width: 1600, height: 1163 }

  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border shadow-[var(--shadow-landing-screenshot)]">
      <div className="border-border bg-muted flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5">
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t('lp.hero.toolsNote')}
        >
          {HERO_SOURCES.map((source) => {
            const selected = source.id === active.id
            return (
              <button
                key={source.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setActiveId(source.id)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors duration-150',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                <AiBrandMark
                  brand={source.brand}
                  className={cn(
                    'size-3 flex-none',
                    selected ? 'fill-background' : 'fill-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                {source.label}
              </button>
            )
          })}
        </div>

        <div className="border-border bg-card flex items-center gap-2 rounded-md border px-3 py-1 font-mono text-xs">
          <span className="bg-primary-soft text-primary rounded-sm px-1.5 py-0.5 text-[length:var(--text-size-2xs)] font-bold tabular-nums">
            {active.rev}
          </span>
          <span className="text-foreground">artifactshare.com/a/9x2k…</span>
        </div>
      </div>

      <a
        href={locale === 'ja' ? SAMPLES.kpi.ja : SAMPLES.kpi.en}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <img
          src={shot.src}
          alt={t('lp.hero.shotAlt')}
          className="block w-full"
          width={shot.width}
          height={shot.height}
          fetchPriority="high"
        />
      </a>
    </div>
  )
}

function SlackFileChip({ name }: { name: string }) {
  return (
    <div className="border-border bg-muted text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs">
      <IconFileText className="size-3.5 flex-none" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </div>
  )
}

function ChatAvatar({
  initial,
  brand = false,
}: {
  initial: string
  brand?: boolean
}) {
  return (
    <span
      className={cn(
        'grid size-7 flex-none place-items-center rounded-md text-[length:var(--text-size-2xs)] font-bold text-white',
        brand
          ? 'from-coral-light to-coral bg-gradient-to-br'
          : 'bg-mock-avatar',
      )}
    >
      {initial}
    </span>
  )
}

function UseCaseCard({
  tag,
  title,
  body,
  stat,
  href,
  featured = false,
}: {
  tag: string
  title: string
  body: string
  stat: React.ReactNode
  href: string
  featured?: boolean
}) {
  const { t } = useT()
  return (
    <div
      className={cn(
        'border-border bg-card hover:border-border-strong group relative flex flex-col justify-between rounded-xl border p-6 transition-colors duration-150 md:p-7',
        featured && 'bg-background',
      )}
    >
      <div>
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="border-border bg-muted text-muted-foreground rounded-sm border px-2 py-0.5 font-mono text-[length:var(--text-size-2xs)] font-semibold">
            {tag}
          </span>
          <IconArrowUpRight
            className="text-faint group-hover:text-primary size-4 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            aria-hidden="true"
          />
        </div>
        <h3 className="text-foreground mb-2 text-[length:var(--lp-text-card-title)] font-bold">
          {title}
        </h3>
        <p className="text-muted-foreground text-[length:var(--lp-text-caption)] leading-[var(--lh-landing-body)]">
          {body}
        </p>
      </div>

      <div className="border-border mt-6 border-t pt-4">
        <div className="text-faint text-xs">{stat}</div>
        <a
          className="text-primary hover:text-primary-hover mt-2 inline-flex items-center gap-1 text-xs font-semibold after:absolute after:inset-0"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('lp.uc.openSample')}
        </a>
      </div>
    </div>
  )
}

function StepColumn({
  index,
  title,
  body,
  first = false,
}: {
  index: string
  title: string
  body: string
  first?: boolean
}) {
  return (
    <div
      className={cn(
        'py-6',
        first
          ? 'pr-0 lg:pr-8'
          : 'border-border border-t lg:border-t-0 lg:border-l lg:pl-8',
        !first && 'lg:pr-8 lg:last:pr-0',
      )}
    >
      <div className="text-primary mb-3 font-mono text-xs font-bold tabular-nums">
        {index}
      </div>
      <h3 className="text-foreground text-[length:var(--lp-text-body)] leading-[var(--lh-loose)] font-bold">
        {title}
      </h3>
      <p className="text-muted-foreground mt-2 text-[length:var(--lp-text-caption)] leading-[var(--lh-landing-body)] text-pretty">
        {body}
      </p>
    </div>
  )
}

type LandingRegression = {
  regions?: { main?: string; hero?: string; footer?: string }
  primary?: string
  instantHero?: boolean
}

function LandingHeader() {
  const { t, locale } = useT()
  const startTo = withLang('/start', locale)
  const shareWithAiTo = withLang('/share-with-ai', locale)
  const pricingTo = withLang('/pricing', locale)
  return (
    <header className="border-border bg-background/95 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="max-w-guide-shell-max mx-auto flex h-14 items-center gap-2 px-4 sm:gap-4 sm:px-5 md:gap-7 md:px-8">
        <Link
          to={withLang('/', locale)}
          className="flex items-center gap-2.5 text-base font-bold whitespace-nowrap no-underline"
        >
          <BrandMark size={24} aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Artifact Share</span>
        </Link>
        <nav className="text-muted-foreground hidden gap-6 text-sm whitespace-nowrap md:flex">
          <Link
            className="hover:text-foreground"
            to={withLang('/about', locale)}
          >
            {t('lp.nav.product')}
          </Link>
          <Link className="hover:text-foreground" to={pricingTo}>
            {t('lp.nav.pricing')}
          </Link>
          <Link className="hover:text-foreground" to={shareWithAiTo}>
            {t('lp.nav.useWithAi')}
          </Link>
          <Link
            className="hover:text-foreground"
            to={withLang('/updates', locale)}
          >
            {t('lp.nav.updates')}
          </Link>
        </nav>
        <div className="flex-1" />
        <Link
          className="text-muted-foreground hover:text-foreground text-xs whitespace-nowrap sm:text-sm"
          to={locale === 'ja' ? '/' : '/ja'}
          aria-label={locale === 'ja' ? 'Switch to English' : '日本語で表示'}
        >
          {locale === 'ja' ? 'English' : '日本語'}
        </Link>
        <Button
          asChild
          variant="outline"
          className="border-border-strong hover:bg-muted bg-transparent px-2.5 font-semibold sm:px-3.5"
        >
          <Link to="/sign-in">{t('lp.nav.login')}</Link>
        </Button>
        <Button asChild className="px-2.5 font-semibold sm:px-3.5">
          <Link to={startTo}>{t('lp.nav.start')}</Link>
        </Button>
      </div>
    </header>
  )
}

function HeroSection({ regression }: { regression?: LandingRegression }) {
  const { t, locale } = useT()
  const startTo = withLang('/start', locale)
  return (
    <section
      className="pt-14 pb-18 md:pt-20 md:pb-24"
      data-regression-region={regression?.regions?.hero}
    >
      <div className={CONTAINER}>
        <div className="max-w-3xl">
          <h1 className="text-foreground font-sans text-[length:var(--lp-text-h1)] leading-[var(--lh-landing-heading)] font-bold tracking-[var(--tracking-landing-heading)]">
            {t('lp.hero.titleDim')}
            <br />
            {t('lp.hero.titleMain')}
          </h1>
          <p className="text-muted-foreground mt-5 max-w-2xl text-[length:var(--lp-text-body)] leading-[var(--lh-landing-body)] text-pretty">
            {t('lp.hero.bodyLead')}
            <b className="text-foreground font-semibold">
              {t('lp.hero.bodyQuote')}
            </b>
            {t('lp.hero.bodyTail')}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button asChild className="h-11 px-6 font-semibold">
              <Link to={startTo} data-regression-primary={regression?.primary}>
                {t('lp.hero.ctaPrimary')}
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-border-strong hover:bg-muted h-11 bg-transparent px-5 font-semibold"
            >
              <a href="#examples">{t('lp.hero.ctaSecondary')}</a>
            </Button>
            <span className="text-faint text-xs sm:ml-2">
              {t('lp.hero.noCard')}
            </span>
          </div>
        </div>

        <div className="mt-12">
          <HeroStage />
        </div>
      </div>
    </section>
  )
}

function BeforeAfterSection() {
  const { t } = useT()
  return (
    <section className="border-border bg-muted border-y py-18 md:py-22">
      <div className={CONTAINER}>
        <h2 className={H2}>
          {t('lp.ba.title1')} <br className="hidden md:inline" />
          {t('lp.ba.title2')}
        </h2>
        <p className={LEAD}>{t('lp.ba.body')}</p>
        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="border-border bg-card rounded-xl border p-6">
            <div className="text-faint mb-5 text-xs font-semibold">
              {t('lp.ba.beforeLabel')}
            </div>
            <div
              className="flex flex-col gap-4 text-[length:var(--lp-text-caption)]"
              aria-hidden="true"
            >
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialA')} />
                <div className="min-w-0">
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameA')}</b>{' '}
                    <span className="text-faint">{t('lp.ba.timeA1')}</span>
                  </div>
                  <SlackFileChip name="comparison_final_v2.html" />
                </div>
              </div>
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialA')} />
                <div className="min-w-0">
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameA')}</b>{' '}
                    <span className="text-faint">{t('lp.ba.timeA2')}</span>
                  </div>
                  <SlackFileChip name="comparison_final_v2_fixed.html" />
                </div>
              </div>
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialB')} />
                <div>
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameB')}</b>{' '}
                    <span className="text-faint">{t('lp.ba.timeB')}</span>
                  </div>
                  <div className="text-foreground font-semibold">
                    {t('lp.ba.q')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="border-primary/30 bg-card rounded-xl border p-6">
            <div className="text-primary mb-5 text-xs font-semibold">
              {t('lp.ba.afterLabel')}
            </div>
            <div
              className="flex flex-col gap-4 text-[length:var(--lp-text-caption)]"
              aria-hidden="true"
            >
              <div className="flex gap-2.5">
                <ChatAvatar initial="as" brand />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameA')}</b>{' '}
                    <span className="text-faint">{t('lp.ba.timeA1')}</span>
                  </div>
                  <div className="border-border bg-muted rounded-md border p-3">
                    <div className="mb-0.5 text-[length:var(--lp-text-caption)] font-bold">
                      {t('lp.ba.reportTitle')}
                    </div>
                    <div className="text-primary font-mono text-xs">
                      artifactshare.com/a/9x2k…
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialB')} />
                <div>
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameB')}</b>{' '}
                    <span className="text-faint">{t('lp.ba.timeB2')}</span>
                  </div>
                  <div className="text-muted-foreground">
                    {t('lp.ba.comment')}
                  </div>
                </div>
              </div>
              <div className="bg-primary-soft text-primary mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold">
                <IconCheck className="size-3.5" aria-hidden="true" />
                {t('lp.ba.fixed')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function LoopSection() {
  const { t } = useT()
  return (
    <section className="py-18 md:py-22">
      <div className={CONTAINER}>
        <h2 className={H2}>{t('lp.loop.title')}</h2>
        <p className={LEAD}>{t('lp.loop.body')}</p>
        <div className="border-border mt-10 grid grid-cols-1 border-t lg:grid-cols-4">
          <StepColumn
            first
            index="1"
            title={t('lp.loop.s1.title')}
            body={t('lp.loop.s1.body')}
          />
          <StepColumn
            index="2"
            title={t('lp.loop.s2.title')}
            body={t('lp.loop.s2.body')}
          />
          <StepColumn
            index="3"
            title={t('lp.loop.s3.title')}
            body={t('lp.loop.s3.body')}
          />
          <StepColumn
            index="4"
            title={t('lp.loop.s4.title')}
            body={t('lp.loop.s4.body')}
          />
        </div>
      </div>
    </section>
  )
}

function UseCasesSection() {
  const { t, locale } = useT()
  const sample = (id: keyof typeof SAMPLES) =>
    locale === 'ja' ? SAMPLES[id].ja : SAMPLES[id].en
  return (
    <section
      id="examples"
      className="border-border bg-muted border-y py-18 md:py-22"
    >
      <div className={CONTAINER}>
        <h2 className={H2}>{t('lp.uc.title')}</h2>
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2">
          <UseCaseCard
            featured
            tag="UI MOCK"
            title={t('lp.uc.mock.title')}
            body={t('lp.uc.mock.body')}
            stat={
              <>
                {t('lp.uc.mock.statPre')}
                <b className="text-foreground font-semibold tabular-nums">
                  {t('lp.uc.mock.statBold')}
                </b>
                {t('lp.uc.mock.statPost')}
              </>
            }
            href={sample('mock')}
          />
          <UseCaseCard
            featured
            tag="PR GUIDE"
            title={t('lp.uc.minutes.title')}
            body={t('lp.uc.minutes.body')}
            stat={t('lp.uc.minutes.note')}
            href={sample('minutes')}
          />
          <UseCaseCard
            tag="KPI / PLAN"
            title={t('lp.uc.kpi.title')}
            body={t('lp.uc.kpi.body')}
            stat={
              <>
                {t('lp.uc.kpi.statPre')}
                <b className="text-foreground font-semibold tabular-nums">
                  {t('lp.uc.kpi.statBold')}
                </b>
                {t('lp.uc.kpi.statPost')}
              </>
            }
            href={sample('kpi')}
          />
          <UseCaseCard
            tag="REPORT"
            title={t('lp.uc.research.title')}
            body={t('lp.uc.research.body')}
            stat={
              <>
                {t('lp.uc.research.statPre')}
                <b className="text-foreground font-semibold tabular-nums">
                  {t('lp.uc.research.statBold')}
                </b>
                {t('lp.uc.research.statPost')}
              </>
            }
            href={sample('research')}
          />
        </div>
      </div>
    </section>
  )
}

function WorksAndTrustSection() {
  const { t } = useT()
  return (
    <section className="py-18 md:py-22">
      <div className={CONTAINER}>
        <h2 className={H2}>
          {t('lp.works.title1')} <br className="hidden md:inline" />
          {t('lp.works.title2')}
        </h2>
        <div className="border-border mt-10 grid grid-cols-1 border-t md:grid-cols-2">
          <div className="flex flex-col py-7 pr-0 md:pr-10">
            <h3 className="text-foreground mb-2 text-[length:var(--lp-text-card-title)] font-bold">
              {t('lp.works.cli.title')}
            </h3>
            <p className="text-muted-foreground flex-1 text-sm text-pretty">
              {t('lp.works.cli.body')}
            </p>
            <div className="mt-4">
              <Codebox value={t('lp.hero.cliPrompt')} mono={false} />
            </div>
          </div>
          <div className="border-border flex flex-col border-t py-7 md:border-t-0 md:border-l md:pl-10">
            <h3 className="text-foreground mb-2 text-[length:var(--lp-text-card-title)] font-bold">
              {t('lp.works.mcp.title')}
            </h3>
            <p className="text-muted-foreground flex-1 text-sm text-pretty">
              {t('lp.works.mcp.body')}
            </p>
            <div className="mt-4">
              <Codebox value={MCP_CONNECTOR_URL} />
            </div>
            <ConnectorButtons />
          </div>
        </div>

        <div className="border-border mt-16 grid grid-cols-1 gap-10 border-t pt-14 lg:grid-cols-[340px_1fr] lg:gap-16">
          <div>
            <h2 className={H2}>
              {t('lp.trust.title1')} <br className="hidden lg:inline" />
              {t('lp.trust.title2')}
            </h2>
          </div>
          <dl className="divide-border divide-y">
            {(
              [
                [t('lp.trust.c1.title'), t('lp.trust.c1.body')],
                [t('lp.trust.c2.title'), t('lp.trust.c2.body')],
                [t('lp.trust.c3.title'), t('lp.trust.c3.body')],
              ] as const
            ).map(([title, body]) => (
              <div
                key={title}
                className="grid grid-cols-1 gap-2 py-5 first:pt-0 last:pb-0 sm:grid-cols-[200px_1fr] sm:gap-6"
              >
                <dt className="text-foreground text-[length:var(--lp-text-body)] font-bold">
                  {title}
                </dt>
                <dd className="text-muted-foreground m-0 text-[length:var(--lp-text-caption)] leading-[var(--lh-landing-body)]">
                  {body}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  )
}

function ClosingCtaSection() {
  const { t, locale } = useT()
  const startTo = withLang('/start', locale)
  const pricingTo = withLang('/pricing', locale)
  return (
    <section className="py-12 md:py-16">
      <div className={CONTAINER}>
        <div className="bg-foreground text-background rounded-2xl px-6 py-16 text-center md:px-12 md:py-20">
          <h2 className="mx-auto max-w-[var(--max-width-landing-cta-heading)] font-sans text-[length:var(--lp-text-h2)] leading-[var(--lh-landing-heading)] font-bold tracking-[var(--tracking-landing-heading)] text-balance">
            {t('lp.ctaEnd.title1')} <br className="hidden md:inline" />
            {t('lp.ctaEnd.title2')}
          </h2>
          <p className="text-background/75 mx-auto mt-4 max-w-[var(--max-width-landing-lead)] text-[length:var(--lp-text-body)] text-pretty">
            {t('lp.ctaEnd.body')}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button
              asChild
              className="bg-background text-foreground hover:bg-background/90 h-11 px-6 font-semibold"
            >
              <Link to={startTo}>{t('lp.hero.ctaPrimary')}</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-background/30 text-background hover:bg-background/10 h-11 bg-transparent px-5 font-semibold"
            >
              <Link to={pricingTo}>{t('lp.ctaEnd.pricing')}</Link>
            </Button>
          </div>
          <p className="text-background/65 mt-5 text-[length:var(--lp-text-caption)] tabular-nums">
            {t('lp.ctaEnd.free')}
          </p>
        </div>
      </div>
    </section>
  )
}

export function LandingPage({
  regression,
}: {
  regression?: LandingRegression
}) {
  const { t } = useT()
  const rootData = useRouteLoaderData('root') as
    | { maintenance?: boolean }
    | undefined
  const maintenance = rootData?.maintenance === true

  return (
    <div className="bg-background text-foreground font-landing-body font-sans text-[length:var(--lp-text-body)] leading-[var(--lh-landing-body)] [word-break:auto-phrase]">
      <LandingHeader />
      {maintenance ? (
        <p className="border-border bg-warning-soft text-foreground m-0 border-b px-5 py-2 text-center text-[length:var(--lp-text-caption)]">
          {t('lp.maintenanceAuth')}
        </p>
      ) : null}

      <main data-regression-region={regression?.regions?.main}>
        <HeroSection regression={regression} />

        <BeforeAfterSection />

        <LoopSection />

        <UseCasesSection />

        <WorksAndTrustSection />

        <ClosingCtaSection />
      </main>

      <PublicFooter
        variant="full"
        data-regression-region={regression?.regions?.footer}
      />
    </div>
  )
}
