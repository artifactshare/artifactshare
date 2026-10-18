import { sanitizeMermaidSvg } from './mermaid-render.client'

function resourceError(message: string) {
  const error = new Error(message)
  error.name = 'MermaidResourceError'
  return error
}

/** Mermaid creates temporary DOM (including image nodes) before returning SVG.
 * Run that work in an opaque, network-denied realm, never the app document. */
export async function renderExportMermaidSvg(
  source: string,
  signal: AbortSignal,
  acquireImage?: (ref: string) => Promise<string>,
): Promise<string> {
  signal.throwIfAborted()
  const bundle = await import('mermaid/dist/mermaid.min.js?raw').then(
    (module) => module.default,
    () => {
      throw resourceError('Mermaid bundle unavailable')
    },
  )
  signal.throwIfAborted()
  const channel = crypto.randomUUID()
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:900px;height:760px;visibility:hidden;pointer-events:none'
  const helper = `
    // Mermaid 12 imageSquare first assigns Image.src, awaits its load, then
    // assigns the same reference to SVG image.href. Acquire before either live
    // assignment; the realm itself retains no network permission.
    const images = new Map();
    const pendingImages = new Map();
    const imageReady = new WeakMap();
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function() {
      return (imageReady.get(this) || Promise.resolve()).then(() => decode.call(this));
    };
    let imageSequence = 0;
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(ref) {
        const sequence = ++imageSequence;
        imageReady.set(this, new Promise(resolve => {
          pendingImages.set(sequence, {image:this, resolve});
        }));
        parent.postMessage({channel:${JSON.stringify(channel)}, kind:'image', sequence, ref:String(ref)}, '*');
      }
    });
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.localName === 'image' && name === 'href') {
        if (images.has(String(value))) value = images.get(String(value));
        else if (![...images.values()].includes(String(value))) throw new Error('Unprepared Mermaid image');
      }
      return setAttribute.call(this, name, value);
    };
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.channel !== ${JSON.stringify(channel)} || event.data.kind !== 'image') return;
      const pending = pendingImages.get(event.data.sequence);
      if (!pending) return;
      pendingImages.delete(event.data.sequence);
      images.set(event.data.ref, event.data.uri);
      src.set.call(pending.image, event.data.uri);
      pending.resolve();
    });
    let networkBlocked = false;
    document.addEventListener('securitypolicyviolation', () => {
      networkBlocked = true;
      parent.postMessage({channel: ${JSON.stringify(channel)}, kind:'blocked'}, '*');
    });
    addEventListener('message', async (event) => {
      if (event.source !== parent || event.data?.channel !== ${JSON.stringify(channel)}
          || typeof event.data.source !== 'string') return;
      if (!event.data.source.trim() || event.data.source.length > 20000) return;
      try {
        mermaid.initialize({
          layout:'dagre', theme:'default', look:'classic', startOnLoad:false,
          securityLevel:'strict', suppressErrorRendering:true, htmlLabels:false
        });
        try {
          await mermaid.parse(event.data.source);
        } catch {
          parent.postMessage({channel:${JSON.stringify(channel)}, kind:'invalid-source'}, '*');
          return;
        }
        const {svg} = await mermaid.render('artifactshare-mermaid-export', event.data.source);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!networkBlocked)
          parent.postMessage({channel:${JSON.stringify(channel)}, kind:'rendered', svg}, '*');
      } catch {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (networkBlocked) return;
        parent.postMessage({channel:${JSON.stringify(channel)}, kind:'failed'}, '*');
      }
    }, {once:true});
    parent.postMessage({channel:${JSON.stringify(channel)}, kind:'ready'}, '*');
  `
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><body><script nonce="${nonce}">${bundle.replace(/<\/script/gi, '<\\/script')}</script><script nonce="${nonce}">${helper}</script></body>`
  return new Promise((resolve, reject) => {
    let settled = false
    let imageSequence = 0
    const finish = (error?: Error, svg?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal.removeEventListener('abort', abort)
      frame.remove()
      if (error) reject(error)
      else {
        try {
          resolve(sanitizeMermaidSvg(svg!))
        } catch (sanitizeError) {
          reject(sanitizeError)
        }
      }
    }
    const abort = () => finish(resourceError('Mermaid export cancelled'))
    const timer = setTimeout(
      () => finish(resourceError('Mermaid export timed out')),
      10_000,
    )
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== 'null' ||
        event.data?.channel !== channel
      )
        return
      if (settled) return
      if (event.data.kind === 'image') {
        const { sequence, ref } = event.data
        if (
          sequence !== imageSequence + 1 ||
          sequence > 256 ||
          typeof ref !== 'string' ||
          ref.length > 8_000_000 ||
          !acquireImage
        ) {
          finish(resourceError('Mermaid export attempted a forbidden resource'))
          return
        }
        imageSequence = sequence
        void acquireImage(ref).then(
          (uri) => {
            if (settled || signal.aborted) return
            frame.contentWindow!.postMessage(
              { channel, kind: 'image', sequence, ref, uri },
              '*',
            )
          },
          () =>
            finish(
              resourceError('Mermaid export attempted a forbidden resource'),
            ),
        )
      } else if (event.data.kind === 'ready')
        frame.contentWindow!.postMessage({ channel, source }, '*')
      else if (
        event.data.kind === 'rendered' &&
        typeof event.data.svg === 'string' &&
        event.data.svg.length <= 8_000_000
      )
        finish(undefined, event.data.svg)
      else if (event.data.kind === 'blocked') {
        finish(resourceError('Mermaid export attempted a forbidden resource'))
      } else if (event.data.kind === 'failed')
        finish(resourceError('Mermaid rendering failed'))
      else if (event.data.kind === 'invalid-source')
        finish(new Error('Mermaid source is invalid'))
    }
    window.addEventListener('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    document.body.appendChild(frame)
  })
}
