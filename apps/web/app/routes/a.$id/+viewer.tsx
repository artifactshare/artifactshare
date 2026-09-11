import { useState } from 'react'
import { isRouteErrorResponse, Link, useRouteLoaderData } from 'react-router'
import { Button } from '~/components/ui/button'
import { Empty, EmptyContent } from '~/components/ui/empty'
import { AgentDisclosure } from '~/components/app/agent-disclosure'
import { AuthBlock } from '~/components/app/auth-card'
import { BrandMark } from '~/components/app/brand-mark'
import {
  authEmailLinkClassName,
  preauthAgentBodyClassName,
  preauthCardClassName,
  preauthFooterLinksClassName,
  preauthLockIconClassName,
  preauthMainClassName,
  preauthSubClassName,
  preauthTitleClassName,
} from '~/components/app/auth-styles'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import { LastUsedBadge } from '~/components/app/last-used-badge'
import { SignInOptions } from '~/components/app/sign-in-options'
import { PermissionDenied } from './+components/permission-denied'
import { SourceMissing } from './+components/source-missing'
import { Unavailable } from '~/components/app/unavailable'
import { UnsupportedContent } from './+components/unsupported-content'
import { useT } from '~/hooks/use-t'
import type { AnalyticsConsentResolution } from '~/lib/analytics-consent'
import { displayTitle } from '~/lib/display-title'
import { socialMeta } from '~/lib/social-meta'
import { type Visibility } from '~/lib/shareable-types'
import { toUserInfo, type SessionUser } from '~/lib/user'
import { ViewerShell } from './+components/viewer-shell'
import { ArtifactViewTracker } from './+components/artifact-view-tracker'
import { IconLock } from '@tabler/icons-react'

import type { LoaderData } from './+loader.server'

type SharePreviewArtifact = {
  id: string
  name: string
  derivedTitle: string | null
  titleOverride: string | null
  description: string | null
  visibility: Visibility
  ogImageKey: string
}

function preauthMetaDescription(canonicalUrl: string) {
  return `This Artifact Share file requires sign-in with an allowed account. AI assistants cannot read the file contents from this unauthenticated page. Shell-capable agents can try ${buildPreauthCliOpenCommand(canonicalUrl)}.`
}

const PREAUTH_OG_DESCRIPTION = 'Shared via Artifact Share'

export function meta({ loaderData }: { loaderData?: LoaderData }) {
  const robots = { name: 'robots', content: 'noindex, nofollow' }
  if (loaderData?.kind === 'preauth') {
    const title = 'Artifact Share'
    const description = preauthMetaDescription(loaderData.canonicalUrl)
    const tags: Array<
      | { title: string }
      | { property: string; content: string }
      | { name: string; content: string }
    > = [
      { title: `${title} · Artifact Share` },
      robots,
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: PREAUTH_OG_DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Artifact Share' },
      { property: 'og:url', content: loaderData.canonicalUrl },
    ]
    return tags
  }
  if (loaderData?.kind === 'static_site' || loaderData?.kind === 'ok') {
    return sharedPreviewMeta(
      loaderData.artifact,
      robots,
      loaderData.canonicalUrl,
    )
  }
  return [{ title: 'Artifact Share' }, robots]
}

function sharedPreviewMeta(
  artifact: SharePreviewArtifact,
  robots: { name: string; content: string },
  canonicalUrl: string,
): Array<
  | { title: string }
  | { property: string; content: string }
  | { name: string; content: string }
> {
  const title = displayTitle(artifact)
  const tags: Array<
    | { title: string }
    | { property: string; content: string }
    | { name: string; content: string }
  > = [{ title: `${title} · Artifact Share` }, robots]
  if (artifact.visibility === 'link') {
    const description = sharedPreviewDescription(artifact)
    const imageUrl = new URL(
      `/a/${encodeURIComponent(artifact.id)}/og-image`,
      canonicalUrl,
    )
    imageUrl.searchParams.set('v', artifact.ogImageKey)
    tags.push(
      { name: 'description', content: description },
      ...socialMeta({
        title,
        description,
        url: canonicalUrl,
        image: imageUrl.toString(),
        imageAlt: `${title} on Artifact Share`,
      }),
    )
  }
  return tags
}

