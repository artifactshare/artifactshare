import type { ReactNode } from 'react'
import {
  IconArrowDown,
  IconArrowUpRight,
  IconInfoCircle,
  IconLink as Link2Icon,
} from '@tabler/icons-react'
import {
  CopyableCodeBlock,
  type CopyableCodeLabels,
} from '~/components/app/copyable-code-block'
import { Link } from 'react-router'
import { ConnectorUrlCopy } from '~/components/app/connector-url-copy'
import {
  GuideHomeLink,
  GuideMain,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import { PublicFooter } from '~/components/app/public-footer'
import {
  guideCalloutBodyClassName,
  guideCalloutClassName,
  guideCalloutIconClassName,
  guideCalloutTitleClassName,
  guideChoiceBodyClassName,
  guideChoiceGridClassName,
  guideChoiceHeadingClassName,
  guideChoiceItemSurfaceClassName,
  guideChoiceSectionClassName,
  guideChoiceTitleClassName,
  guideFocusRingClassName,
  guideFocusRingRoundedClassName,
  guideHeroClassName,
  guideLeadClassName,
  guideNotesSectionClassName,
  guideNotesTitleClassName,
  guideSectionClassName,
  guideSectionFollowClassName,
  guideStepExtraClassName,
  guideStepLinkClassName,
  guideStepsClassName,
  guideStepSubstepsClassName,
  guideSubClassName,
  guideSubInlineLinksClassName,
} from '~/components/app/guide-styles'
import { GuideRail, GuideTocMobile } from '~/components/app/guide-toc'
import { GuideFreshness } from '~/components/app/guide-freshness'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { Badge } from '~/components/ui/badge'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { connectContent, type ConnectContent } from '~/lib/connect-content'
import { withLang } from '~/lib/connect-link'
import { socialMeta } from '~/lib/social-meta'
import { getShareWithAiPath } from '~/lib/share-with-ai-link'
import { APEX_HOST } from '~/lib/hosts'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { MCP_CONNECTOR_URL } from '~/lib/mcp-metadata'
import {
  getPublicGuideVerifiedDate,
  PUBLIC_GUIDE_KEYS,
} from '~/lib/public-guide-freshness'
import type { Route } from './+types/connect'

export function loader() {
  return { locale: DEFAULT_LOCALE }
}

const EN_CANONICAL = `https://${APEX_HOST}/connect`
const JA_CANONICAL = `https://${APEX_HOST}/ja/connect`

export function connectMeta(locale: Locale) {
  const og = connectContent(locale).og
  const canonical = locale === 'ja' ? JA_CANONICAL : EN_CANONICAL
  const ogImageUrl = `https://${APEX_HOST}${withLang('/connect/og-image', locale)}`
  return [
    { title: og.title },
    { name: 'description', content: og.description },
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
      title: og.title,
      description: og.description,
      url: canonical,
      image: ogImageUrl,
      imageAlt: og.title,
    }),
  ]
}

export function meta({ loaderData }: Route.MetaArgs) {
  return connectMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

// Brand accent for the host marker dot. These are external product brand
// colors, not part of the core token palette.
const HOST_DOT: Record<string, string> = {
  claude: '#d97757',
  chatgpt: '#10a37f',
  cursor: '#2e2e2e',
}

const connectChoiceLinkClassName = cn(
  'text-link mt-auto inline-flex items-center gap-[var(--spacing-1)] text-sm font-semibold no-underline',
  'hover:text-link-hover hover:underline hover:underline-offset-3',
  guideFocusRingRoundedClassName,
  '[&_svg]:shrink-0',
)

const connectSectionAnchorClassName = cn(
  'text-faint inline-flex opacity-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none',
  'group-hover/sectionhead:opacity-100 focus-visible:opacity-100',
  guideFocusRingRoundedClassName,
)

const connectOneClickCtaClassName = cn(
  'bg-primary text-primary-foreground inline-flex items-center gap-[var(--spacing-2)] rounded-[var(--r-md)] px-4 py-2.5 text-sm leading-none font-semibold no-underline shadow-[var(--shadow-sm)]',
  'transition-[background,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none',
  'hover:bg-primary-hover hover:shadow-[var(--shadow-md)]',
  guideFocusRingClassName,
  '[&_svg]:shrink-0 [&_svg]:opacity-90',
)

const connectHostSectionFirstClassName = guideSectionClassName
const connectHostSectionFollowClassName = cn(
  guideSectionClassName,
  guideSectionFollowClassName,
)

// Tokenize the connector config so keys and string values can be colored.
// Numbers/whitespace stay plain — restraint over a full highlighter.
function highlightJson(code: string): ReactNode[] {
  const out: ReactNode[] = []
  const stringPattern = /"(?:[^"\\]|\\.)*"/y
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '"') {
      stringPattern.lastIndex = i
      const match = stringPattern.exec(code)
      const str = match ? match[0] : ch
      let j = i + str.length
      while (j < code.length && /\s/.test(code[j])) j++
      const isKey = code[j] === ':'
      out.push(
        <span
          key={i}
          className={isKey ? 'text-foreground font-semibold' : 'text-link'}
        >
          {str}
        </span>,
      )
      i += str.length
    } else if ('{}[]:,'.includes(ch)) {
      out.push(
        <span key={i} className="text-faint">
          {ch}
        </span>,
      )
      i++
    } else {
      let j = i
      while (j < code.length && !'"{}[]:,'.includes(code[j])) j++
      out.push(code.slice(i, j))
      i = j
    }
  }
  return out
}

