import { useState } from 'react'
import { Link, useRouteLoaderData, useSearchParams } from 'react-router'
import { PublicFooter } from '~/components/app/public-footer'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import { AgentDisclosure } from '~/components/app/agent-disclosure'
import { AuthBlock } from '~/components/app/auth-card'
import { BrandMark } from '~/components/app/brand-mark'
import { authEmailLinkClassName } from '~/components/app/auth-styles'
import { LastUsedBadge } from '~/components/app/last-used-badge'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import { LandingProductExplanation } from './landing-product-explanation'
import {
  landingAgentBodyClassName,
  landingAgentIntroClassName,
  landingBrandClassName,
  landingConnectGuideClassName,
  landingCrumbMarkClassName,
  landingGuidesClassName,
  landingHeroContentOffsetClassName,
  landingMaintenanceClassName,
  landingMarkSurfaceClassName,
  landingRouteBadgeClassName,
  landingRouteCardBodyClassName,
  landingRouteCardSurfaceClassName,
  landingRouteCardsClassName,
  landingRouteCardTitleClassName,
  landingScrollCueClassName,
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { SignInOptions } from '~/components/app/sign-in-options'
import { Badge } from '~/components/ui/badge'
import { useT } from '~/hooks/use-t'
import { CONNECT_AI_AGENTS_ANCHOR, withLang } from '~/lib/connect-link'
import { MCP_CONNECTOR_URL } from '~/lib/mcp-metadata'
import { safeInternalNext } from '~/lib/safe-next'
import { getShareWithAiPath } from '~/lib/share-with-ai-link'
import { cn } from '~/lib/utils'

// `init` is the command a first-time user reaches for: it detects the agent,
// installs the bundled skill, and shows the next steps.
const CLI_INIT_COMMAND = 'npx --yes @artifactshare/cli init'

export function Landing({
  regression,
}: {
  regression?: {
    inviteMode?: boolean
    agentEntryOpen?: boolean
    eagerProductImages?: boolean
    regions?: { main?: string; hero?: string; footer?: string }
    primary?: string
  }
} = {}) {
  const { t, locale } = useT()
  const rootData = useRouteLoaderData('root') as
    | { maintenance?: boolean }
    | undefined
  const maintenance = rootData?.maintenance === true
  const connectTo = withLang('/connect', locale)
  const connectAiAgentsTo = withLang(
    '/connect',
    locale,
    CONNECT_AI_AGENTS_ANCHOR,
  )
  const shareWithAiTo = getShareWithAiPath(locale)
  const [params] = useSearchParams()
  const next = params.get('next')
  const inviteMode = regression?.inviteMode ?? next?.startsWith('/a/') ?? false
  const [agentEntryOpen, setAgentEntryOpen] = useState(
    regression?.agentEntryOpen ?? false,
  )

  const callbackURL = safeInternalNext(next)
  const signInHref = `/sign-in?method=email${next ? `&next=${encodeURIComponent(next)}` : ''}`
  const heroContentOffsetClassName = inviteMode
    ? undefined
    : landingHeroContentOffsetClassName

  return (
    <LandingShell
      data-regression-region={regression?.regions?.main}
      data-smooth-scroll={!inviteMode || undefined}
    >
      <LandingHero
        className={!inviteMode ? 'min-h-dvh pb-24' : undefined}
        data-regression-region={regression?.regions?.hero}
      >
        <div
          className={cn(
            landingMarkSurfaceClassName,
            heroContentOffsetClassName,
          )}
        >
          <BrandMark
            size={32}
            className={landingCrumbMarkClassName}
            aria-hidden="true"
          />
        </div>
        <h1 className={landingBrandClassName}>Artifact Share</h1>
        {inviteMode ? (
          <p className={landingTitleClassName}>{t('lp.invite.title')}</p>
        ) : (
          <p className={landingTitleClassName}>{t('lp.title')}</p>
        )}
        <Stack gap="6">
          {inviteMode ? (
            <p className={landingSubClassName}>{t('lp.invite.sub')}</p>
          ) : (
            <p className={landingSubClassName}>
              {t('lp.sub')}
              <br />
              {t('lp.subShare')}
            </p>
          )}
          <AuthBlock>
            <SignInOptions
              callbackURL={callbackURL}
              disabled={maintenance}
              regressionPrimary={regression?.primary}
            />
            <Link to={signInHref} className={authEmailLinkClassName}>
              {t('signin.email.toggle')}
              <LastUsedBadge method="email" />
            </Link>
          </AuthBlock>
        </Stack>
        {maintenance && (
          <p className={landingMaintenanceClassName}>
            {t('lp.maintenanceAuth')}
          </p>
        )}
        {!inviteMode && (
          <AgentDisclosure
            variant="landing"
            className="mb-[var(--spacing-1)]"
            open={agentEntryOpen}
            onToggle={() => setAgentEntryOpen((open) => !open)}
            summaryLabel={t('lp.ai.summary')}
            panelId="landing-agent-entry"
          >
            <div className={landingAgentBodyClassName} inert={!agentEntryOpen}>
              <p className={landingAgentIntroClassName}>
                {t('lp.ai.intro')}
                <br />
                {t('lp.ai.introRoutes')}
              </p>
              <div className={landingRouteCardsClassName}>
                <Stack gap="3" align="start" asChild>
                  <article className={landingRouteCardSurfaceClassName}>
                    <Inline
                      gap="3"
                      align="center"
                      justify="between"
                      className="w-full"
                    >
                      <h2 className={landingRouteCardTitleClassName}>
                        {t('lp.routes.cli.title')}
                      </h2>
                      <Badge
                        variant="info"
                        className={landingRouteBadgeClassName}
                      >
                        {t('lp.routes.cli.badge')}
                      </Badge>
                    </Inline>
                    <p className={landingRouteCardBodyClassName}>
                      {t('lp.routes.cli.body')}
                    </p>
                    <CopyableCodeBlock
                      code={CLI_INIT_COMMAND}
                      name={t('lp.routes.cli.command')}
                      labels={{
                        copy: t('lp.invite.copyCommand'),
                        copied: t('lp.invite.copyCopied'),
                        failed: t('lp.invite.copyFailed'),
                      }}
                      compact
                      className="mt-0 w-full"
                    />
                    <Link
                      to={connectAiAgentsTo}
                      className={landingConnectGuideClassName}
                    >
                      {t('lp.connect.cliLink')}
                    </Link>
                  </article>
                </Stack>
                <Stack gap="3" align="start" asChild>
                  <article className={landingRouteCardSurfaceClassName}>
                    <Inline
                      gap="3"
                      align="center"
                      justify="between"
                      className="w-full"
                    >
                      <h2 className={landingRouteCardTitleClassName}>
                        {t('lp.routes.mcp.title')}
                      </h2>
                      <Badge
                        variant="info"
                        className={landingRouteBadgeClassName}
                      >
                        {t('lp.routes.mcp.badge')}
                      </Badge>
                    </Inline>
                    <p className={landingRouteCardBodyClassName}>
                      {t('lp.routes.mcp.body')}
                    </p>
                    <CopyableCodeBlock
                      code={MCP_CONNECTOR_URL}
                      name={t('lp.routes.mcp.url')}
                      labels={{
                        copy: t('lp.connect.copy'),
                        copied: t('lp.connect.copiedButton'),
                        failed: t('lp.connect.copyFailedButton'),
                      }}
                      compact
                      className="mt-0 w-full"
                    />
                    <Link
                      to={connectTo}
                      className={landingConnectGuideClassName}
                    >
                      {t('lp.connect.mcpLink')}
                    </Link>
                  </article>
                </Stack>
              </div>
              <div className={landingGuidesClassName}>
                <Link
                  to={shareWithAiTo}
                  className={landingConnectGuideClassName}
                >
                  {t('lp.guide.shareWithAi')}
                </Link>
              </div>
            </div>
          </AgentDisclosure>
        )}
        {!inviteMode && (
          <a
            className={cn(
              landingScrollCueClassName,
              agentEntryOpen && 'pointer-events-none invisible',
            )}
            href="#landing-flow"
            aria-hidden={agentEntryOpen || undefined}
            tabIndex={agentEntryOpen ? -1 : undefined}
          >
            <span>{t('lp.scrollToFlow')}</span>
            <span aria-hidden="true">↓</span>
          </a>
        )}
      </LandingHero>
      {!inviteMode ? (
        <LandingProductExplanation
          eagerImages={regression?.eagerProductImages ?? false}
        />
      ) : null}
      <PublicFooter
        variant={inviteMode ? 'minimal' : 'full'}
        data-regression-region={regression?.regions?.footer}
      />
    </LandingShell>
  )
}
