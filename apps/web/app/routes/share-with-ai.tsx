import { Link } from 'react-router'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import {
  GuideHomeLink,
  GuideMain,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import { PublicFooter } from '~/components/app/public-footer'
import {
  guideCalloutBodyClassName,
  guideCalloutClassName,
  guideCalloutIconClassName,
  guideCalloutTitleClassName,
  guideChoiceHeadingClassName,
  guideChoiceItemSurfaceClassName,
  guideChoiceSectionClassName,
  guideChoiceTitleClassName,
  guideHeroClassName,
  guideLeadClassName,
  guideNotesSectionClassName,
  guideNotesTitleClassName,
  guideSectionClassName,
  guideSubClassName,
  guideSubInlineLinksClassName,
} from '~/components/app/guide-styles'
import { GuideRail, GuideTocMobile } from '~/components/app/guide-toc'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { Badge } from '~/components/ui/badge'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { withLang } from '~/lib/connect-link'
import { APEX_HOST } from '~/lib/hosts'
import { shareWithAiContent, type TaskRoute } from '~/lib/share-with-ai-content'
import {
  SHARE_WITH_AI_EN_PATH,
  SHARE_WITH_AI_JA_PATH,
} from '~/lib/share-with-ai-link'
import { socialMeta } from '~/lib/social-meta'
import type { Route } from './+types/share-with-ai'
import { IconInfoCircle } from '@tabler/icons-react'

export { SHARE_WITH_AI_EN_PATH, SHARE_WITH_AI_JA_PATH }

const EN_CANONICAL = `https://${APEX_HOST}${SHARE_WITH_AI_EN_PATH}`
const JA_CANONICAL = `https://${APEX_HOST}${SHARE_WITH_AI_JA_PATH}`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

const shareWithAiExamplesClassName = 'min-w-0'

const taskCardSurfaceClassName = cn(
  guideChoiceItemSurfaceClassName,
  'scroll-mt-scroll-anchor relative',
)

const taskOutputLabelClassName =
  'shrink-0 rounded-[var(--r-full)] bg-chip-muted py-px px-task-label-inline text-xs font-semibold tracking-wide text-faint'

const taskDetailClassName = cn(
  'text-muted-foreground mt-[var(--spacing-2)] text-xs',
  '[&_summary]:text-faint [&_summary]:cursor-pointer [&_summary]:font-medium [&_summary]:[user-select:none]',
  '[&_p]:mt-[var(--spacing-2)] [&_p]:mb-0 [&_p]:text-xs [&_p]:leading-[var(--lh-loose)]',
)

function canonicalForLocale(locale: Locale): string {
  return locale === 'ja' ? JA_CANONICAL : EN_CANONICAL
}

export function shareWithAiMeta(locale: Locale) {
  const og = shareWithAiContent(locale).og
  const canonical = canonicalForLocale(locale)
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
      image: OG_IMAGE_URL,
      imageAlt: og.title,
    }),
  ]
}

export function loader() {
  return { locale: DEFAULT_LOCALE }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return shareWithAiMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

function RouteBadge({ route, label }: { route: TaskRoute; label: string }) {
  return <Badge variant={route === 'cli' ? 'info' : 'muted'}>{label}</Badge>
}

export function ShareWithAiPage({ locale }: { locale: Locale }) {
  const { t } = useT()
  const content = shareWithAiContent(locale)

  const toc = [
    ...content.tasks.map((task) => ({ id: task.id, label: task.title })),
    { id: 'next', label: content.nextHeading },
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
            <p className={guideLeadClassName}>{content.intro}</p>
            <p className={guideSubInlineLinksClassName}>
              {content.connectLead.before}
              <Link to={withLang('/connect', locale)}>
                {content.connectLead.link}
              </Link>
              {content.connectLead.after}
            </p>
          </header>

          <GuideTocMobile items={toc} title={content.tocTitle} />

          <Stack
            gap="4"
            asChild
            className={guideChoiceSectionClassName}
            aria-labelledby="share-with-ai-tasks-heading"
          >
            <section>
              <h2
                id="share-with-ai-tasks-heading"
                className={cn(guideChoiceHeadingClassName, 'mb-0')}
              >
                {content.tasksHeading}
              </h2>
              <p className={guideSubClassName}>{content.tasksIntro}</p>
              <Stack gap="3" className={shareWithAiExamplesClassName}>
                {content.tasks.map((task) => (
                  <Stack key={task.id} gap="3" align="start" asChild>
                    <article
                      className={taskCardSurfaceClassName}
                      id={task.id}
                      data-toc-section=""
                    >
                      <Inline
                        gap="3"
                        align="baseline"
                        justify="between"
                        className="w-full"
                      >
                        <h3 className={guideChoiceTitleClassName}>
                          {task.title}
                        </h3>
                        <Inline gap="2" className="shrink-0">
                          {(['cli', 'mcp'] as const).flatMap((route) =>
                            task.routes.includes(route)
                              ? [
                                  <RouteBadge
                                    key={route}
                                    route={route}
                                    label={content.routeBadges[route]}
                                  />,
                                ]
                              : [],
                          )}
                        </Inline>
                      </Inline>
                      <CopyableCodeBlock
                        code={task.ask}
                        name={content.askLabel}
                        labels={content.copyLabels}
                        compact
                        className="mt-0 w-full min-w-0 [&_pre]:min-w-0 [&_pre_code]:[overflow-wrap:anywhere] [&_pre_code]:whitespace-pre-wrap"
                      />
                      <div className="mt-[var(--spacing-1)] w-full">
                        <Inline
                          gap="2"
                          align="baseline"
                          className="text-muted-foreground w-full text-xs leading-[var(--lh-loose)]"
                        >
                          <span className={taskOutputLabelClassName}>
                            {content.outputLabel}
                          </span>
                          <span>{task.output}</span>
                        </Inline>
                      </div>
                      <details className={taskDetailClassName}>
                        <summary>{content.detailLabel}</summary>
                        <p>{task.detail}</p>
                      </details>
                    </article>
                  </Stack>
                ))}
              </Stack>
            </section>
          </Stack>

          <section
            className={guideSectionClassName}
            id="next"
            data-toc-section=""
            aria-labelledby="share-with-ai-next-heading"
          >
            <GuideProse className="[&_h2]:mt-0">
              <h2 id="share-with-ai-next-heading">{content.nextHeading}</h2>
              <h3>{content.nextConnectHeading}</h3>
              <ul>
                {content.nextConnectLinks.map((link) => (
                  <li key={link.path ?? link.anchor}>
                    <Link
                      to={
                        link.path
                          ? withLang(link.path, locale)
                          : withLang('/connect', locale, link.anchor)
                      }
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </GuideProse>
          </section>

          <section
            className={guideNotesSectionClassName}
            aria-labelledby="share-with-ai-notes-heading"
          >
            <h2
              className={guideNotesTitleClassName}
              id="share-with-ai-notes-heading"
            >
              {content.notesHeading}
            </h2>
            <Stack gap="3">
              {content.noteItems.map((note) => (
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
                  </div>
                </div>
              ))}
            </Stack>
          </section>
        </GuideMain>
        <GuideRail items={toc} title={content.tocTitle} />
      </GuideShell>
      <PublicFooter />
    </>
  )
}

export default function ShareWithAiRoute({ loaderData }: Route.ComponentProps) {
  return <ShareWithAiPage locale={loaderData.locale} />
}
