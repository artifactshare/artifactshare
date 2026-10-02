import { VIOLATION_REPORTER_TAG } from './csp-reporter.js'
import { markAnchorSource, reporterSourceInsertion } from './anchor-text.js'

export const MAX_ANCHOR_SOURCE_BYTES = 4_000_000
export function supportsAnchorEncoding(contentType: string): boolean {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
  return !charset || /^(utf-8|utf8|us-ascii)$/i.test(charset)
}

export function supportsAnchorSource(source: string): boolean {
  return (
    source.length <= MAX_ANCHOR_SOURCE_BYTES &&
    supportsAnchorEncoding(
      source.slice(0, 1024).match(/<meta\b[^>]*charset\s*=[^>]*>/i)?.[0] ?? '',
    )
  )
}
export const UNAVAILABLE_SOURCE_REPORTER_TAG = VIOLATION_REPORTER_TAG.replace(
  '<script>',
  '<script data-ash-source-unavailable>',
)
export function injectReadyReporter(source: string): string {
  if (supportsAnchorSource(source)) {
    // Splice markers before authored scripts without rewriting source markup.
    const marked = markAnchorSource(source, VIOLATION_REPORTER_TAG)
    if (marked.manifest) return marked.html
  }
  const insertion = reporterSourceInsertion(
    source.slice(0, 65_536),
    UNAVAILABLE_SOURCE_REPORTER_TAG,
  )
  // A truncated prologue can end inside a doctype/comment/tag. Do not splice
  // inside that token when no complete head boundary has been observed.
  if (
    source.length > 65_536 &&
    insertion.at === 65_536 &&
    source[65_535] !== '>'
  )
    return source
  return (
    source.slice(0, insertion.at) + insertion.value + source.slice(insertion.at)
  )
}

/** Keep large/legacy-encoded documents streaming and byte-preserving. Only a
 * bounded ASCII-compatible prologue is inspected; the body is never decoded. */
export function injectUnavailableSourceReporter(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = []
      let length = 0,
        done = false
      while (length < 65_536 && !done) {
        const part = await reader.read()
        done = part.done
        if (part.value) {
          chunks.push(part.value)
          length += part.value.byteLength
        }
      }
      const prefix = new Uint8Array(Math.min(length, 65_536))
      let copied = 0
      for (const chunk of chunks) {
        const count = Math.min(chunk.length, prefix.length - copied)
        prefix.set(chunk.subarray(0, count), copied)
        copied += count
      }
      // UTF-16/32 cannot accept an ASCII script. Preserve those sources too.
      const compatible =
        !prefix.subarray(0, 128).includes(0) &&
        prefix[0] !== 0xff &&
        prefix[0] !== 0xfe
      const bom =
        prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf ? 3 : 0
      const prologue = new TextDecoder('windows-1252').decode(
        prefix.subarray(bom),
      )
      const insertion = reporterSourceInsertion(
        prologue,
        UNAVAILABLE_SOURCE_REPORTER_TAG,
      )
      let offset =
        compatible &&
        (done || insertion.at < prologue.length || prologue.endsWith('>'))
          ? insertion.at + bom
          : -1
      const script = new TextEncoder().encode(insertion.value)
      for (const chunk of chunks) {
        if (offset >= 0 && offset <= chunk.length) {
          controller.enqueue(chunk.subarray(0, offset))
          controller.enqueue(script)
          controller.enqueue(chunk.subarray(offset))
          offset = -1
        } else {
          controller.enqueue(chunk)
          if (offset >= 0) offset -= chunk.length
        }
      }
      if (done) controller.close()
    },
    async pull(controller) {
      const part = await reader.read()
      if (part.done) controller.close()
      else controller.enqueue(part.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
