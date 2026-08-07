// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAnalyticsRuntimeState } from '~/lib/analytics/track.client'
import { AnalyticsSignupTracker } from './analytics-signup-tracker'

describe('AnalyticsSignupTracker', () => {
  let root: Root
  let container: HTMLDivElement
  let gtag: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-TEST',
    })
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

  function Stub(
    signup: Parameters<typeof AnalyticsSignupTracker>[0]['signup'],
  ) {
    return createRoutesStub([
      {
        path: '/',
        Component: () => <AnalyticsSignupTracker signup={signup} />,
      },
      {
        path: '/set-analytics-tracked',
        action: () => null,
        Component: () => null,
      },
    ])
  }

  async function render(
    signup: Parameters<typeof AnalyticsSignupTracker>[0]['signup'],
  ) {
    const Routes = Stub(signup)
    await React.act(async () => root.render(<Routes initialEntries={['/']} />))
  }

  it('does not send without signup data', async () => {
    await render(null)
    expect(gtag).not.toHaveBeenCalled()
  })

  it('sends sign_up but not workspace_created when needed', async () => {
    await render({ method: 'email', workspaceCreated: false, firstTouch: null })
    expect(gtag).toHaveBeenCalledWith('event', 'sign_up', { method: 'email' })
    expect(gtag).not.toHaveBeenCalledWith(
      'event',
      'workspace_created',
      expect.anything(),
    )
  })

  it('sends both events with first-touch parameters', async () => {
    await render({
      method: 'google',
      workspaceCreated: true,
      firstTouch: { utm: { utm_source: 'x' }, artifactId: 'a1' },
    })
    const expected = expect.objectContaining({
      method: 'google',
      utm_source: 'x',
      artifact_id: 'a1',
    })
    expect(gtag).toHaveBeenCalledWith('event', 'sign_up', expected)
    expect(gtag).toHaveBeenCalledWith('event', 'workspace_created', expected)
  })

  it('does not resend the same signup', async () => {
    const signup = {
      method: 'email' as const,
      workspaceCreated: false,
      firstTouch: null,
    }
    const Routes = Stub(signup)
    await React.act(async () => root.render(<Routes initialEntries={['/']} />))
    await React.act(async () => root.render(<Routes initialEntries={['/']} />))
    expect(gtag).toHaveBeenCalledTimes(1)
  })
})
