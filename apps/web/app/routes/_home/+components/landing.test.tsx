import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Landing } from './landing'

const searchParams = vi.hoisted(() => ({ next: null as string | null }))
const rootData = vi.hoisted(() => ({ maintenance: false }))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'lp.title': 'Share HTML files inside your organization.',
        'lp.sub':
          'Turn HTML and Markdown made with AI into links that open in a browser.',
        'lp.subShare':
          'Share it only within your company or with project members.',
        'lp.scrollToFlow': 'What you can do with Artifact Share',
        'lp.invite.title': 'Sign in to view this file',
        'lp.invite.sub': 'Someone shared a file with you.',
        'lp.cta': 'Continue with Google',
        'lp.maintenanceAuth': 'Artifact Share is under maintenance.',
        'lp.ai.summary': 'Use it with AI',
        'lp.ai.intro': 'Markdown, folders, and static sites work too.',
        'lp.routes.mcp.badge': 'MCP',
        'lp.routes.mcp.title': 'AI chat',
        'lp.routes.mcp.body': 'Connect in chat.',
        'lp.routes.cli.badge': 'CLI',
        'lp.routes.cli.title': 'Shell environments',
        'lp.routes.cli.body': 'AI agents with shell access.',
        'lp.guide.shareWithAi': 'How to use it with AI',
        'lp.flow.title':
          'One flow from publishing work made with AI to updating it at the same URL.',
        'lp.flow.body':
          'With Artifact Share, decide who can view a file when you publish it, collect comments at the relevant places on the shared page, and update the next version at the same URL.',
        'lp.flow.steps.publish.title': 'Publish and choose who can view',
        'lp.flow.steps.publish.body':
          'Publish HTML, Markdown, a folder, or a static site from AI or your browser to create a link that opens in a browser. Choose who can view it based on who you want to share it with.',
        'lp.flow.steps.publish.imageAlt':
          'A simplified interface showing work from AI or the browser becoming a browser page and link, with controls for who can view it.',
        'lp.flow.steps.comment.title':
          'Comment at the relevant place on the shared page',
        'lp.flow.steps.comment.body':
          'Comment at the relevant place while viewing the shared page, then continue the discussion in a thread.',
        'lp.flow.steps.comment.imageAlt':
          'A simplified shared page with a comment thread attached to the relevant passage.',
        'lp.flow.steps.update.title':
          'Update to the next version at the same URL',
        'lp.flow.steps.update.body':
          'Update the next version from your AI or browser after applying the comments. Everyone you shared it with can see the new content at the same URL.',
        'lp.flow.steps.update.imageAlt':
          'A simplified interface showing an update from AI or the browser appearing on the page at the same URL.',
        'lp.workflow.title': 'Make AI drafts ready for team decisions.',
        'lp.workflow.body': 'Share reports with a link.',
        'lp.workflow.cards.research.label': 'Research',
        'lp.workflow.cards.research.title':
          'Research reports shaped by the people doing the work',
        'lp.workflow.cards.research.body': 'Fill in missing context.',
        'lp.workflow.cards.kpi.label': 'KPI',
        'lp.workflow.cards.kpi.title':
          'KPI documents that turn numbers into decisions',
        'lp.workflow.cards.kpi.body': 'Turn numbers into decisions.',
        'lp.workflow.cards.design.label': 'Design',
        'lp.workflow.cards.design.title':
          'Agree on the design before implementation',
        'lp.workflow.cards.design.body': 'Agree before coding.',
        'lp.ai.title': 'CLI for agents. MCP for chat.',
        'lp.ai.body': 'Use the CLI or MCP.',
        'lp.ai.cta': 'Connect your AI',
        'lp.access.title': 'Start with Free—no credit card required.',
        'lp.access.body': 'Choose a sharing scope and plan.',
        'lp.access.startCta': 'Start with Free',
        'lp.access.startMethods':
          'Choose one of three ways to get started: browser, CLI, or MCP.',
        'lp.access.pricingCta': 'Compare plans',
        'footer.about': 'About Artifact Share',
        'footer.operatedBy': 'Operated by',
        'footer.operatorName': 'TechTalk, Inc.',
        'lp.connect.mcpLink': 'MCP guide',
        'lp.connect.cliLink': 'CLI guide',
        'lp.pricing': 'Pricing',
        'lp.privacy': 'Privacy',
        'lp.terms': 'Terms',
        'lp.tokushoho': 'Commercial Disclosure',
        'signin.ms.cta': 'Sign in with Microsoft',
        'signin.email.toggle': 'Sign in with email',
      })[key] ?? key,
  }),
}))

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode
    to: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    new URLSearchParams(searchParams.next ? { next: searchParams.next } : {}),
  ],
  useRouteLoaderData: () => rootData,
  useLocation: () => ({ pathname: '/', search: '', hash: '' }),
  useFetcher: () => ({ formData: undefined, submit: () => {} }),
}))

