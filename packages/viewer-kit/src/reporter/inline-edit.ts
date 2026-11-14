import type { ReporterState } from './state.js'
import { ensureAnnotateStyles, ownText } from './annotate.js'
import { send } from './messaging.js'
import { rebuildAfterMutations } from './mutations.js'

// Local preview only: a picked element made only of text can be rewritten in
// place. The edit is a draft the parent mirrors; the document is put back
// exactly as it was when editing ends, so anchors and the file never see it.
export const INLINE_EDIT_MAX_LENGTH = 16_000

export function inlineEditable(ctx: ReporterState, el: Element) {
  if (!ctx.previewCapability) return false
  if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false
  // Code keeps its whitespace and controls own their text; neither is
  // edited as collapsed plain text.
  if (
    /^(A|AUDIO|BUTTON|CANVAS|CODE|IFRAME|IMG|INPUT|KBD|LABEL|METER|NOSCRIPT|OBJECT|OPTGROUP|OPTION|PRE|PROGRESS|SAMP|SCRIPT|SELECT|STYLE|SUMMARY|TEMPLATE|TEXTAREA|TITLE|VIDEO)$/.test(
      el.tagName,
    ) ||
    el.tagName.indexOf('-') >= 0
  )
    return false
  if (el.firstElementChild !== null || el.shadowRoot !== null) return false
  if ((el as HTMLElement).isContentEditable) return false
  if (el.getRootNode() !== ctx.doc) return false
  if (
    ctx.primordials.closest(
      el,
      'a,button,label,summary,select,svg,pre,code,kbd,samp',
    )
  )
    return false
  const text = ownText(ctx, el)
  return text.length > 0 && text.length <= INLINE_EDIT_MAX_LENGTH
}

