import { APEX_HOST } from '~/lib/hosts'

// Marketing pages (/, /about, /connect, /privacy, /terms) stay crawlable; app
export const NON_PUBLIC_DISALLOW_PATHS = [
  '/sign-in',
  '/consent',
  '/settings',
  '/projects',
  '/recent',
  '/integrations',
  '/connect/slack',
]

function allowedCrawlerGroup(userAgent: string): string[] {
  return [
    `User-agent: ${userAgent}`,
    'Allow: /',
    ...NON_PUBLIC_DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
  ]
}

export function loader() {
  return new Response(
    [
      ...allowedCrawlerGroup('OAI-SearchBot'),
      '',
      ...allowedCrawlerGroup('*'),
      '',
      'User-agent: GPTBot',
      'Disallow: /',
      '',
      '# Legacy credential inventory: POST /api/internal/credential-inventory with X-ArtifactShare-Inventory: inspect',
      `Sitemap: https://${APEX_HOST}/sitemap.xml`,
      '',
    ].join('\n'),
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
