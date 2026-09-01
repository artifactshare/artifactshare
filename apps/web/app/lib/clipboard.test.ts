// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import { setAnalyticsRuntimeState } from './analytics/track.client'
import { copyShareUrl } from './clipboard'

const toastMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: toastMock }))

const translator = bindI18n('en')
const shareUrl = 'https://example.com/shared/file'

describe('copyShareUrl analytics', () => {
  const writeText = vi.fn()
  const execCommand = vi.fn()
  const gtag = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    Object.defineProperty(window, 'gtag', {
      configurable: true,
      value: gtag,
    })
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-TEST',
    })
  })

  afterEach(() => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: null,
    })
  })

  test('records success when the Clipboard API writes the URL', async () => {
    writeText.mockResolvedValue(undefined)

    await copyShareUrl(shareUrl, translator)

    expect(execCommand).not.toHaveBeenCalled()
    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'copy_link_succeeded', {})
    expect(toastMock).toHaveBeenCalledWith('Copied · paste anywhere')
  })

  test('records success when the legacy fallback copies the URL', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(true)

    await copyShareUrl(shareUrl, translator)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'copy_link_succeeded', {})
  })

  test('records failure only when both copy methods fail', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(false)

    await copyShareUrl(shareUrl, translator)

    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'copy_link_failed', {})
    expect(toastMock).toHaveBeenCalledWith(
      `Couldn't copy · copy this link manually: ${shareUrl}`,
    )
  })

  test('records failure without changing a thrown fallback error', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockImplementation(() => {
      throw new Error('copy command unavailable')
    })

    await expect(copyShareUrl(shareUrl, translator)).rejects.toThrow(
      'copy command unavailable',
    )

    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'copy_link_failed', {})
    expect(toastMock).not.toHaveBeenCalled()
  })

  test('does not record a result without analytics consent', async () => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: 'G-TEST',
    })
    writeText.mockResolvedValue(undefined)

    await copyShareUrl(shareUrl, translator)

    expect(gtag).not.toHaveBeenCalled()
  })
})
