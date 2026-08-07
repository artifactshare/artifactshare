import { describe, expect, test } from 'vitest'

import { loader, NON_PUBLIC_DISALLOW_PATHS } from './robots[.]txt'

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
  test('applies the shared non-public disallow list to both crawl groups', async () => {
    const response = loader()
    const body = await response.text()
    const groups = parseGroups(body)
    const oai = groups.find((group) => group.userAgent === 'OAI-SearchBot')
    const generic = groups.find((group) => group.userAgent === '*')

    expect(oai).toEqual({
      userAgent: 'OAI-SearchBot',
      rules: [
        'Allow: /',
        ...NON_PUBLIC_DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
      ],
    })
    expect(generic).toEqual({
      userAgent: '*',
      rules: [
        'Allow: /',
        ...NON_PUBLIC_DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
      ],
    })
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
