import { describe, expect, test } from 'vitest'
import { loader, meta } from './guides.cli'
import { loader as jaLoader, meta as jaMeta } from './ja.guides.cli'
import {
  CLI_REFERENCE_EN_CANONICAL,
  CLI_REFERENCE_JA_CANONICAL,
} from '~/lib/cli-reference-meta'

describe('CLI guide routes', () => {
  test('load their fixed locales', () => {
    expect(loader()).toEqual({ locale: 'en' })
    expect(jaLoader()).toEqual({ locale: 'ja' })
  })

  test('publish a canonical locale pair and social metadata', () => {
    const enTags = meta({ loaderData: { locale: 'en' } } as never)
    const jaTags = jaMeta({ loaderData: { locale: 'ja' } } as never)
    expect(enTags).toContainEqual(
      expect.objectContaining({
        tagName: 'link',
        rel: 'canonical',
        href: CLI_REFERENCE_EN_CANONICAL,
      }),
    )
    expect(jaTags).toContainEqual(
      expect.objectContaining({
        tagName: 'link',
        rel: 'canonical',
        href: CLI_REFERENCE_JA_CANONICAL,
      }),
    )
    for (const tags of [enTags, jaTags]) {
      expect(tags).toContainEqual(
        expect.objectContaining({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'x-default',
          href: CLI_REFERENCE_EN_CANONICAL,
        }),
      )
      expect(tags).toContainEqual(
        expect.objectContaining({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'en',
          href: CLI_REFERENCE_EN_CANONICAL,
        }),
      )
      expect(tags).toContainEqual(
        expect.objectContaining({
          tagName: 'link',
          rel: 'alternate',
          hrefLang: 'ja',
          href: CLI_REFERENCE_JA_CANONICAL,
        }),
      )
      expect(tags).toContainEqual(
        expect.objectContaining({ property: 'og:type', content: 'website' }),
      )
    }
  })
})
