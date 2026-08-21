import { useEffect, useRef, useState } from 'react'
import {
  IconArrowRight,
  IconCheck,
  IconCopy,
  IconFileText,
  IconSend,
  IconShield,
  IconUsers,
} from '@tabler/icons-react'
import { Link, useRouteLoaderData, useSearchParams } from 'react-router'
import { BrandMark } from '~/components/app/brand-mark'
import { PublicFooter } from '~/components/app/public-footer'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { SegmentedControlGroup } from '~/components/ui/segmented-control'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { MCP_CONNECTOR_URL } from '~/lib/mcp-metadata'
import { cn } from '~/lib/utils'
import { AiBrandMark } from './landing-icons'

/* Live sample artifacts referenced from the use-case cards and the hero
 * screenshot. Link-shared with no expiry; owned by the product team. */
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

const CLAUDE_CONNECTOR_DEEPLINK =
  'https://claude.ai/new?modal=add-custom-connector&connectorName=Artifact+Share&connectorUrl=https%3A%2F%2Fartifactshare.com%2Fmcp#settings/customize-connectors'
const CURSOR_INSTALL_DEEPLINK =
  'https://cursor.com/en/install-mcp?name=artifactshare&config=eyJ1cmwiOiAiaHR0cHM6Ly9hcnRpZmFjdHNoYXJlLmNvbS9tY3AifQ=='

const RV = 'opacity-0 motion-reduce:opacity-100'
const RV_DELAY = {
  1: 'motion-safe:animate-lp-reveal-1',
  2: 'motion-safe:animate-lp-reveal-2',
  3: 'motion-safe:animate-lp-reveal-3',
  4: 'motion-safe:animate-lp-reveal-4',
  5: 'motion-safe:animate-lp-reveal-5',
} as const

const CONTAINER = 'mx-auto max-w-guide-shell-max px-5 md:px-8'
const KICKER =
  'mb-4 text-xs font-semibold tracking-[var(--tracking-landing-kicker)] text-hint'
const H2 =
  'font-serif text-[length:var(--lp-text-h2)] leading-[var(--lh-landing-heading)] font-bold tracking-[var(--tracking-landing-heading)] text-balance'
const LEAD =
  'mt-4 max-w-[var(--max-width-landing-lead)] text-[length:var(--lp-text-body)] text-faint text-pretty'
const BTN_BRAND =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold whitespace-nowrap text-white shadow-[var(--shadow-landing-brand-button)] transition-[background-color,transform] duration-150 active:scale-96'
const CODEBOX =
  'flex items-center gap-3 rounded-md border border-border bg-muted py-2.5 pr-3 pl-4 font-mono text-[length:var(--lp-text-caption)] text-muted-foreground'
const CARD = 'rounded-lg bg-card p-6 shadow-[var(--shadow-lg)]'
const MINI =
  'relative h-full rounded-t-[var(--r-sm)] bg-card px-3.5 py-3 shadow-[var(--shadow-landing-mini)]'
const PIN =
  'absolute grid size-4 place-items-center rounded-[var(--lp-pin-radius)] bg-coral/60 text-[length:var(--lp-text-mini)] font-bold text-white'

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/* Streams the hero prompt like an agent typing; the ▍ cursor disappears on
 * completion. Renders the full text when reduced motion is requested or
 * before hydration, so SSR output and no-JS reads stay complete. */
function Typewriter({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      i += 1
      el.textContent = text.slice(0, i) + (i < text.length ? '▍' : '')
      if (i < text.length) timer = setTimeout(tick, 38)
    }
    el.textContent = ''
    timer = setTimeout(tick, 500)
    return () => {
      clearTimeout(timer)
      el.textContent = text
    }
  }, [text])
  return <span ref={ref}>{text}</span>
}

