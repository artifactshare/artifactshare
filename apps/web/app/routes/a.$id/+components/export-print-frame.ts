import type { InertExportDocument } from './export-resources'

type PrintRelayScript = HTMLScriptElement & {
  printRelay?: { sender: Window; frame: HTMLIFrameElement; channel: string }
}

// Executed as a script in the popup, so postMessage's incumbent Window is
// the frame's actual parent. Calling a popup method from the app is not enough.
function printPopupRelay() {
  const script = document.currentScript as PrintRelayScript
  const { sender, frame, channel } = script.printRelay!
  delete script.printRelay
  const origin = sender.location.origin
  let sequence = 0
  const receive = (event: MessageEvent) => {
    if (
      event.source !== sender ||
      event.origin !== origin ||
      event.data?.channel !== channel ||
      event.data?.kind !== 'measure' ||
      !Number.isSafeInteger(event.data.sequence) ||
      event.data.sequence !== sequence + 1
    )
      return
    sequence = event.data.sequence
    frame.contentWindow?.postMessage(
      { kind: 'measure', channel, sequence },
      '*',
    )
  }
  const dispose = () => {
    window.removeEventListener('message', receive)
    window.removeEventListener('pagehide', dispose)
    script.removeEventListener('dispose', dispose)
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', dispose, { once: true })
  script.addEventListener('dispose', dispose, { once: true })
}

export function installPrintRelay(
  doc: Document,
  frame: HTMLIFrameElement,
  channel: string,
) {
  const script = doc.createElement('script') as PrintRelayScript
  script.printRelay = { sender: window, frame, channel }
  script.textContent = `(${printPopupRelay.toString()})()`
  doc.head.appendChild(script)
  return () => {
    script.dispatchEvent(new Event('dispose'))
    script.remove()
  }
}

// This function is serialized into an opaque frame. It has no application
// capabilities and receives only a channel and a monotonic measurement sequence.
export function printFrameHelper(channel: string, parentOrigin: string) {
  // A fixed initial containing block prevents percentage-height layouts from
  // growing again whenever the parent expands the frame to fit their overflow.
  document.documentElement.style.setProperty('height', '760px', 'important')
  const vertical = /^(vertical|sideways)/.test(
    getComputedStyle(document.documentElement).writingMode,
  )
  document.documentElement.style.setProperty(
    '--artifactshare-print-vb',
    vertical ? '9px' : '7.6px',
    'important',
  )
  document.documentElement.style.setProperty(
    '--artifactshare-print-vi',
    vertical ? '7.6px' : '9px',
    'important',
  )
  let sequence = 0
  const layout = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      event.data?.channel !== channel ||
      event.data?.kind !== 'measure' ||
      !Number.isSafeInteger(event.data.sequence) ||
      event.data.sequence <= sequence
    )
      return
    sequence = event.data.sequence
    const current = sequence
    void (async () => {
      // Flush viewport-dependent styles so newly displayed text starts its
      // font loads before waiting for readiness on every sizing pass.
      await layout()
      await Promise.all(
        Array.from(document.images).map((image) => image.decode()),
      )
      await document.fonts.ready
      if (Array.from(document.fonts).some((font) => font.status === 'error'))
        throw new Error('Font unavailable')
      await layout()
      let bottom = 0
      for (const element of document.body.querySelectorAll('*')) {
        if (getComputedStyle(element).position !== 'fixed')
          bottom = Math.max(
            bottom,
            element.getBoundingClientRect().bottom + scrollY,
          )
      }
      const height = Math.ceil(
        Math.max(
          bottom,
          document.body.scrollHeight,
          document.body.offsetHeight,
        ),
      )
      parent.postMessage(
        { channel, sequence: current, kind: 'measured', height },
        '*',
      )
    })().catch(() =>
      parent.postMessage({ channel, sequence: current, kind: 'failed' }, '*'),
    )
  })
  parent.postMessage({ channel, sequence: 0, kind: 'ready' }, '*')
}

export function isolatedPrintHtml(
  doc: InertExportDocument,
  channel: string,
): string {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = policy
  doc.head.insertBefore(meta, doc.head.firstChild)
  // Nonce hiding can clear the content attribute when a script is inserted.
  // Serialize the trusted script explicitly so its nonce survives outerHTML.
  const code = `(${printFrameHelper.toString()})(${JSON.stringify(channel)},${JSON.stringify(window.location.origin)})`
  const html = doc.documentElement.outerHTML
  const end = html.lastIndexOf('</body>')
  return `<!doctype html>${html.slice(0, end)}<script nonce="${nonce}">${code}</script>${html.slice(end)}`
}
