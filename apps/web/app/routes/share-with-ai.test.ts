import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import {
  loader,
  shareWithAiMeta,
  SHARE_WITH_AI_EN_PATH,
  SHARE_WITH_AI_JA_PATH,
} from './share-with-ai'
import { loader as jaLoader } from './ja.share-with-ai'
import { shareWithAiContent } from '~/lib/share-with-ai-content'
import { withLang } from '~/lib/connect-link'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) =>
      createElement('a', { href: to, ...props }, children),
  }
})

vi.mock('~/components/app/guide-shell', () => ({
  GuideHomeLink: ({ homeLabel }: { homeLabel: string }) =>
    createElement('span', null, homeLabel),
  GuideMain: ({ children }: { children: ReactNode }) =>
    createElement('main', null, children),
  GuideProse: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  GuideShell: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  GuideTopbar: ({ children }: { children: ReactNode }) =>
    createElement('header', null, children),
}))

vi.mock('~/components/app/guide-toc', () => ({
  GuideRail: () => null,
  GuideTocMobile: () => null,
}))

vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: () => createElement('footer'),
}))

vi.mock('~/components/app/copyable-code-block', () => ({
  CopyableCodeBlock: ({ code }: { code: string }) =>
    createElement('pre', null, code),
}))

import { ShareWithAiPage } from './share-with-ai'

describe('/share-with-ai route metadata', () => {
  test('uses language-specific canonical and hreflang links', () => {
    const en = shareWithAiMeta('en')
    const ja = shareWithAiMeta('ja')

    expect(en).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/share-with-ai',
    })
    expect(ja).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/ja/share-with-ai',
    })
    for (const tags of [en, ja]) {
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/share-with-ai',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: 'https://artifactshare.com/ja/share-with-ai',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'x-default',
        href: 'https://artifactshare.com/share-with-ai',
      })
    }
  })
})

describe('/share-with-ai loaders return fixed locale', () => {
  test('English loader returns en', () => {
    expect(loader()).toEqual({ locale: 'en' })
  })

  test('Japanese loader returns ja', () => {
    expect(jaLoader()).toEqual({ locale: 'ja' })
  })
})

describe('share-with-ai content', () => {
  test('server-renders the task section without Slot errors', () => {
    const html = renderToStaticMarkup(
      createElement(ShareWithAiPage, { locale: 'en' }),
    )

    expect(html).toContain('<section')
    expect(html).toContain('aria-labelledby="share-with-ai-tasks-heading"')
    expect(html).toContain('data-toc-section=""')
  })

  test('shows Japanese as upload shorthand as an Artifact Share prompt', () => {
    const content = shareWithAiContent('ja')
    expect(content.tasksIntro).toContain('as で共有して')
    expect(content.tasks.find((task) => task.id === 'share')?.ask).toBe(
      'このレポートを as で共有して。',
    )
  })

  test('limits the English as alias to sharing-related requests', () => {
    const content = shareWithAiContent('en')
    expect(content.tasksIntro).toMatch(/when the request is about sharing/)
  })

  test('links to the CLI reference in each locale', () => {
    const enLink = shareWithAiContent('en').nextConnectLinks.find(
      (link) => link.path === '/guides/cli',
    )
    const jaLink = shareWithAiContent('ja').nextConnectLinks.find(
      (link) => link.path === '/guides/cli',
    )
    expect(enLink).toEqual(expect.objectContaining({ path: '/guides/cli' }))
    expect(jaLink).toEqual(expect.objectContaining({ path: '/guides/cli' }))
    expect(withLang(enLink!.path!, 'en')).toBe('/guides/cli')
    expect(withLang(jaLink!.path!, 'ja')).toBe('/ja/guides/cli')
    expect(shareWithAiContent('en').nextConnectLinks).toContainEqual(
      expect.objectContaining({ path: '/guides/link-sharing' }),
    )
    expect(shareWithAiContent('ja').nextConnectLinks).toContainEqual(
      expect.objectContaining({ path: '/guides/link-sharing' }),
    )
  })
})