function CopyButton({ value }: { value: string }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )
  return (
    <button
      type="button"
      className="border-border bg-card text-faint hover:border-border-strong hover:text-foreground inline-flex flex-none cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1 font-sans text-xs font-semibold transition-[color,border-color,transform] duration-150 active:scale-96"
      onClick={() => {
        // Confirm only after the write resolves — a rejected or unavailable
        // clipboard must not announce success.
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => setCopied(false), 1500)
          },
          () => {},
        )
      }}
    >
      {/* Only the icon changes on copy, so the button width — and the
          codebox line wrapping around it — never shifts. The confirmation
          text is announced to screen readers instead. */}
      {copied ? (
        <IconCheck className="text-success size-3" aria-hidden="true" />
      ) : (
        <IconCopy className="size-3" aria-hidden="true" />
      )}
      {t('lp.hero.copy')}
      <span aria-live="polite" className="sr-only">
        {copied ? t('lp.hero.copied') : ''}
      </span>
    </button>
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

/* The three connector buttons (Claude / Cursor / ChatGPT). ChatGPT has no
 * one-click deeplink, so it opens a short instruction dropdown instead. */
function ConnectorButtons() {
  const { t, locale } = useT()
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      <a
        className={cn(BTN_BRAND, 'bg-brand-claude hover:bg-brand-claude-hover')}
        href={CLAUDE_CONNECTOR_DEEPLINK}
        target="_blank"
        rel="noopener noreferrer"
      >
        <AiBrandMark
          brand="claude"
          className="size-3.5 flex-none fill-white"
          aria-hidden="true"
        />
        {t('lp.works.addClaude')}
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            BTN_BRAND,
            'bg-brand-chatgpt hover:bg-brand-chatgpt-hover',
          )}
        >
          <AiBrandMark
            brand="chatgpt"
            className="size-3.5 flex-none fill-white"
            aria-hidden="true"
          />
          {t('lp.works.addChatgpt')}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-75 p-4 text-[length:var(--lp-text-caption)] leading-[var(--lh-prose)]"
        >
          <b>{t('lp.works.chatgpt.title')}</b>
          <ol className="text-faint mt-1.5 ml-4 list-decimal">
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
        className={cn(BTN_BRAND, 'bg-brand-cursor hover:bg-brand-cursor-hover')}
        href={CURSOR_INSTALL_DEEPLINK}
        target="_blank"
        rel="noopener noreferrer"
      >
        <AiBrandMark
          brand="cursor"
          className="size-3.5 flex-none fill-white"
          aria-hidden="true"
        />
        {t('lp.works.addCursor')}
      </a>
    </div>
  )
}

function HeroTabs() {
  const { t } = useT()
  const [tab, setTab] = useState('mcp')
  return (
    <Tabs value={tab} onValueChange={setTab} className="mt-6 w-full">
      <div className="flex items-center gap-3">
        <SegmentedControlGroup className="contents">
          <TabsList className="border-border border font-semibold">
            <TabsTrigger value="mcp" className="px-3 text-xs font-semibold">
              MCP
            </TabsTrigger>
            <TabsTrigger value="cli" className="px-3 text-xs font-semibold">
              CLI
            </TabsTrigger>
          </TabsList>
        </SegmentedControlGroup>
        <div className="text-hint text-xs">
          {tab === 'cli' ? t('lp.hero.tabCliHint') : t('lp.hero.tabMcpHint')}
        </div>
      </div>
      <TabsContent value="mcp">
        <Codebox value={MCP_CONNECTOR_URL} />
        <ConnectorButtons />
      </TabsContent>
      <TabsContent value="cli">
        <Codebox value={t('lp.hero.cliPrompt')} mono={false} />
        {/* Spacer keeps the hero height stable across tab switches — the
            MCP panel adds a row of connector buttons below its codebox. */}
        <div className="mt-2.5 h-8" aria-hidden="true" />
      </TabsContent>
    </Tabs>
  )
}