function sharedPreviewDescription(artifact: SharePreviewArtifact): string {
  return artifact.description?.trim() || PREAUTH_OG_DESCRIPTION
}

export default function ViewerRoute({
  loaderData,
}: {
  loaderData: LoaderData
}) {
  const rootData = useRouteLoaderData<{
    analyticsConsent?: AnalyticsConsentResolution
  }>('root')
  const shouldLoadAnalytics =
    rootData?.analyticsConsent?.shouldLoadAnalytics ?? false

  switch (loaderData.kind) {
    case 'preauth':
      return <PreauthFallback canonicalUrl={loaderData.canonicalUrl} />
    case 'denied-internal':
      return (
        <PermissionDenied
          variant="internal"
          artifact={loaderData.artifact}
          user={loaderData.user}
          emailVerified={loaderData.emailVerified}
          requestStatus={loaderData.requestStatus}
        />
      )
    case 'denied-external':
      return (
        <PermissionDenied
          variant="external"
          artifactId={loaderData.artifactId}
          user={loaderData.user}
          emailVerified={loaderData.emailVerified}
          requestStatus={loaderData.requestStatus}
        />
      )
    case 'source-missing':
      return (
        <SourceMissing user={loaderData.user} artifact={loaderData.artifact} />
      )
    case 'unsupported':
      return (
        <ViewerShell
          artifact={loaderData.artifact}
          user={loaderData.user}
          renderType={null}
          sandboxUrl={null}
          bundlePaths={[]}
          analyticsMode={shouldLoadAnalytics ? 'enabled' : 'disabled'}
        >
          <UnsupportedContent />
        </ViewerShell>
      )
    case 'unavailable':
      return (
        <Unavailable
          reason={loaderData.reason ?? 'missing'}
          user={loaderData.user}
          // A paused link is an intended state, not a broken capture.
          screenCaptureError={
            loaderData.reason === 'link-suspended'
              ? undefined
              : 'viewer-unavailable'
          }
          appOrigin={loaderData.appOrigin}
        />
      )
    case 'ok':
      return (
        <>
          <ViewerShell
            artifact={loaderData.artifact}
            user={loaderData.user}
            renderType={loaderData.renderType}
            sandboxUrl={loaderData.sandboxUrl}
            bundlePaths={[]}
            appOrigin={loaderData.appOrigin}
            analyticsMode={shouldLoadAnalytics ? 'enabled' : 'disabled'}
            linkSafety={loaderData.linkSafety}
          />
          <ArtifactViewTracker
            artifactId={loaderData.artifact.id}
            renderType={loaderData.renderType}
            canTrackView={loaderData.canTrackView}
            visibility={loaderData.artifact.visibility}
            viewerState={loaderData.user ? 'authenticated' : 'anonymous'}
          />
        </>
      )
    case 'static_site':
      return (
        <>
          <ViewerShell
            artifact={loaderData.artifact}
            user={loaderData.user}
            renderType="static_site"
            sandboxUrl={loaderData.sandboxUrl}
            bundlePaths={loaderData.bundlePaths}
            fallbackToIndex={loaderData.fallbackToIndex}
            appOrigin={loaderData.appOrigin}
            analyticsMode={shouldLoadAnalytics ? 'enabled' : 'disabled'}
            linkSafety={loaderData.linkSafety}
          />
          <ArtifactViewTracker
            artifactId={loaderData.artifact.id}
            renderType="static_site"
            canTrackView={loaderData.canTrackView}
            visibility={loaderData.artifact.visibility}
            viewerState={loaderData.user ? 'authenticated' : 'anonymous'}
          />
        </>
      )
    default: {
      const _exhaustive: never = loaderData
      return _exhaustive
    }
  }
}

