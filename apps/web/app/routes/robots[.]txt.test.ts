import { describe, expect, test } from 'vitest'

import { loader } from './robots[.]txt'

interface Group {
  userAgent: string
  rules: string[]
}

function parseGroups(body: string): Group[] {
  return body
    .trim()
    .split(/\n\s*\n/)
    .filter((group) => group.startsWith('User-agent:'))
    .map((group) => {
      const [userAgent, ...rules] = group.split('\n')
      return { userAgent: userAgent!.slice('User-agent: '.length), rules }
    })
}

describe('/robots.txt route', () => {
  test('lets search crawlers read marketing pages and keeps app surfaces out', async () => {
    const groups = parseGroups(await loader().text())
    const rules = [
      'Allow: /',
      'Disallow: /connect/slack',
      'Disallow: /consent',
      'Disallow: /integrations',
      'Disallow: /projects',
      'Disallow: /recent',
      'Disallow: /settings',
      'Disallow: /sign-in',
    ]

    for (const userAgent of ['OAI-SearchBot', '*']) {
      const group = groups.find((entry) => entry.userAgent === userAgent)
      expect([...(group?.rules ?? [])].sort(), userAgent).toEqual(rules)
    }
  })

  test('blocks GPTBot at the origin and has no ChatGPT-User group', async () => {
    const response = loader()
    const body = await response.text()
    const groups = parseGroups(body)

    expect(groups).toContainEqual({
      userAgent: 'GPTBot',
      rules: ['Disallow: /'],
    })
    expect(body).not.toContain('ChatGPT-User')
    expect(body).not.toContain('Disallow: /a/')
  })

  test('keeps the sitemap directive and response headers', async () => {
    const response = loader()

    expect(response.headers.get('Content-Type')).toBe(
      'text/plain; charset=utf-8',
    )
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(await response.text()).toContain(
      'Sitemap: https://artifactshare.com/sitemap.xml',
    )
  })
})

test('exposes only a comment breadcrumb, with no crawl rule', async () => {
  const body = await loader().text()
  expect(
    body.split('\n').filter((line) => line.includes('credential-inventory')),
  ).toEqual([
    '# Legacy credential inventory: POST /api/internal/credential-inventory with X-ArtifactShare-Inventory: inspect',
  ])
})
