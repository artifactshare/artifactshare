// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRoutesStub, Outlet } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAnalyticsRuntimeState } from '~/lib/analytics/track.client'
import { ArtifactViewTracker } from './artifact-view-tracker'

describe('ArtifactViewTracker', () => {
  let root: Root
  let container: HTMLDivElement
  let gtag: ReturnType<typeof vi.fn>

  beforeEach(() => {
    gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: null,
    })
  })

  function renderTracker(
    props: { artifactId: string; canTrackView: boolean },
    consent: { shouldLoad: boolean; measurementId: string | null } = {
      shouldLoad: true,
      measurementId: 'G-TEST',
    },
  ) {
    // AnalyticsGtag owns the sender runtime and initializes it before passive
    // tracker effects. This unit test supplies that already-resolved state.
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: consent.shouldLoad,
      measurementId: consent.measurementId,
    })
    // `a/:id` must nest under the `root` route so its loader runs and
    // useRouteLoaderData('root') resolves for the tracker (siblings would not
    // match the same URL).
    const Stub = createRoutesStub([
      {
        id: 'root',
        path: '/',
        loader: () => ({
          analyticsConsent: { shouldLoadAnalytics: consent.shouldLoad },
          analyticsMeasurementId: consent.measurementId,
        }),
        Component: () => <Outlet />,
        children: [
          {
            path: 'a/:id',
            Component: () => (
              <ArtifactViewTracker
                {...props}
                renderType="html"
                visibility="link"
                viewerState="anonymous"
              />
            ),
          },
        ],
      },
    ])
    return React.act(async () => {
      root.render(
        <Stub initialEntries={[`/a/${props.artifactId}?utm_source=test`]} />,
      )
    })
  }

  it('does not send when viewing is excluded', async () => {
    await renderTracker({
      artifactId: 'excluded-artifact',
      canTrackView: false,
    })
    expect(gtag).not.toHaveBeenCalledWith(
      'event',
      'artifact_view',
      expect.anything(),
    )
  })

  it('does not send when consent is not granted', async () => {
    await renderTracker(
      { artifactId: 'no-consent-artifact', canTrackView: true },
      { shouldLoad: false, measurementId: 'G-TEST' },
    )
    expect(gtag).not.toHaveBeenCalledWith(
      'event',
      'artifact_view',
      expect.anything(),
    )
  })

  it('sends an html artifact view once after runtime initialization', async () => {
    await renderTracker({ artifactId: 'tracked-artifact', canTrackView: true })
    expect(gtag).toHaveBeenCalledTimes(1)
    expect(gtag).toHaveBeenCalledWith(
      'event',
      'artifact_view',
      expect.objectContaining({
        artifact_id: 'tracked-artifact',
        render_type: 'html',
        visibility: 'link',
        viewer_state: 'anonymous',
        utm_source: 'test',
      }),
    )
  })

  it('deduplicates the same artifact and location', async () => {
    const props = { artifactId: 'dedup-artifact', canTrackView: true }
    await renderTracker(props)
    await React.act(async () => root.render(<div />))
    await React.act(async () => root.render(<div />))
    expect(gtag).toHaveBeenCalledTimes(1)
  })
})
