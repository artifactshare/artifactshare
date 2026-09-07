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
  options: { paused?: boolean; onOpenSharing?: () => void } = {},
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
    toast(translator.t('toast.copyFailedManual', { url }), {
      duration: Infinity,
      closeButton: true,
      className: 'select-text',
      ...(options.onOpenSharing
        ? {
            action: {
              label: translator.t('toast.openSharingSettings'),
              onClick: (event) => {
                event.preventDefault()
                options.onOpenSharing?.()
              },
            },
          }
        : {}),
    })
  }
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
