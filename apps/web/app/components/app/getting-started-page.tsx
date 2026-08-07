import {
  IconMessageCircle as MessageCircle,
  IconTerminal2 as Terminal,
  IconUpload as Upload,
} from '@tabler/icons-react'
import { Link } from 'react-router'

import {
  GuideHomeLink,
  GuideMain,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import {
  guideChoiceBodyClassName,
  guideChoiceItemSurfaceClassName,
  guideChoiceTitleClassName,
  guideFocusRingRoundedClassName,
  guideHeroClassName,
  guideLeadClassName,
} from '~/components/app/guide-styles'
import { PublicFooter } from '~/components/app/public-footer'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { CONNECT_AI_AGENTS_ANCHOR, withLang } from '~/lib/connect-link'
import {
  gettingStartedCopy,
  type GettingStartedCopy,
} from '~/lib/getting-started-content'

export function GettingStartedPage({
  locale,
  signedIn,
}: {
  locale: Locale
  signedIn: boolean
}) {
  const { t } = useT()
  const copy = gettingStartedCopy(locale)
  const methods: ReadonlyArray<{
    key: keyof Pick<GettingStartedCopy, 'web' | 'cli' | 'mcp'>
    icon: typeof Upload
    content: GettingStartedCopy['web' | 'cli' | 'mcp']
    href: string
  }> = [
    {
      key: 'web',
      icon: Upload,
      content: copy.web,
      href: signedIn
        ? '/?upload=1'
        : `/sign-in?intent=upload&next=${encodeURIComponent('/?upload=1')}`,
    },
    {
      key: 'cli',
      icon: Terminal,
      content: copy.cli,
      href: withLang('/connect', locale, CONNECT_AI_AGENTS_ANCHOR),
    },
    {
      key: 'mcp',
      icon: MessageCircle,
      content: copy.mcp,
      href: withLang('/connect', locale),
    },
  ]

  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell prose className="max-w-guide-shell-max">
        <GuideMain className="max-w-none">
          <header className={guideHeroClassName}>
            <p className="text-link m-0 mb-3 text-sm font-semibold">
              {copy.eyebrow}
            </p>
            <h1>{copy.heading}</h1>
            <p className={guideLeadClassName}>{copy.lead}</p>
          </header>

          <section
            className="grid grid-cols-1 items-stretch gap-[var(--spacing-4)] lg:grid-cols-3"
            aria-label={copy.eyebrow}
          >
            {methods.map(({ key, icon: Icon, content, href }) => (
              <article
                key={key}
                className={`${guideChoiceItemSurfaceClassName} flex flex-col gap-[var(--spacing-3)]`}
              >
                <div className="text-link" aria-hidden="true">
                  <Icon size={24} strokeWidth={1.8} />
                </div>
                <h2 className={`${guideChoiceTitleClassName} text-lg`}>
                  {content.title}
                </h2>
                <p className={guideChoiceBodyClassName}>{content.body}</p>
                <Button
                  asChild
                  size="lg"
                  className="mt-auto w-full"
                  variant="default"
                >
                  <Link to={href} className={guideFocusRingRoundedClassName}>
                    {content.cta}
                  </Link>
                </Button>
              </article>
            ))}
          </section>

          <p className="text-muted-foreground m-0 mt-7 text-center text-sm">
            {copy.note}
          </p>
        </GuideMain>
      </GuideShell>
      <PublicFooter />
    </>
  )
}