function ConnectCodeBlock({
  code,
  filename,
  labels,
  plain,
}: {
  code: string
  filename: string
  labels: CopyableCodeLabels
  plain?: boolean
}) {
  return (
    <CopyableCodeBlock code={code} name={filename} labels={labels}>
      {plain ? code : highlightJson(code)}
    </CopyableCodeBlock>
  )
}

function ConnectHostSection({
  host,
  hostIndex,
  content,
  isJa,
}: {
  host: ConnectContent['hosts'][number]
  hostIndex: number
  content: ConnectContent
  isJa: boolean
}) {
  return (
    <section
      id={host.id}
      className={
        hostIndex > 0
          ? connectHostSectionFollowClassName
          : connectHostSectionFirstClassName
      }
      data-toc-section=""
    >
      <div className="group/sectionhead mb-[var(--spacing-2)]">
        <Inline gap="2" align="center">
          <span
            className="size-3 shrink-0 rounded-full"
            style={{
              background: HOST_DOT[host.id] ?? 'var(--faint)',
            }}
            aria-hidden="true"
          />
          <h2 className="m-0 text-xl font-semibold tracking-tight">
            {host.heading}
          </h2>
          <a
            className={connectSectionAnchorClassName}
            href={`#${host.id}`}
            aria-label={isJa ? 'この節へのリンク' : 'Link to this section'}
          >
            <Link2Icon aria-hidden="true" size={15} strokeWidth={2} />
          </a>
        </Inline>
      </div>
      {host.lead && (
        <p className="text-muted-foreground mb-[var(--spacing-4)]">
          {host.lead}
        </p>
      )}
      {host.note && (
        <div className={cn(guideCalloutClassName, 'mb-5')}>
          <span className={guideCalloutIconClassName} aria-hidden="true">
            <IconInfoCircle size={18} strokeWidth={2} />
          </span>
          <p className={guideCalloutBodyClassName}>{host.note}</p>
        </div>
      )}
      {host.oneClick && (
        <div className="mt-[var(--spacing-2)] mb-[var(--spacing-5)]">
          <Stack gap="3" align="start">
            <p className="text-foreground m-0">{host.oneClick.lead}</p>
            <a
              className={connectOneClickCtaClassName}
              href={host.oneClick.href}
              // Web connector links (Claude) open in a new tab so the setup
              // guide stays put. App-scheme links (Cursor's cursor://) stay
              // in this tab — the OS handles them and a new tab would just be
              // left blank.
              {...(host.oneClick.href.startsWith('http')
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
            >
              {host.oneClick.label}
              <IconArrowUpRight
                aria-hidden="true"
                size={16}
                strokeWidth={2.2}
              />
            </a>
            <p className="text-muted-foreground m-0">{host.oneClick.dialog}</p>
            <p className="text-muted-foreground m-0">
              {host.oneClick.fallbackLead}
            </p>
          </Stack>
        </div>
      )}
      <ol className={guideStepsClassName}>
        {host.steps.map((step, index) => (
          <li key={`${host.id}-${index}`}>
            <div className="min-w-0 pt-0.5">
              {typeof step === 'string' ? (
                <span>{step}</span>
              ) : (
                <span>
                  {step.text}
                  {step.link?.href.startsWith('/') ? (
                    <Link
                      to={step.link.href}
                      className={guideStepLinkClassName}
                    >
                      {step.link.label}
                    </Link>
                  ) : step.link ? (
                    <a href={step.link.href} className={guideStepLinkClassName}>
                      {step.link.label}
                    </a>
                  ) : null}
                  {step.after ?? ''}
                </span>
              )}
              {typeof step !== 'string' && step.substeps && (
                <ul className={guideStepSubstepsClassName}>
                  {step.substeps.map((substep) => (
                    <li key={substep}>{substep}</li>
                  ))}
                </ul>
              )}
              {host.codeBlock && host.codeBlockStep === index + 1 && (
                <div className={guideStepExtraClassName}>
                  <ConnectCodeBlock
                    code={host.codeBlock}
                    filename={host.codeBlockName ?? 'mcp.json'}
                    labels={content.codeCopyLabels}
                  />
                </div>
              )}
              {host.urlStep === index + 1 && (
                <div className={guideStepExtraClassName}>
                  <ConnectorUrlCopy
                    url={MCP_CONNECTOR_URL}
                    labels={content.copyLabels}
                  />
                </div>
              )}
              {host.snippets?.reduce<React.ReactElement[]>(
                (acc, snippet, snippetIndex) => {
                  if (snippet.step === index + 1)
                    acc.push(
                      <div
                        key={snippetIndex}
                        className={guideStepExtraClassName}
                      >
                        <ConnectCodeBlock
                          code={snippet.code}
                          filename={snippet.name}
                          labels={content.commandCopyLabels}
                          plain
                        />
                      </div>,
                    )
                  return acc
                },
                [],
              )}
            </div>
          </li>
        ))}
      </ol>
      {host.codeBlock && !host.codeBlockStep && (
        <div className={guideStepExtraClassName}>
          <ConnectCodeBlock
            code={host.codeBlock}
            filename={host.codeBlockName ?? 'mcp.json'}
            labels={content.codeCopyLabels}
          />
        </div>
      )}
    </section>
  )
}

export function ConnectPage({ locale }: { locale: Locale }) {
  const { t } = useT()
  const content = connectContent(locale)
  const isJa = locale === 'ja'
  const onThisPage = isJa ? 'このページの内容' : 'On this page'

  const toc = [
    ...content.hosts.map((host) => ({ id: host.id, label: host.heading })),
    { id: 'notes', label: content.notesHeading },
  ]

  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell>
        <GuideMain>
          <header className={guideHeroClassName}>
            <h1>{content.title}</h1>
            <GuideFreshness
              kind="verified"
              locale={locale}
              verifiedDate={getPublicGuideVerifiedDate(
                PUBLIC_GUIDE_KEYS.connect,
              )}
              {...content.guideFreshness}
            />
            <p className={guideLeadClassName}>{content.intro}</p>
            <p className={guideSubClassName}>{content.capabilities}</p>
            <p className={guideSubInlineLinksClassName}>
              {content.guideLead}{' '}
              <Link to={getShareWithAiPath(locale)}>
                {content.guideLinkLabel}
              </Link>
            </p>
          </header>

          <section
            className={guideChoiceSectionClassName}
            aria-labelledby="connect-choice-heading"
          >
            <h2
              id="connect-choice-heading"
              className={guideChoiceHeadingClassName}
            >
              {content.choiceHeading}
            </h2>
            <div className={guideChoiceGridClassName}>
              {content.choices.map((choice) => (
                <Stack key={choice.badge} gap="3" align="start" asChild>
                  <article className={guideChoiceItemSurfaceClassName}>
                    <Inline
                      gap="3"
                      align="center"
                      justify="between"
                      className="w-full"
                    >
                      <h3 className={guideChoiceTitleClassName}>
                        {choice.label}
                      </h3>
                      <Badge
                        variant="info"
                        className="min-h-6 px-2.25 py-0.5 font-bold tracking-wide"
                      >
                        {choice.badge}
                      </Badge>
                    </Inline>
                    <p className={guideChoiceBodyClassName}>{choice.body}</p>
                    <a
                      className={connectChoiceLinkClassName}
                      href={choice.href}
                    >
                      {choice.linkLabel}
                      <IconArrowDown
                        aria-hidden="true"
                        size={15}
                        strokeWidth={2.2}
                      />
                    </a>
                  </article>
                </Stack>
              ))}
            </div>
          </section>

          <GuideTocMobile items={toc} title={onThisPage} />

          <div className="mt-[var(--spacing-12)]">
            {content.hosts.map((host, hostIndex) => (
              <ConnectHostSection
                key={host.id}
                host={host}
                hostIndex={hostIndex}
                content={content}
                isJa={isJa}
              />
            ))}
          </div>

          <section
            className={guideNotesSectionClassName}
            id="notes"
            data-toc-section=""
          >
            <h2 className={guideNotesTitleClassName}>{content.notesHeading}</h2>
            <Stack gap="3">
              {content.notes.map((note) => (
                <div key={note.label} className={guideCalloutClassName}>
                  <span
                    className={guideCalloutIconClassName}
                    aria-hidden="true"
                  >
                    <IconInfoCircle size={18} strokeWidth={2} />
                  </span>
                  <div>
                    <h3 className={guideCalloutTitleClassName}>{note.label}</h3>
                    <p className={guideCalloutBodyClassName}>{note.body}</p>
                    {note.code && (
                      <div className={guideStepExtraClassName}>
                        <ConnectCodeBlock
                          code={note.code}
                          filename={note.codeName ?? 'Terminal'}
                          labels={content.commandCopyLabels}
                          plain
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </Stack>
          </section>
        </GuideMain>
        <GuideRail items={toc} title={onThisPage} />
      </GuideShell>
      <PublicFooter />
    </>
  )
}

export default function ConnectRoute({ loaderData }: Route.ComponentProps) {
  return <ConnectPage locale={loaderData.locale} />
}
