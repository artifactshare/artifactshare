import { describe, expect, test } from 'vitest'

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
    copy: {
      en: {
        title: 'Privacy Policy · Artifact Share',
        description:
          'How Artifact Share collects, uses, and protects your data.',
      },
      ja: {
        title: 'プライバシーポリシー · Artifact Share',
        description:
          'Artifact Share が個人情報をどのように収集、利用、保護するか。',
      },
    },
  },
  {
    name: 'terms',
    loader: termsLoader,
    meta: termsMeta,
    html: termsHtml,
    copy: {
      en: {
        title: 'Terms of Service · Artifact Share',
        description:
          'Terms of Service for Artifact Share — acceptable use, your content, takedown procedures, and limitations of liability.',
      },
      ja: {
        title: '利用規約 · Artifact Share',
        description:
          'Artifact Share の利用規約 — 許容される利用、コンテンツの扱い、削除手続き、責任の制限。',
      },
    },
  },
  {
    name: 'tokushoho',
    loader: tokushohoLoader,
    meta: tokushohoMeta,
    html: tokushohoHtml,
    copy: {
      en: {
        title: 'Commercial Disclosure · Artifact Share',
        description:
          'Legally required disclosure under the Japanese Specified Commercial Transactions Act.',
      },
      ja: {
        title: '特定商取引法に基づく表記 · Artifact Share',
        description: '特定商取引法に基づく販売事業者情報の開示。',
      },
    },
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
    expect(en.html).not.toBe(ja.html)
  })

  test.each(routes)(
    '$name preserves title, description, and social metadata',
    (route) => {
      for (const locale of ['en', 'ja'] as const) {
        const tags = route.meta({
          loaderData: route.loader({
            params: locale === 'ja' ? { locale } : {},
          } as never),
        } as never)
        const pageCanonical = canonical(route.name, locale)
        const expected = route.copy[locale]

        expect(tags).toContainEqual({ title: expected.title })
        expect(tags).toContainEqual({
          name: 'description',
          content: expected.description,
        })
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
        expect(tags).toContainEqual({
          property: 'og:title',
          content: expected.title,
        })
        expect(tags).toContainEqual({
          property: 'og:description',
          content: expected.description,
        })
        expect(tags).toContainEqual({
          name: 'twitter:title',
          content: expected.title,
        })
        expect(tags).toContainEqual({
          name: 'twitter:description',
          content: expected.description,
        })
        expect(tags).toContainEqual({
          name: 'twitter:image',
          content: 'https://artifactshare.com/og-image',
        })
      }
    },
  )
})