vi.mock('~/components/app/google-mark', () => ({
  GoogleMark: () => <span>Google</span>,
}))

vi.mock('~/components/app/microsoft-mark', () => ({
  MicrosoftMark: () => <span>Microsoft</span>,
}))

vi.mock('~/lib/auth-client', () => ({
  signIn: { social: vi.fn() },
}))

function renderLanding(regression?: {
  agentEntryOpen?: boolean
  eagerProductImages?: boolean
}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Landing regression={regression} />
    </TooltipProvider>,
  )
}

describe('Landing', () => {
  test('shows the human hero copy and the AI entry disclosure', () => {
    searchParams.next = null
    rootData.maintenance = false
    const html = renderLanding()

    expect(html).toContain('Share HTML files inside your organization.')
    expect(html).toContain('Use it with AI')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('href="/share-with-ai"')
    expect(html).toContain('href="/connect"')
    expect(html).toContain('href="/pricing"')
    expect(html).toContain(
      'Turn HTML and Markdown made with AI into links that open in a browser.',
    )
    expect(html).toContain('What you can do with Artifact Share')
    expect(html).toContain('href="#landing-flow"')
    expect(html).toContain('id="landing-flow"')
    expect(html).toContain(
      'One flow from publishing work made with AI to updating it at the same URL.',
    )
    expect(html).toContain('Comment at the relevant place on the shared page')
    expect(html).toContain(
      'Publish HTML, Markdown, a folder, or a static site from AI or your browser',
    )
    expect(html).not.toContain('lp.definition')
    expect(html).not.toContain('CLI and MCP supported environments.')
    expect(html).toMatch(
      /<a\b(?=[^>]*\bhref="\/start")(?![^>]*\bdata-slot="button")[^>]*>[\s\S]*?Start with Free[\s\S]*?<\/a>/,
    )
    expect(html).not.toMatch(
      /<a\b(?=[^>]*\bhref="\/start")(?=[^>]*\bdata-slot="button")/,
    )
    expect(html).toContain(
      'Choose one of three ways to get started: browser, CLI, or MCP.',
    )
    expect(html).toContain('Compare plans')
    expect(html).toContain('research-review.webp')
    expect(html).toContain('flow-publish-share.webp')
    expect(html).toContain('flow-comment.webp')
    expect(html).toContain('flow-update.webp')
    expect(html).toContain(
      'alt="A simplified interface showing work from AI or the browser becoming a browser page and link, with controls for who can view it."',
    )
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toMatch(/flow-(publish-share|comment|update)\.webp/g)
    expect(
      html.match(/flow-(publish-share|comment|update)\.webp/g),
    ).toHaveLength(3)
    expect(html).not.toContain('Carry meeting notes into later work.')
    expect(html).toContain('data-slot="public-footer" data-variant="full"')
    expect(html).toContain('About Artifact Share')
    expect(html).toContain('Operated by')
    expect(html).toContain('TechTalk, Inc.')
    expect(html).toContain('href="https://www.techtalk.jp"')
    expect(html).not.toContain('Official information about Artifact Share')
    expect(html).toContain('pb-24')
    expect(html).not.toContain('href="/use-cases/')
  })

  test('keeps the scroll cue space while hiding it when the AI entry is open', () => {
    const html = renderLanding({ agentEntryOpen: true })

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('href="#landing-flow"')
    expect(html).toContain('pointer-events-none invisible')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('id="landing-flow"')
  })

  test('loads product images eagerly only in the regression fixture', () => {
    const html = renderLanding({ eagerProductImages: true })

    expect(html.match(/loading="eager"/g)).toHaveLength(6)
    expect(html).not.toContain('loading="lazy"')
  })

  test('keeps invite mode focused on sign-in without the AI entry disclosure', () => {
    searchParams.next = '/a/demo'
    rootData.maintenance = false
    const html = renderLanding()

    expect(html).toContain('Sign in to view this file')
    expect(html).not.toContain('Use it with AI')
    expect(html).not.toContain('href="/share-with-ai"')
    expect(html).not.toContain('research-review.webp')
    expect(html).not.toContain('flow-publish-share.webp')
    expect(html).not.toContain('#landing-flow')
    expect(html).not.toContain('What you can do with Artifact Share')
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
    expect(html).not.toContain('pb-24')
  })

  test('explains that sign-in is unavailable during maintenance', () => {
    searchParams.next = null
    rootData.maintenance = true
    const html = renderLanding()

    expect(html).toContain('Artifact Share is under maintenance.')
    expect(html).toContain('disabled=""')
  })
})