function HeroVisual({ instant = false }: { instant?: boolean }) {
  const { t, locale } = useT()
  const rv = (stage: keyof typeof RV_DELAY) =>
    instant ? undefined : cn(RV, RV_DELAY[stage])
  const shot =
    locale === 'ja'
      ? { src: '/landing/hero-share-ja.webp', width: 1493, height: 1260 }
      : { src: '/landing/hero-share-en.webp', width: 1600, height: 1163 }
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className={cn(
          rv(1),
          'bg-card mb-4 rounded-lg p-4 text-[length:var(--lp-text-caption)] leading-[var(--lh-prose)] shadow-[var(--shadow-lg)]',
        )}
      >
        <div className="text-hint mb-1.5 flex items-center gap-2 text-[length:var(--lp-text-meta)] font-semibold">
          <AiBrandMark
            brand="claude"
            className="fill-brand-claude size-3.5 flex-none"
            aria-hidden="true"
          />
          Claude Code
        </div>
        <div className="text-foreground font-semibold">
          {instant ? (
            t('lp.hero.prompt')
          ) : (
            <Typewriter text={t('lp.hero.prompt')} />
          )}
        </div>
        <div
          className={cn(
            rv(2),
            'text-faint mt-2 flex items-center gap-2 text-xs',
          )}
        >
          <span className="bg-primary-soft grid size-4 flex-none place-items-center rounded-full">
            <IconCheck
              className="stroke-primary size-2.5 stroke-2"
              aria-hidden="true"
            />
          </span>
          {t('lp.hero.shared')}{' '}
          <span className="text-primary font-mono text-[length:var(--lp-text-meta)]">
            artifactshare.com/a/9x2k…
          </span>
        </div>
      </div>
      {/* The screenshot is the LCP element — never animate its opacity
          (Chrome excludes opacity-0 elements from LCP, which would push
          LCP past the reveal delay). Only the chat overlays stage in. */}
      <a
        href={locale === 'ja' ? SAMPLES.kpi.ja : SAMPLES.kpi.en}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-lg shadow-[var(--shadow-landing-screenshot)]"
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
      <div
        aria-hidden="true"
        className={cn(
          rv(4),
          'bg-card absolute right-1 -bottom-16 w-[var(--lp-overlay-width)] overflow-hidden rounded-lg text-[length:var(--lp-text-caption)] leading-[var(--lh-prose)] shadow-[var(--shadow-lg)] lg:-right-4 lg:-bottom-24',
        )}
      >
        <div className="px-4 pt-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="bg-mock-avatar grid size-5 flex-none place-items-center rounded-full text-[length:var(--lp-text-mini)] font-bold text-white">
              YT
            </span>
            <span className="text-xs font-bold">Yuki</span>
            <span className="flex-1" />
            <span className="text-hint text-[length:var(--lp-text-meta)]">
              {t('lp.hero.commentTimeQ')}
            </span>
          </div>
          {t('lp.hero.commentQ')}
        </div>
        <div className={cn(rv(5), 'py-3 pr-4 pl-8')}>
          <div className="mb-1 flex items-center gap-2">
            <span className="from-coral-light to-coral grid size-5 flex-none place-items-center rounded-full bg-gradient-to-br text-[length:var(--lp-text-mini)] font-bold text-white">
              as
            </span>
            <span className="text-xs font-bold">coji</span>
            <span className="bg-muted text-faint rounded-sm px-1.5 text-[length:var(--text-size-2xs)] font-semibold">
              Claude
            </span>
            <span className="flex-1" />
            <span className="text-hint text-[length:var(--lp-text-meta)]">
              {t('lp.hero.commentTimeA')}
            </span>
          </div>
          <div className="border-border border-l-2 pl-2.5">
            {t('lp.hero.commentA')}
          </div>
        </div>
      </div>
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
  label,
  title,
  body,
  stat,
  href,
  children,
}: {
  label: string
  title: string
  body: string
  stat: React.ReactNode
  href: string
  children: React.ReactNode
}) {
  const { t } = useT()
  return (
    <div className="bg-card relative flex flex-col overflow-hidden rounded-lg shadow-[var(--shadow-lg)] transition-transform duration-200 ease-[var(--ease-out)] hover:-translate-y-1">
      <div className="border-divider bg-muted relative h-37.5 overflow-hidden border-b px-6 pt-4">
        <div className={MINI} aria-hidden="true">
          {children}
        </div>
      </div>
      <div className="px-6 pt-5 pb-6">
        <div className="text-hint mb-2 text-[length:var(--lp-text-meta)] font-semibold tracking-[var(--tracking-landing-kicker)]">
          {label}
        </div>
        <h3 className="mb-1.5 text-[length:var(--lp-text-card-title)] font-bold">
          {title}
        </h3>
        <p className="text-faint text-[length:var(--lp-text-caption)]">
          {body}
        </p>
        <div className="text-hint mt-3 text-xs">{stat}</div>
        <a
          className="text-primary hover:text-primary-hover mt-3 inline-flex items-center gap-1 text-xs font-semibold after:absolute after:inset-0"
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
        'py-7',
        first
          ? 'pr-0 lg:pr-8'
          : 'border-border border-t lg:border-t-0 lg:border-l lg:pl-8',
        !first && 'lg:pr-8 lg:last:pr-0',
      )}
    >
      <div className="text-foreground/30 flex h-11 items-start font-serif text-[length:var(--lp-text-step-number)] leading-none font-bold">
        {index}
      </div>
      <h3 className="min-h-0 text-[length:var(--lp-text-body)] leading-[var(--lh-loose)] font-bold lg:min-h-12">
        {title}
      </h3>
      <p className="text-faint mt-2 text-[length:var(--lp-text-caption)] leading-[var(--lh-landing-body)] text-pretty">
        {body}
      </p>
    </div>
  )
}

