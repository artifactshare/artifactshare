import { describe, expect, test } from 'vitest'

import { expectLocalePair } from '~/test/locale-documents'
import {
  loader as privacyLoader,
  meta as privacyMeta,
} from './_public/($locale)/privacy'
import {
  loader as termsLoader,
  meta as termsMeta,
} from './_public/($locale)/terms'
import {
  loader as tokushohoLoader,
  meta as tokushohoMeta,
} from './_public/($locale)/tokushoho'
import {
  privacyHtml,
  termsHtml,
  tokushohoHtml,
} from '~/services/legal-content.server'

const routes = [
  {
    name: 'privacy',
    loader: privacyLoader,
    meta: privacyMeta,
    html: privacyHtml,
  },
  {
    name: 'terms',
    loader: termsLoader,
    meta: termsMeta,
    html: termsHtml,
  },
  {
    name: 'tokushoho',
    loader: tokushohoLoader,
    meta: tokushohoMeta,
    html: tokushohoHtml,
  },
] as const

const canonical = (name: string, locale: 'en' | 'ja') =>
  `https://artifactshare.com${locale === 'ja' ? '/ja' : ''}/${name}`

describe('locale-aware legal routes', () => {
  test.each(routes)('$name preserves locale-specific legal HTML', (route) => {
    const en = route.loader({ params: {} } as never)
    const ja = route.loader({ params: { locale: 'ja' } } as never)

    expect(en).toEqual({ locale: 'en', html: route.html('en') })
    expect(ja).toEqual({ locale: 'ja', html: route.html('ja') })
    expectLocalePair(en.html, ja.html)
  })

  test.each(routes)(
    '$name mirrors its title and description into the social metadata',
    (route) => {
      const seen: { title: string; description: string }[] = []
      for (const locale of ['en', 'ja'] as const) {
        const tags = route.meta({
          loaderData: route.loader({
            params: locale === 'ja' ? { locale } : {},
          } as never),
        } as never) as Record<string, string | undefined>[]
        const pageCanonical = canonical(route.name, locale)
        const title = tags.find((tag) => 'title' in tag)?.title ?? ''
        const description =
          tags.find((tag) => tag.name === 'description')?.content ?? ''
        expect(title).not.toBe('')
        expect(description).not.toBe('')
        seen.push({ title, description })

        expect(tags).toContainEqual({
          tagName: 'link',
          rel: 'canonical',
          href: pageCanonical,
        })
        expect(tags).toContainEqual({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'en',
          href: canonical(route.name, 'en'),
        })
        expect(tags).toContainEqual({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'ja',
          href: canonical(route.name, 'ja'),
        })
        expect(tags).toContainEqual({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'x-default',
          href: canonical(route.name, 'en'),
        })
        expect(tags).toContainEqual({
          property: 'og:url',
          content: pageCanonical,
        })
        expect(tags).toContainEqual({ property: 'og:title', content: title })
        expect(tags).toContainEqual({
          property: 'og:description',
          content: description,
        })
        expect(tags).toContainEqual({ name: 'twitter:title', content: title })
        expect(tags).toContainEqual({
          name: 'twitter:description',
          content: description,
        })
        expect(tags).toContainEqual({
          name: 'twitter:image',
          content: 'https://artifactshare.com/og-image',
        })
      }
      // Each locale publishes its own wording.
      expect(seen[1].title).not.toBe(seen[0].title)
      expect(seen[1].description).not.toBe(seen[0].description)
    },
  )
})