export function buildPreauthCliOpenCommand(canonicalUrl: string) {
  return `npm exec --yes --package=@artifactshare/cli -- artifactshare open ${canonicalUrl}`
}

function PreauthFallback({ canonicalUrl }: { canonicalUrl: string }) {
  const { t } = useT()
  const cliCommand = buildPreauthCliOpenCommand(canonicalUrl)
  const [agentHelpOpen, setAgentHelpOpen] = useState(false)
  const returnUrl = new URL(canonicalUrl)
  const returnPath = `${returnUrl.pathname}${returnUrl.search}`
  const signInHref = `/sign-in?method=email&next=${encodeURIComponent(returnPath)}`
  return (
    <Stack gap="0" align="center" justify="center" asChild>
      <main className={preauthMainClassName}>
        <div className={preauthCardClassName}>
          <span className={preauthLockIconClassName} aria-hidden="true">
            <IconLock strokeWidth={1.6} aria-hidden="true" />
          </span>
          <h1 className={preauthTitleClassName}>{t('lp.invite.title')}</h1>
          <Stack gap="12">
            <p className={preauthSubClassName}>{t('lp.invite.sub')}</p>
            <AuthBlock>
              <SignInOptions callbackURL={returnPath} />
              <Link to={signInHref} className={authEmailLinkClassName}>
                {t('signin.email.toggle')}
                <LastUsedBadge method="email" />
              </Link>
            </AuthBlock>
          </Stack>
          <AgentDisclosure
            open={agentHelpOpen}
            onToggle={() => setAgentHelpOpen((open) => !open)}
            summaryLabel={t('lp.invite.agentSummary')}
            panelId="preauth-agent-help"
            panelAriaHidden={!agentHelpOpen}
          >
            <AgentHelpContent
              cliCommand={cliCommand}
              interactive={agentHelpOpen}
            />
          </AgentDisclosure>
        </div>
        <div className="mt-[var(--spacing-8)]">
          <Inline gap="2" align="center" wrap justify="center" asChild>
            <p className={preauthFooterLinksClassName}>
              <BrandMark size={16} aria-hidden="true" />
              <span>{t('lp.invite.about')}</span>
              <Link to="/">{t('lp.invite.aboutLink')}</Link>
            </p>
          </Inline>
        </div>
      </main>
    </Stack>
  )
}

export function AgentHelpContent({
  cliCommand,
  interactive,
}: {
  cliCommand: string
  interactive: boolean
}) {
  const { t } = useT()
  return (
    <>
      <div className={preauthAgentBodyClassName}>
        <p>{t('lp.invite.aiBody')}</p>
        <p>
          <strong>{t('lp.invite.cliTitle')}</strong>
          {t('lp.invite.cliBody')}
        </p>
      </div>
      <CopyableCodeBlock
        code={cliCommand}
        name={t('lp.invite.commandLabel')}
        labels={{
          copy: t('lp.invite.copyCommand'),
          copied: t('lp.invite.copyCopied'),
          failed: t('lp.invite.copyFailed'),
        }}
        compact
        copyTabIndex={interactive ? 0 : -1}
      />
      <div className={preauthAgentBodyClassName}>
        <p>
          <strong>{t('lp.invite.chatTitle')}</strong>
          {t('lp.invite.chatBody')}
        </p>
      </div>
    </>
  )
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const rootData = useRouteLoaderData<{ user: SessionUser | null }>('root')
  if (!rootData?.user) {
    return (
      <main data-screen-capture-error="viewer-route-error-boundary">
        <Empty>
          <EmptyContent>
            <Button asChild>
              <Link to="/">Back</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    )
  }
  const is404 = isRouteErrorResponse(error) && error.status === 404
  return (
    <Unavailable
      user={toUserInfo(rootData.user)}
      reason={is404 ? 'missing' : 'open-error'}
      screenCaptureError="viewer-route-error-boundary"
    />
  )
}
