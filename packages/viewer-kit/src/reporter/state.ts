import type { TextSelector } from './anchor-engine.js'
import type { highlightPalette } from './highlights.js'
import { capturePrimordials, type ReporterWindow } from './primordials.js'
export interface CommentHighlight extends TextSelector {
  threadId: string
  status?: string
  target?: boolean
  count?: number
}
export type VerificationAnchor =
  | (TextSelector & { kind: 'text'; thread: string; screen?: string })
  | {
      kind: 'element'
      thread: string
      screen?: string
      selector: string
      ownText?: string
      ownTextHash?: string
      ownTextExcerpt?: string
      tagName?: string
      contextText?: string
    }
export interface PreviewPick {
  sequence: number
  target: Element | Range
  endpoints: [Node, Node] | null
}
export interface SvgTextGroup {
  text: SVGTextContentElement
  start: number
  end: number
}
export interface BadgeRect {
  left: number
  right: number
  top: number
  width: number
  height: number
  bottom?: number
}
export interface BadgeEntry {
  badge: HTMLButtonElement
  highlight: CommentHighlight
  overlays?: Record<string, SVGRectElement>
  measure?: () => BadgeRect[]
}
export interface PaintedAnchor {
  highlight: CommentHighlight
  ranges: Range[]
  groups: SvgTextGroup[]
}
export interface ResolvedHighlight {
  highlight: CommentHighlight
  resolved: { textStart: number; textEnd: number } | null
  ranges: Range[]
}
export interface TextPaint {
  name: string
  highlight: Highlight
  ranges: Range[]
  threadId: string
  palette: ReturnType<typeof highlightPalette>
  active: boolean | undefined
  target: boolean | undefined
}
export interface InlineEdit {
  element: HTMLElement
  sequence: number
  nodes: Node[]
  data: (string | null)[]
  contentEditable: string | null
  raw: string
  text: string
}
export interface PendingLinkClick {
  artifactPrevented: boolean
  href: string
  openExternally: boolean
  /** A same-document fragment followed for Alt/Option+click in Preview. */
  fragment?: boolean
}
export type ReporterPointerEvent = MouseEvent & {
  pointerType?: string
  mozInputSource?: number
}
export function createReporterState(
  win: ReporterWindow,
  primordials = capturePrimordials(win),
) {
  return {
    win,
    doc: win.document,
    primordials,
    documentToken: '',
    readyChallenge: '',
    previewPick: null as PreviewPick | null,
    previewTrackedPick: null as PreviewPick | null,
    previewEdit: null as InlineEdit | null,
    previewGeometryFrame: 0,
    previewCapability: '',
    previewHomePath: '',
    previewOperating: false,
    previewRestore: null as { screen: string; readerActed: boolean } | null,
    previewLastScreen: null as string | null,
    previewGeneration: 0,
    previewSendSequence: 0,
    previewReceiveSequence: 0,
    lastHash: null as string | null,
    lastHashPath: null as string | null,
    pendingCspViolations: primordials.objectCreate(null) as Record<
      number,
      Record<string, unknown>
    >,
    pendingCspViolationCount: 0,
    externalLinkPolicyMode: 'parent',
    pendingLinkClicks: new win.WeakMap<Event, PendingLinkClick>(),
    highlightNames: [] as string[],
    textPaints: [] as TextPaint[],
    pendingHighlights: [] as CommentHighlight[],
    pendingAnchors: [] as VerificationAnchor[],
    measuredText: null as string | null,
    anchorSnapshotGeneration: 0,
    paintedAnchors: [] as PaintedAnchor[],
    resolveStartedAt: 0,
    resolveTimer: undefined as number | undefined,
    checkingTimer: undefined as number | undefined,
    checkingDeadlines: {} as Record<string, number>,
    checkingHighlights: [] as number[],
    checkingAnchors: [] as number[],
    pendingVerificationId: null as number | null,
    resolutionGeneration: 0,
    lastResolutionSignature: '',
    displayedVersionId: null as string | null,
    displayedPath: null as string | null,
    // Static sites scope comments to the live page location (path plus hash
    // route). The parent's location labels highlights; measurements use it
    // only while it still matches the document's own location.
    locationScoped: false,
    // With fallback to index, the site root stays `/` rather than
    // `/index.html` (see comment-location.ts).
    fallbackToIndex: false,
    lastLocation: null as string | null,
    locationGeneration: 0,
    pendingScrollThreadId: null as string | null,
    badges: [] as BadgeEntry[],
    badgeOffsets: {} as Record<string, { x: number; y: number }>,
    badgeDragged: false,
    appliedHighlightKey: '',
    textAnchorsEnabled: false,
    mermaidBlocks: primordials.objectCreate(null) as Record<
      string,
      HTMLPreElement
    >,
    mermaidRequested: false,
    commentLabels: {
      openOne: 'Open 1 unresolved comment on this text',
      openOther: 'Open {n} unresolved comments on this text',
      resolvedOne: 'Open 1 resolved comment on this text',
      resolvedOther: 'Open {n} resolved comments on this text',
    },
    reusableBadges: new win.Map<string, HTMLButtonElement>(),
    svgActiveThreads: {} as Record<string, boolean>,
    svgOverlayStyles: new win.WeakMap<
      SVGElement,
      { state: string; style: string | null }
    >(),
    badgePositionFrame: 0,
    annotateModeEnabled: false,
    annotateHoverElement: null as Element | null,
    readyCount: 0,
    observedAnchorRoot: win.document.body as Element,
    anchorObserver: null as MutationObserver | null,
    readyInterval: 0,
  }
}
export type ReporterState = ReturnType<typeof createReporterState>
