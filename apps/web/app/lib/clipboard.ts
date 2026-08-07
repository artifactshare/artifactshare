import { toast } from 'sonner'
import type { Translator } from '~/lib/i18n'

/**
 * Copy a share URL to the clipboard and surface the appropriate toast.
 * Falls back to showing the URL inline when the Clipboard API is denied
 * (e.g. inside a sandboxed iframe or insecure origin).
 */
export async function copyShareUrl(
  url: string,
  translator: Translator,
): Promise<void> {
  const copied = await writeClipboardText(url)
  if (copied) {
    toast(translator.t('toast.copiedPasteAnywhere'))
  } else {
    toast(translator.t('toast.copied', { url }))
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