type LandingRegression = {
  regions?: { main?: string; hero?: string; footer?: string }
  primary?: string
  /* Renders the hero visual fully revealed and untyped so scenario
   * screenshots are deterministic instead of racing the staged reveal. */
  instantHero?: boolean
}

function LandingHeader() {
  const { t, locale } = useT()
  // Protected routes redirect signed-out visitors to /?next=… — carry that
  // destination through to sign-in so it is not lost on this page.
  const [params] = useSearchParams()
  const next = params.get('next')
  const signInTo = next
    ? `/sign-in?next=${encodeURIComponent(next)}`
    : '/sign-in'
  const startTo = withLang('/start', locale)
  const shareWithAiTo = withLang('/share-with-ai', locale)
  const pricingTo = withLang('/pricing', locale)
  return (
    <header className="border-border bg-surface-warm/90 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="max-w-guide-shell-max mx-auto flex h-15 items-center gap-4 px-5 md:gap-7 md:px-8">
        <Link
          to={withLang('/', locale)}
          className="flex items-center gap-2.5 text-base font-bold whitespace-nowrap no-underline"
        >
          <BrandMark size={24} aria-hidden="true" />
          Artifact Share
        </Link>
        <nav className="text-faint hidden gap-6 text-sm whitespace-nowrap md:flex">
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
        {/* The other language's endonym, in the first view — a Japanese
            visitor landing on the EN top page can switch immediately. */}
        <Link
          className="text-faint hover:text-foreground text-sm whitespace-nowrap"
          to={locale === 'ja' ? '/' : '/ja'}
          aria-label={locale === 'ja' ? 'Switch to English' : '日本語で表示'}
        >
          {locale === 'ja' ? 'English' : '日本語'}
        </Link>
        <Button
          asChild
          variant="outline"
          className="border-border-strong hover:bg-foreground/5 hidden bg-transparent px-3.5 font-semibold sm:inline-flex"
        >
          <Link to={signInTo}>{t('lp.nav.login')}</Link>
        </Button>
        <Button asChild className="px-3.5 font-semibold">
          <Link to={startTo}>{t('lp.nav.start')}</Link>
        </Button>
      </div>
    </header>
  )
}

