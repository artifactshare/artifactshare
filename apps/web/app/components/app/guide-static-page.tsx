import {
  GuideHomeLink,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import {
  getPublicGuideVerifiedDate,
  PUBLIC_GUIDE_KEYS,
} from '~/lib/public-guide-freshness'
import { PublicFooter } from '~/components/app/public-footer'
import { GuideHtmlWithFreshness } from './guide-freshness'

export function GuideStaticPage({
  html,
  locale,
  path,
}: {
  html: string
  locale: Locale
  path:
    | '/privacy'
    | '/terms'
    | '/tokushoho'
    | '/guides/workspace-owner'
    | '/guides/workspace-admin'
    | '/guides/link-sharing'
}) {
  const { t } = useT()
  const freshnessKey =
    path === '/guides/workspace-owner'
      ? PUBLIC_GUIDE_KEYS.workspaceOwner
      : path === '/guides/workspace-admin'
        ? PUBLIC_GUIDE_KEYS.workspaceAdmin
        : path === '/guides/link-sharing'
          ? PUBLIC_GUIDE_KEYS.linkSharing
          : null
  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell prose>
        <GuideProse>
          {freshnessKey ? (
            <GuideHtmlWithFreshness
              html={html}
              freshness={{
                kind: 'verified',
                locale,
                verifiedDate: getPublicGuideVerifiedDate(freshnessKey),
              }}
            />
          ) : (
            <div
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered from
              // our own checked-in markdown, no user input.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </GuideProse>
      </GuideShell>
      <PublicFooter />
    </>
  )
}
