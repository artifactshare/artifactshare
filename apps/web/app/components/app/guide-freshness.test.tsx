import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { GuideFreshness, GuideHtmlWithFreshness } from './guide-freshness'
import {
  getPublicGuideVerifiedDate,
  PUBLIC_GUIDE_KEYS,
  PUBLIC_GUIDE_VERIFIED_DATES,
} from '~/lib/public-guide-freshness'

describe('GuideFreshness', () => {
  test('keeps an independent verified date for each public guide', () => {
    expect(PUBLIC_GUIDE_VERIFIED_DATES).toEqual({
      connect: '2026-07-18',
      'workspace-owner': '2026-07-18',
      'workspace-admin': '2026-07-18',
      'link-sharing': '2026-07-21',
      'private-mobile-design-handoff': '2026-07-21',
    })
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
    ).toContain('Last verified: 2026-07-18 · Target UI: ChatGPT Web')
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
    ).toContain('最終確認日: 2026-07-18')
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