function HeroSection({ regression }: { regression?: LandingRegression }) {
  const { t, locale } = useT()
  const startTo = withLang('/start', locale)
  const shareWithAiTo = withLang('/share-with-ai', locale)
  return (
    <section
      className="py-24 pb-29"
      data-regression-region={regression?.regions?.hero}
    >
      <div className="max-w-guide-shell-max mx-auto grid grid-cols-1 items-center gap-14 px-5 md:px-8 lg:grid-cols-[430px_1fr] lg:gap-18">
        <div className="flex w-full flex-col">
          <div className="border-border-strong bg-card/60 text-faint inline-flex h-7 w-fit max-w-full items-center gap-2 overflow-hidden rounded-full border px-3 text-[length:var(--text-size-2xs)] font-medium tracking-widest whitespace-nowrap sm:px-3.5 sm:text-[length:var(--lp-text-meta)] sm:tracking-[var(--tracking-landing-kicker)]">
            <span className="bg-coral size-1.5 rounded-full" />
            SHARE · COMMENT · UPDATE — SAME URL
          </div>
          <h1 className="mt-5 font-serif text-[length:var(--lp-text-h1)] leading-[var(--lh-landing-heading)] font-bold tracking-[var(--tracking-landing-heading)] text-balance">
            <span className="text-foreground/55">
              {t('lp.hero.titleDim')}
            </span>{' '}
            <br className="hidden md:inline" />
            {t('lp.hero.titleMain')}
          </h1>
          <p className="text-faint mt-5 text-[length:var(--lp-text-body)] leading-[var(--lh-landing-body)] text-pretty">
            {t('lp.hero.bodyLead')}
            <b className="text-foreground">{t('lp.hero.bodyQuote')}</b>
            {t('lp.hero.bodyTail')}
          </p>
          <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
            <Button asChild className="h-12 px-5 font-semibold">
              <Link to={startTo} data-regression-primary={regression?.primary}>
                {t('lp.hero.ctaPrimary')}
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-border-strong hover:bg-foreground/5 h-12 bg-transparent px-5 font-semibold"
            >
              <Link to={shareWithAiTo}>{t('lp.hero.ctaSecondary')}</Link>
            </Button>
          </div>
          <HeroTabs />
          <p className="text-hint mt-3 text-xs">{t('lp.hero.noCard')}</p>
        </div>
        <HeroVisual instant={regression?.instantHero ?? false} />
      </div>
    </section>
  )
}

