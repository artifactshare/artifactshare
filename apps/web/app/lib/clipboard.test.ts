// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import { setAnalyticsRuntimeState } from './analytics/track.client'
import { copyShareUrl, writeClipboardText } from './clipboard'

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    getToasts: vi.fn<() => Array<{ id: string | number; action?: unknown }>>(
      () => [],
    ),
  }),
)

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
    vi.restoreAllMocks()
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
    expect(toastMock.dismiss).toHaveBeenCalledWith(
      `copy-share-url-failed:${shareUrl}`,
    )
  })

  test('removes the fallback textarea when text selection throws', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(() => {
      throw new Error('selection denied')
    })
    const before = document.querySelectorAll('textarea').length

    await expect(writeClipboardText(shareUrl)).rejects.toThrow(
      'selection denied',
    )

    expect(document.querySelectorAll('textarea')).toHaveLength(before)
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
    expect(toastMock.error).toHaveBeenCalledWith(
      `Couldn't copy · copy this link manually\n${shareUrl}`,
      expect.objectContaining({
        duration: Infinity,
        closeButton: true,
        className:
          'select-text [&_[data-title]]:whitespace-pre-line [&_[data-title]]:wrap-anywhere',
      }),
    )
    expect(toastMock.error.mock.calls[0]?.[1].action).toBeUndefined()
  })

  test('turns a thrown fallback error into the same manual-copy recovery', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockImplementation(() => {
      throw new Error('copy command unavailable')
    })

    await copyShareUrl(shareUrl, translator)

    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'copy_link_failed', {})
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining(shareUrl),
      expect.objectContaining({ duration: Infinity, closeButton: true }),
    )
  })

  test('offers a permitted sharing action without dismissing the original URL', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(false)
    const onOpenSharing = vi.fn()

    await copyShareUrl(shareUrl, translator, { onOpenSharing })

    const [message, options] = toastMock.error.mock.calls[0] ?? []
    expect(message).toContain(shareUrl)
    expect(options.action.label).toBe('Open sharing settings')
    const preventDefault = vi.fn()
    options.action.onClick({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onOpenSharing).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledOnce()
  })

  test('uses one stable toast per failed URL while preserving different targets', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(false)

    await copyShareUrl(shareUrl, translator)
    await copyShareUrl(shareUrl, translator)
    await copyShareUrl(`${shareUrl}/history`, translator)

    const toastIds = toastMock.error.mock.calls.map((call) => call[1].id)
    expect(toastIds[0]).toBe(toastIds[1])
    expect(toastIds[2]).not.toBe(toastIds[0])
  })

  test('dismisses the persistent failure after a successful retry', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    execCommand.mockReturnValueOnce(false)
    await copyShareUrl(shareUrl, translator)
    expect(toastMock.error).toHaveBeenCalledOnce()

    writeText.mockResolvedValueOnce(undefined)
    await copyShareUrl(shareUrl, translator)

    expect(toastMock.dismiss).toHaveBeenLastCalledWith(
      `copy-share-url-failed:${shareUrl}`,
    )
    expect(toastMock).toHaveBeenLastCalledWith('Copied · paste anywhere')
  })

  test('an old caller abort cannot remove a newer same-URL action', async () => {
    writeText.mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(false)
    const oldController = new AbortController()
    const newController = new AbortController()

    await copyShareUrl(shareUrl, translator, {
      onOpenSharing: vi.fn(),
      sharingActionSignal: oldController.signal,
    })
    const oldOptions = toastMock.error.mock.calls.at(-1)?.[1]
    await copyShareUrl(shareUrl, translator, {
      onOpenSharing: vi.fn(),
      sharingActionSignal: newController.signal,
    })
    const newOptions = toastMock.error.mock.calls.at(-1)?.[1]
    toastMock.getToasts.mockReturnValue([
      { id: newOptions.id, action: newOptions.action },
    ])

    oldController.abort()
    expect(toastMock.error).toHaveBeenCalledTimes(2)

    newController.abort()
    expect(toastMock.error).toHaveBeenCalledTimes(3)
    expect(toastMock.error.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ id: newOptions.id, action: undefined }),
    )
    expect(oldOptions.action).not.toBe(newOptions.action)
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

  test('a paused link copies but warns instead of confirming', async () => {
    writeText.mockResolvedValue(undefined)
    await copyShareUrl(shareUrl, translator, { paused: true })
    expect(writeText).toHaveBeenCalledWith(shareUrl)
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringContaining('link sharing is paused'),
    )
    expect(toastMock).not.toHaveBeenCalledWith('Copied · paste anywhere')
  })
})
