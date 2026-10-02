import {
  extractAnchorDocument,
  type AnchorDocument,
} from '@artifactshare/viewer-kit/anchor-text'
import {
  buildAnchorTransition,
  mapAnchorRange,
} from '@artifactshare/viewer-kit/anchor-map'
import { renderMarkdownDocument } from '@artifactshare/viewer-kit/markdown-render'
import type { PreviewAnchor } from './contract.js'
import type { PreviewStore } from './store.js'

type TextAnchor = Extract<PreviewAnchor, { kind: 'text' }>
interface Snapshot {
  document: AnchorDocument
  positions: Map<string, TextAnchor>
}

/** Session-local, bounded undo history. No quote lookup or hosted lineage. */
export function createPreviewAnchorSnapshots(
  store: PreviewStore,
  markdown: boolean,
) {
  const history = new Map<string, Snapshot>()
  let previous: Snapshot | undefined
  return {
    reload(revision: string, source: string) {
      // Capture annotations created since the last reload, keeping already
      // mapped positions even if a live-frame verification failed meanwhile.
      if (previous) {
        for (const annotation of store.all()) {
          if (
            annotation.anchor.kind === 'text' &&
            !previous.positions.has(annotation.thread)
          )
            previous.positions.set(annotation.thread, { ...annotation.anchor })
        }
      }
      const next = history.get(revision) ?? {
        document: extractAnchorDocument(
          markdown ? renderMarkdownDocument(source) : source,
        ),
        positions: new Map<string, TextAnchor>(),
      }
      const transition =
        previous && buildAnchorTransition(previous.document, next.document)
      for (const annotation of store.all()) {
        if (annotation.anchor.kind !== 'text') continue
        let anchor = next.positions.get(annotation.thread)
        if (!anchor) {
          const before =
            previous?.positions.get(annotation.thread) ?? annotation.anchor
          let range = null
          if (
            before.state === 'attached' &&
            before.textStart !== null &&
            before.textEnd !== null
          ) {
            if (previous && transition) {
              const mapped = mapAnchorRange(
                transition,
                before.textStart,
                before.textEnd,
              )
              if (!('reason' in mapped)) range = mapped
            } else if (
              !previous &&
              before.textStart >= 0 &&
              before.textEnd > before.textStart &&
              next.document.text.slice(before.textStart, before.textEnd) ===
                (before.currentText ?? before.quotedText)
            ) {
              range = { textStart: before.textStart, textEnd: before.textEnd }
            }
          }
          anchor = range
            ? {
                ...before,
                ...range,
                state: 'attached',
                currentText: next.document.text.slice(
                  range.textStart,
                  range.textEnd,
                ),
              }
            : { ...before, state: 'orphaned', textStart: null, textEnd: null }
          next.positions.set(annotation.thread, anchor)
        }
        store.setTextAnchor(annotation.thread, anchor)
      }
      history.delete(revision)
      history.set(revision, next)
      previous = next
      let units = [...history.values()].reduce(
        (sum, entry) => sum + entry.document.text.length,
        0,
      )
      while (history.size > 1 && (history.size > 16 || units > 2_000_000)) {
        const key = history.keys().next().value!
        units -= history.get(key)!.document.text.length
        history.delete(key)
      }
    },
  }
}