function BeforeAfterSection() {
  const { t } = useT()
  return (
    <section className="border-border bg-muted border-y py-26">
      <div className={CONTAINER}>
        <p className={KICKER}>BEFORE / AFTER</p>
        <h2 className={H2}>
          {t('lp.ba.title1')} <br className="hidden md:inline" />
          {t('lp.ba.title2')}
        </h2>
        <p className={LEAD}>{t('lp.ba.body')}</p>
        <div className="relative mt-12 grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-16">
          <span className="border-border bg-card text-hint absolute top-1/2 left-1/2 hidden size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border shadow-[var(--shadow-md)] md:grid">
            <IconArrowRight className="size-4" aria-hidden="true" />
          </span>

          <div className={CARD}>
            <div className="text-hint mb-5 text-xs font-semibold tracking-[var(--tracking-landing-kicker)] uppercase">
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
                    <span className="text-hint">{t('lp.ba.timeA1')}</span>
                  </div>
                  <SlackFileChip name="comparison_final_v2.html" />
                </div>
              </div>
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialA')} />
                <div className="min-w-0">
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameA')}</b>{' '}
                    <span className="text-hint">{t('lp.ba.timeA2')}</span>
                  </div>
                  <SlackFileChip name="comparison_final_v2_fixed.html" />
                </div>
              </div>
              <div className="flex gap-2.5">
                <ChatAvatar initial={t('lp.ba.initialB')} />
                <div>
                  <div className="mb-1 text-xs">
                    <b>{t('lp.ba.nameB')}</b>{' '}
                    <span className="text-hint">{t('lp.ba.timeB')}</span>
                  </div>
                  <div className="text-foreground font-semibold">
                    {t('lp.ba.q')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={CARD}>
            <div className="text-coral-text mb-5 text-xs font-semibold tracking-[var(--tracking-landing-kicker)] uppercase">
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
                    <span className="text-hint">{t('lp.ba.timeA1')}</span>
                  </div>
                  <div className="border-border bg-surface-warm rounded-md border p-3">
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
                    <span className="text-hint">{t('lp.ba.timeB2')}</span>
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
    <section className="py-26">
      <div className={CONTAINER}>
        <p className={KICKER}>HOW IT WORKS</p>
        <h2 className={H2}>{t('lp.loop.title')}</h2>
        <p className={LEAD}>{t('lp.loop.body')}</p>
        <div className="border-foreground mt-12 grid grid-cols-1 border-t lg:grid-cols-4">
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
    <section className="border-border bg-muted border-y py-26">
      <div className={CONTAINER}>
        <p className={KICKER}>USE CASES</p>
        <h2 className={H2}>{t('lp.uc.title')}</h2>
        <div className="mt-12 grid grid-cols-1 gap-7 md:grid-cols-2">
          <UseCaseCard
            label="UI MOCK"
            title={t('lp.uc.mock.title')}
            body={t('lp.uc.mock.body')}
            stat={
              <>
                {t('lp.uc.mock.statPre')}
                <b className="text-muted-foreground font-semibold tabular-nums">
                  {t('lp.uc.mock.statBold')}
                </b>
                {t('lp.uc.mock.statPost')}
              </>
            }
            href={sample('mock')}
          >
            <div className="mb-2.5 flex gap-1.5">
              <span className="bg-mock-dot size-1.75 rounded-full" />
              <span className="bg-mock-dot size-1.75 rounded-full" />
              <span className="bg-mock-dot size-1.75 rounded-full" />
            </div>
            <div className="text-muted-foreground mb-1.5 text-[length:var(--text-size-2xs)] font-semibold">
              {t('lp.uc.mock.mini.title')}
            </div>
            <div className="border-border bg-surface-warm text-muted-foreground mb-1.5 flex h-6 items-center rounded-[var(--r-sm)] border px-2 font-mono text-[length:var(--lp-text-mini)]">
              yuki@example.com
            </div>
            <div className="border-border bg-surface-warm text-hint mb-2 flex h-6 items-center rounded-[var(--r-sm)] border px-2 text-[length:var(--lp-text-mini)]">
              {t('lp.uc.mock.mini.perm')}
            </div>
            <div className="flex gap-2">
              <span className="bg-mock-button grid h-6 w-18 place-items-center rounded-[var(--r-sm)] text-[length:var(--lp-text-mini)] font-semibold text-white">
                {t('lp.uc.mock.mini.invite')}
              </span>
              <span className="border-border text-hint grid h-6 w-18 place-items-center rounded-[var(--r-sm)] border text-[length:var(--lp-text-mini)]">
                {t('lp.uc.mock.mini.cancel')}
              </span>
            </div>
            <span className={cn(PIN, 'top-13 right-5')}>3</span>
          </UseCaseCard>

          <UseCaseCard
            label="KPI / ROADMAP"
            title={t('lp.uc.kpi.title')}
            body={t('lp.uc.kpi.body')}
            stat={
              <>
                {t('lp.uc.kpi.statPre')}
                <b className="text-muted-foreground font-semibold tabular-nums">
                  {t('lp.uc.kpi.statBold')}
                </b>
                {t('lp.uc.kpi.statPost')}
              </>
            }
            href={sample('kpi')}
          >
            <span className="bg-muted text-hint absolute top-2.5 right-3 rounded-full px-2 text-[length:var(--text-size-2xs)] font-semibold">
              v23
            </span>
            <div className="text-muted-foreground mb-1.5 text-[length:var(--text-size-2xs)] font-semibold">
              {t('lp.uc.kpi.mini.title')}
            </div>
            <div className="mt-1 flex h-13 items-end gap-2">
              <span
                className="bg-mock-bar flex-1 rounded-t-sm"
                style={{ height: '35%' }}
              />
              <span
                className="bg-mock-bar flex-1 rounded-t-sm"
                style={{ height: '55%' }}
              />
              <span
                className="bg-mock-bar flex-1 rounded-t-sm"
                style={{ height: '45%' }}
              />
              <span
                className="bg-mock-bar flex-1 rounded-t-sm"
                style={{ height: '70%' }}
              />
              <span
                className="bg-mock-bar-accent relative flex-1 rounded-t-sm"
                style={{ height: '82%' }}
              >
                <span className="text-muted-foreground absolute -top-3.5 left-1/2 -translate-x-1/2 text-[length:var(--lp-text-mini)] font-semibold">
                  9.1M
                </span>
              </span>
            </div>
            <div className="text-hint mt-1 flex gap-2 text-center text-[length:var(--lp-text-mini)]">
              <span className="flex-1">{t('lp.uc.kpi.mini.m1')}</span>
              <span className="flex-1">{t('lp.uc.kpi.mini.m2')}</span>
              <span className="flex-1">{t('lp.uc.kpi.mini.m3')}</span>
              <span className="flex-1">{t('lp.uc.kpi.mini.m4')}</span>
              <span className="flex-1">{t('lp.uc.kpi.mini.m5')}</span>
            </div>
            <span className={cn(PIN, 'right-11 bottom-4')}>1</span>
          </UseCaseCard>

          <UseCaseCard
            label="RESEARCH"
            title={t('lp.uc.research.title')}
            body={t('lp.uc.research.body')}
            stat={
              <>
                {t('lp.uc.research.statPre')}
                <b className="text-muted-foreground font-semibold tabular-nums">
                  {t('lp.uc.research.statBold')}
                </b>
                {t('lp.uc.research.statPost')}
              </>
            }
            href={sample('research')}
          >
            <div className="text-muted-foreground mb-1.5 text-[length:var(--text-size-2xs)] font-semibold">
              {t('lp.uc.research.mini.title')}
            </div>
            <p className="text-faint text-[length:var(--lp-text-mini)] leading-[var(--lh-landing-body)]">
              {t('lp.uc.research.mini.p1')}
            </p>
            <p className="text-faint mt-1 text-[length:var(--lp-text-mini)] leading-[var(--lh-landing-body)]">
              {t('lp.uc.research.mini.p2')}
            </p>
            <span className={cn(PIN, 'top-10 right-5')}>2</span>
          </UseCaseCard>

          <UseCaseCard
            label="MINUTES"
            title={t('lp.uc.minutes.title')}
            body={t('lp.uc.minutes.body')}
            stat={t('lp.uc.minutes.note')}
            href={sample('minutes')}
          >
            <div className="text-muted-foreground mb-1.5 text-[length:var(--text-size-2xs)] font-semibold">
              {t('lp.uc.minutes.mini.title')}
            </div>
            {(
              [
                [t('lp.ba.nameA'), t('lp.uc.minutes.mini.l1')],
                [t('lp.ba.nameB'), t('lp.uc.minutes.mini.l2')],
                ['coji', t('lp.uc.minutes.mini.l3')],
              ] as const
            ).map(([name, line]) => (
              <div
                key={name}
                className="mb-1.5 flex items-start gap-2 text-[length:var(--lp-text-mini)] last:mb-0"
              >
                <span className="bg-mock-bar mt-0.5 size-4 flex-none rounded-full" />
                <span className="text-muted-foreground flex-none font-semibold">
                  {name}
                </span>
                <span className="text-faint">{line}</span>
              </div>
            ))}
          </UseCaseCard>
        </div>
      </div>
    </section>
  )
}

function WorksSection() {
  const { t } = useT()
  return (
    <section className="py-26">
      <div className={CONTAINER}>
        <p className={KICKER}>WORKS WITH YOUR AI</p>
        <h2 className={H2}>
          {t('lp.works.title1')} <br className="hidden md:inline" />
          {t('lp.works.title2')}
        </h2>
        <div className="border-foreground mt-12 grid grid-cols-1 border-t md:grid-cols-2">
          <div className="flex flex-col py-7 pr-0 md:pr-10">
            <h3 className="mb-2 text-[length:var(--lp-text-card-title)] font-bold">
              {t('lp.works.cli.title')}
            </h3>
            <p className="text-faint flex-1 text-sm text-pretty">
              {t('lp.works.cli.body')}
            </p>
            <div className="mt-4">
              <Codebox value={t('lp.hero.cliPrompt')} mono={false} />
            </div>
            <div className="mt-2.5 hidden h-8 md:block" aria-hidden="true" />
          </div>
          <div className="border-border flex flex-col border-t py-7 md:border-t-0 md:border-l md:pl-10">
            <h3 className="mb-2 text-[length:var(--lp-text-card-title)] font-bold">
              {t('lp.works.mcp.title')}
            </h3>
            <p className="text-faint flex-1 text-sm text-pretty">
              {t('lp.works.mcp.body')}
            </p>
            <div className="mt-4">
              <Codebox value={MCP_CONNECTOR_URL} />
            </div>
            <ConnectorButtons />
          </div>
        </div>
      </div>
    </section>
  )
}

function QuoteSection() {
  const { t } = useT()
  return (
    <section className="py-20">
      <div className="max-w-guide-shell-prose-max mx-auto px-5 text-center md:px-8">
        <p className="font-serif text-[length:var(--lp-text-quote)] leading-[var(--lh-landing-body)] font-bold text-balance">
          {t('lp.quote.text')}
        </p>
        <p className="text-hint mt-4 text-xs">{t('lp.quote.attr')}</p>
      </div>
    </section>
  )
}

function TrustSection() {
  const { t } = useT()
  return (
    <section className="border-border bg-muted border-y py-26">
      <div className={CONTAINER}>
        <p className={KICKER}>BUILT FOR WORK</p>
        <h2 className={H2}>
          {t('lp.trust.title1')} <br className="hidden md:inline" />
          {t('lp.trust.title2')}
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-7 lg:grid-cols-3">
          {(
            [
              [IconShield, t('lp.trust.c1.title'), t('lp.trust.c1.body')],
              [IconSend, t('lp.trust.c2.title'), t('lp.trust.c2.body')],
              [IconUsers, t('lp.trust.c3.title'), t('lp.trust.c3.body')],
            ] as const
          ).map(([Icon, title, body]) => (
            <div key={title} className={CARD}>
              <span className="bg-muted text-foreground mb-4 grid size-9 place-items-center rounded-md">
                <Icon className="size-4.5" aria-hidden="true" />
              </span>
              <h3 className="mb-1.5 text-[length:var(--lp-text-body)] font-bold">
                {title}
              </h3>
              <p className="text-faint text-[length:var(--lp-text-caption)]">
                {body}
              </p>
            </div>
          ))}
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
    <section className="py-28 text-center">
      <div className={CONTAINER}>
        <h2
          className={cn(
            H2,
            'mx-auto max-w-[var(--max-width-landing-cta-heading)]',
          )}
        >
          {t('lp.ctaEnd.title1')} <br className="hidden md:inline" />
          {t('lp.ctaEnd.title2')}
        </h2>
        <p className={cn(LEAD, 'mx-auto')}>{t('lp.ctaEnd.body')}</p>
        <div className="mt-9 flex flex-wrap justify-center gap-3.5">
          <Button asChild className="h-10 px-5 font-semibold">
            <Link to={startTo}>{t('lp.hero.ctaPrimary')}</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-border-strong hover:bg-foreground/5 h-10 bg-transparent px-5 font-semibold"
          >
            <Link to={pricingTo}>{t('lp.ctaEnd.pricing')}</Link>
          </Button>
        </div>
        <p className="text-hint mt-5 text-[length:var(--lp-text-caption)] tabular-nums">
          {t('lp.ctaEnd.free')}
        </p>
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
    <main
      data-regression-region={regression?.regions?.main}
      className="bg-surface-warm text-foreground font-landing-body bg-[radial-gradient(circle_at_20%_0%,rgba(35,131,226,0.05),transparent_40%),radial-gradient(circle_at_80%_100%,rgba(255,138,101,0.05),transparent_40%)] font-sans text-[length:var(--lp-text-body)] leading-[var(--lh-landing-body)] [word-break:auto-phrase]"
    >
      <LandingHeader />
      {maintenance ? (
        <p className="border-border bg-warning-soft text-foreground m-0 border-b px-5 py-2 text-center text-[length:var(--lp-text-caption)]">
          {t('lp.maintenanceAuth')}
        </p>
      ) : null}

      <HeroSection regression={regression} />

      <BeforeAfterSection />

      <LoopSection />

      <UseCasesSection />

      <WorksSection />

      <QuoteSection />

      <TrustSection />

      <ClosingCtaSection />

      <PublicFooter
        variant="full"
        data-regression-region={regression?.regions?.footer}
      />
    </main>
  )
}