export function startInlineEdit(ctx: ReporterState, sequence: unknown) {
  if (!ctx.previewCapability || typeof sequence !== 'number' || !(sequence > 0))
    return
  const pick = ctx.previewPick
  if (
    ctx.previewEdit ||
    !pick ||
    pick.sequence !== sequence ||
    pick.endpoints
  ) {
    // A newer pick or edit got here first: the parent shows its field.
    send(ctx, { kind: 'edit-ended', pickSequence: sequence })
    return
  }
  const el = pick.target as HTMLElement
  // The document changed it since the pick: the parent shows its field.
  if (!el.isConnected || !inlineEditable(ctx, el)) {
    send(ctx, { kind: 'edit-ended', pickSequence: sequence })
    return
  }
  const nodes: Node[] = []
  const data: (string | null)[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]
    nodes[i] = node
    data[i] =
      node.nodeType === 3 || node.nodeType === 8
        ? (node as CharacterData).data
        : null
  }
  ensureAnnotateStyles(ctx)
  el.classList.remove('as-preview-annotate-hover', 'as-preview-annotate-text')
  if (ctx.annotateHoverElement === el) ctx.annotateHoverElement = null
  // Checking follow-ups resume when the edit ends and anchors are remeasured.
  if (ctx.checkingTimer) ctx.win.clearTimeout(ctx.checkingTimer)
  ctx.checkingTimer = undefined
  ctx.win.clearTimeout(ctx.resolveTimer)
  ctx.resolveStartedAt = 0
  ctx.previewEdit = {
    element: el,
    sequence: pick.sequence,
    nodes,
    data,
    contentEditable: ctx.primordials.getAttribute(el, 'contenteditable'),
    raw: el.textContent || '',
    text: ownText(ctx, el),
  }
  el.setAttribute('contenteditable', 'plaintext-only')
  // Without plaintext-only support the attribute is invalid: use the field.
  if (!el.isContentEditable) {
    endInlineEdit(ctx, true)
    return
  }
  el.classList.add('as-preview-editing')
  // The pick click left focus in this document. If the reader has already
  // moved to the parent's comment field, the rewrite uses the field instead.
  if (!ctx.doc.hasFocus()) {
    endInlineEdit(ctx, true)
    return
  }
  try {
    el.focus({ preventScroll: true })
    const selection = ctx.win.getSelection()
    if (selection) {
      const range = ctx.primordials.createRange(ctx.doc)
      ctx.primordials.rangeSetStart(range, el, el.childNodes.length)
      ctx.primordials.rangeCollapse(range, true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  } catch (e) {}
}

export function lockInlineEdit(ctx: ReporterState, locked: unknown) {
  const edit = ctx.previewEdit
  if (!edit || typeof locked !== 'boolean') return
  edit.element.setAttribute(
    'contenteditable',
    locked ? 'false' : 'plaintext-only',
  )
  // Text typed before the lock arrived was dropped while saving; resend it.
  if (!locked) sendInlineEditText(ctx)
}

/** Puts the document back. `removed` tells the parent the element went away. */
export function endInlineEdit(ctx: ReporterState, removed = false) {
  const edit = ctx.previewEdit
  if (!edit) return
  ctx.previewEdit = null
  const el = edit.element
  for (let i = 0; i < edit.nodes.length; i++) {
    const value = edit.data[i]
    if (value !== null) (edit.nodes[i] as CharacterData).data = value
  }
  while (el.firstChild) el.removeChild(el.firstChild)
  for (let i = 0; i < edit.nodes.length; i++) el.appendChild(edit.nodes[i])
  if (edit.contentEditable === null) el.removeAttribute('contenteditable')
  else el.setAttribute('contenteditable', edit.contentEditable)
  el.classList.remove('as-preview-editing')
  if (removed) send(ctx, { kind: 'edit-ended', pickSequence: edit.sequence })
  // Changes made while editing were not measured, and the restore's own
  // mutation records can fall outside the anchor root: remeasure here.
  rebuildAfterMutations(ctx)
}

export function sendInlineEditText(ctx: ReporterState) {
  const edit = ctx.previewEdit
  if (edit)
    send(ctx, {
      kind: 'edit-text',
      pickSequence: edit.sequence,
      text: edit.text,
    })
}

function onEditInput(ctx: ReporterState) {
  const edit = ctx.previewEdit!
  const el = edit.element
  // Plain text only: anything else (a dropped node) is put back as text.
  if (el.firstElementChild !== null) el.textContent = el.textContent || ''
  const text = ownText(ctx, el)
  if (text.length > INLINE_EDIT_MAX_LENGTH) {
    el.textContent = edit.raw
    return
  }
  edit.raw = el.textContent || ''
  if (text === edit.text) return
  edit.text = text
  sendInlineEditText(ctx)
}

/** Events inside the element being edited never reach the document's own
 * handlers (window capture runs before any of them), so typing cannot drive
 * a slide deck or a shortcut. Their default actions still edit the text. */
export function installInlineEditGuard(ctx: ReporterState) {
  const guardedEvents: (keyof WindowEventMap)[] = [
    'keydown',
    'keypress',
    'keyup',
    'beforeinput',
    'input',
    'paste',
    'cut',
    'copy',
    'drop',
    'dragover',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'pointerdown',
    'pointermove',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
    'gotpointercapture',
    'lostpointercapture',
    'pointerup',
    'pointercancel',
    'mousedown',
    'mousemove',
    'mouseover',
    'mouseout',
    'mouseenter',
    'mouseleave',
    'mouseup',
    'wheel',
    'dragstart',
    'selectstart',
    'touchmove',
    'pointerrawupdate' as keyof WindowEventMap,
    'textInput' as keyof WindowEventMap,
    'DOMMouseScroll' as keyof WindowEventMap,
    'MozMousePixelScroll' as keyof WindowEventMap,
    'touchcancel',
    'dragenter',
    'dragleave',
    'dragend',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'touchstart',
    'touchend',
  ]

  for (let i = 0; i < guardedEvents.length; i++) {
    const type = guardedEvents[i]
    ctx.primordials.addEventListener(
      ctx.win,
      type,
      function (event: Event) {
        const edit = ctx.previewEdit
        // A key pressed in the edit is released after Enter or Esc ended
        // it; that keyup belongs to the edit too.
        if (type === 'keyup') {
          const code = (event as KeyboardEvent).code
          if (ctx.previewEditKeys[code] === true) {
            delete ctx.previewEditKeys[code]
            event.stopImmediatePropagation()
            return
          }
        }
        if (!edit) return
        const target = ctx.primordials.targetGet
          ? ctx.primordials.targetGet(event)
          : event.target
        if (!target || !edit.element.contains(target as Node)) {
          // A drop elsewhere must not land in the editable element either.
          return
        }
        event.stopImmediatePropagation()
        if (type === 'input') onEditInput(ctx)
        else if (type === 'drop') ctx.primordials.preventDefault(event)
        else if (type === 'keydown') {
          ctx.previewEditKeys[(event as KeyboardEvent).code] = true
          onEditKey(ctx, event as KeyboardEvent)
        }
      },
      true,
    )
  }
}

function onEditKey(ctx: ReporterState, event: KeyboardEvent) {
  // An IME composition owns Enter and Escape until it is committed.
  if (event.isComposing || event.keyCode === 229) return
  let key = ''
  if (event.key === 'Enter') {
    ctx.primordials.preventDefault(event)
    if (event.shiftKey) return
    key = 'commit'
  } else if (event.key === 'Escape') key = 'cancel'
  else if (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey
  )
    key = 'comment'
  if (!key) return
  ctx.primordials.preventDefault(event)
  send(ctx, {
    kind: 'edit-key',
    pickSequence: ctx.previewEdit!.sequence,
    key,
  })
}
