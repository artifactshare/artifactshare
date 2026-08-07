import { Link } from 'react-router'
import { Button } from '~/components/ui/button'
import {
  GuideHomeLink,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from './guide-shell'
import { GuideLanguageSwitcher } from './guide-language-switcher'
import { useCopyState } from '~/hooks/use-copy-state'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { privateMobileDesignHandoffContent } from '~/lib/private-mobile-design-handoff-content'
import {
  getPublicGuideVerifiedDate,
  PUBLIC_GUIDE_KEYS,
} from '~/lib/public-guide-freshness'
import type { Locale } from '~/i18n/messages'
import { Stack } from '~/components/layout/stack'
import { GuideHtmlWithFreshness } from './guide-freshness'

function GuideMarkdown({ html, locale }: { html: string; locale: Locale }) {
  return (
    <GuideProse>
      <GuideHtmlWithFreshness
        html={html}
        freshness={{
          kind: 'verified',
          locale,
          verifiedDate: getPublicGuideVerifiedDate(
            PUBLIC_GUIDE_KEYS.privateMobileDesignHandoff,
          ),
        }}
      />
    </GuideProse>
  )
}

export function PrivateMobileDesignHandoffPage({
  locale,
  source,
  html,
}: {
  locale: Locale
  source: string
  html: string
}) {
  const { t } = useT()
  const content = privateMobileDesignHandoffContent(locale)
  const { state, copy } = useCopyState(source)
  const label =
    state === 'copied'
      ? content.copyLabels.copied
      : state === 'failed'
        ? content.copyLabels.failed
        : content.copyLabels.copy
  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell prose>
        <Stack gap="4">
          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {label}
            </Button>
            <span className="sr-only" aria-live="polite">
              {state === 'copied'
                ? content.copyLabels.copied
                : state === 'failed'
                  ? content.copyLabels.failed
                  : ''}
            </span>
          </div>
          <GuideMarkdown html={html} locale={locale} />
          <Stack gap="12">
            <GuideProse>
              <h2>
                {locale === 'ja'
                  ? '非公開の引き継ぎを始める'
                  : 'Start a private handoff'}
              </h2>
              <p>
                {locale === 'ja'
                  ? '利用開始ページでCLIをセットアップし、モバイルのエージェントから設計文書を非公開で投稿します。'
                  : 'Set up the CLI from Getting Started, then have your mobile agent share the design document privately.'}
              </p>
              <Link
                to={withLang('/start', locale)}
                className="text-link underline"
              >
                {locale === 'ja' ? '利用を始める' : 'Get started'}
              </Link>
            </GuideProse>
            <nav
              aria-label={locale === 'ja' ? '関連リンク' : 'Related links'}
              className="mt-8 text-sm"
            >
              <Link
                to={withLang(content.links.cliReference, locale)}
                className="text-link underline"
              >
                {locale === 'ja' ? 'CLI リファレンス' : 'CLI reference'}
              </Link>
              <span className="text-faint mx-2" aria-hidden="true">
                ·
              </span>
              <Link
                to={withLang(content.links.updates, locale)}
                className="text-link underline"
              >
                Updates
              </Link>
            </nav>
            <GuideLanguageSwitcher
              locale={locale}
              hrefFor={(next) =>
                withLang('/guides/private-mobile-design-handoff', next)
              }
            />
          </Stack>
        </Stack>
      </GuideShell>
    </>
  )
}
