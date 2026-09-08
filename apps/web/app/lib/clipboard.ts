import { toast } from 'sonner'
import { ANALYTICS_EVENTS } from '~/lib/analytics/events'
import { trackEvent } from '~/lib/analytics/track.client'
import type { Translator } from '~/lib/i18n'

/**
 * Copy a share URL to the clipboard and surface the appropriate toast.
 * Falls back to showing the URL inline when the Clipboard API is denied
 * (e.g. inside a sandboxed iframe or insecure origin).
 */
export async function copyShareUrl(
  url: string,
  translator: Translator,
  options: {
    paused?: boolean
    onOpenSharing?: () => void
    sharingActionSignal?: AbortSignal
  } = {},
): Promise<void> {
  let copied: boolean
  try {
    copied = await writeClipboardText(url)
  } catch {
    copied = false
  }
  if (copied) {
    trackEvent(ANALYTICS_EVENTS.copyLinkSucceeded)
    // A paused link copies fine but will not open for recipients; say so
    // where the owner is looking instead of only in the banner above.
    if (options.paused) toast.warning(translator.t('toast.copiedLinkPaused'))
    else toast(translator.t('toast.copiedPasteAnywhere'))
  } else {
    trackEvent(ANALYTICS_EVENTS.copyLinkFailed)
    showCopyFailureRecovery(url, translator, options)
  }
}

function showCopyFailureRecovery(
  url: string,
  translator: Translator,
  options: {
    onOpenSharing?: () => void
    sharingActionSignal?: AbortSignal
  },
) {
  const message = translator.t('toast.copyFailedManual', { url })
  const toastId = `copy-share-url-failed:${url}`
  const action =
    options.onOpenSharing && !options.sharingActionSignal?.aborted
      ? {
          label: translator.t('toast.openSharingSettings'),
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault()
            options.onOpenSharing?.()
          },
        }
      : undefined
  let removeAbortListener = () => {}
  const onDismiss = () => removeAbortListener()
  const renderRecovery = (currentAction: typeof action) =>
    toast(message, {
      id: toastId,
      duration: Infinity,
      closeButton: true,
      className:
        'select-text [&_[data-title]]:whitespace-pre-line [&_[data-title]]:wrap-anywhere',
      action: currentAction,
      onDismiss,
    })

  renderRecovery(action)
  if (!action || !options.sharingActionSignal) return

  const removeStaleAction = () => {
    const currentToast = toast
      .getToasts()
      .find((candidate) => candidate.id === toastId)
    if (
      !currentToast ||
      !('action' in currentToast) ||
      currentToast.action !== action
    )
      return
    renderRecovery(undefined)
  }
  options.sharingActionSignal.addEventListener('abort', removeStaleAction, {
    once: true,
  })
  removeAbortListener = () =>
    options.sharingActionSignal?.removeEventListener('abort', removeStaleAction)
  if (options.sharingActionSignal.aborted) removeStaleAction()
}

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return legacyCopy(text)
  }
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}
