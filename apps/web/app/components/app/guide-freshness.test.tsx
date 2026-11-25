import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { GuideFreshness, GuideHtmlWithFreshness } from './guide-freshness'
import {
  getPublicGuideVerifiedDate,
  PUBLIC_GUIDE_KEYS,
  PUBLIC_GUIDE_VERIFIED_DATES,
} from '~/lib/public-guide-freshness'

describe('GuideFreshness', () => {
  test('keeps a verified date of its own for each public guide', () => {
    expect(Object.keys(PUBLIC_GUIDE_VERIFIED_DATES).sort()).toEqual(
      Object.values(PUBLIC_GUIDE_KEYS).sort(),
    )
    for (const key of Object.values(PUBLIC_GUIDE_KEYS))
      expect(getPublicGuideVerifiedDate(key), key).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      )
  })

  test('renders verified guide metadata in English and Japanese', () => {
    expect(
      renderToStaticMarkup(
        <GuideFreshness
          kind="verified"
          locale="en"
          verifiedDate={getPublicGuideVerifiedDate(PUBLIC_GUIDE_KEYS.connect)}
          targetUi="ChatGPT Web"
          note="Web only."
        />,
      ),
    ).toContain(
      `Last verified: ${getPublicGuideVerifiedDate(
        PUBLIC_GUIDE_KEYS.connect,
      )} · Target UI: ChatGPT Web`,
    )
    expect(
      renderToStaticMarkup(
        <GuideFreshness
          kind="verified"
          locale="en"
          verifiedDate={getPublicGuideVerifiedDate(
            PUBLIC_GUIDE_KEYS.workspaceOwner,
          )}
          note="Web only."
        />,
      ),
    ).toContain('<p>Web only.</p>')
    expect(
      renderToStaticMarkup(
        <GuideFreshness
          kind="verified"
          locale="ja"
          verifiedDate={getPublicGuideVerifiedDate(
            PUBLIC_GUIDE_KEYS.workspaceAdmin,
          )}
        />,
      ),
    ).toContain(
      `最終確認日: ${getPublicGuideVerifiedDate(
        PUBLIC_GUIDE_KEYS.workspaceAdmin,
      )}`,
    )
  })

  test('renders CLI metadata from supplied generated values', () => {
    const html = renderToStaticMarkup(
      <GuideFreshness
        kind="cli"
        locale="en"
        version="0.8.0"
        generatedDate="2026-07-19"
      />,
    )
    expect(html).toContain(
      'CLI version: @artifactshare/cli 0.8.0 · Generated: 2026-07-19',
    )
  })

  test('places freshness after the first guide heading', () => {
    const html = renderToStaticMarkup(
      <GuideHtmlWithFreshness
        html="<h1>Guide</h1><p>Body</p>"
        freshness={{
          kind: 'verified',
          locale: 'en',
          verifiedDate: getPublicGuideVerifiedDate(
            PUBLIC_GUIDE_KEYS.privateMobileDesignHandoff,
          ),
        }}
      />,
    )
    expect(html.indexOf('<h1>Guide</h1>')).toBeLessThan(
      html.indexOf('data-guide-freshness'),
    )
    expect(html.indexOf('data-guide-freshness')).toBeLessThan(
      html.indexOf('<p>Body</p>'),
    )
  })
})
