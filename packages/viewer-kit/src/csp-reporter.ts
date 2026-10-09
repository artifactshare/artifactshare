import { VIOLATION_REPORTER_SCRIPT_BODY } from './reporter.generated.js'
import {
  READY_CHECK_MESSAGE_SOURCE,
  READY_CHECK_MESSAGE_KIND,
} from './reporter-constants.js'
export {
  VIOLATION_REPORTER_SCRIPT_BODY,
  VIOLATION_REPORTER_SHA256,
} from './reporter.generated.js'
export {
  VIOLATION_REPORTER_MARKER,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
  READY_CHECK_MESSAGE_SOURCE,
  READY_CHECK_MESSAGE_KIND,
} from './reporter-constants.js'

/*
 * Injected into sandbox iframe content so the parent frame can surface
 * CSP violations to the viewer. Without this, an artifact whose external
 * scripts or fetches are blocked just renders blank with no signal.
 *
 * The iframe can postMessage to its parent — CSP doesn't block
 * window.postMessage. The parent (a.$id.tsx) listens for
 * source==='artifactshare' messages and renders a violation banner.
 */
export const SANDBOX_READY_CHECK_MESSAGE = {
  source: READY_CHECK_MESSAGE_SOURCE,
  kind: READY_CHECK_MESSAGE_KIND,
} as const
export const SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE = {
  source: READY_CHECK_MESSAGE_SOURCE,
  kind: 'external-link-policy',
  mode: 'parent',
} as const

export function createSandboxChallenge(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function ensureSandboxChallenge(challenge: string | null): string {
  return challenge ?? createSandboxChallenge()
}

export function acceptSandboxToken(
  registeredToken: string | null,
  registeredChallenge: string | null,
  challenge: unknown,
  token: unknown,
): string | null {
  return registeredToken === null &&
    registeredChallenge !== null &&
    typeof challenge === 'string' &&
    challenge.length > 0 &&
    typeof token === 'string' &&
    token.length > 0 &&
    challenge === registeredChallenge
    ? token
    : registeredToken
}

export function canUseOsHandler(
  registeredToken: string | null,
  token: unknown,
  isActive: boolean,
): boolean {
  return (
    registeredToken !== null &&
    registeredToken.length > 0 &&
    typeof token === 'string' &&
    token.length > 0 &&
    token === registeredToken &&
    isActive
  )
}

// The generated body and hash share one source of truth for both injection paths.
export const VIOLATION_REPORTER_TAG = `<script>${VIOLATION_REPORTER_SCRIPT_BODY}</script>`

export interface CspViolationMessage {
  source: 'artifactshare'
  kind: 'csp-violation'
  directive: string
  blockedURI: string
  sourceFile: string | null
  sample?: string
  disposition?: 'enforce' | 'report'
  lineNumber: number | null
}

export interface TextSelectionMessage {
  source: 'artifactshare'
  kind: 'text-selection'
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number
  textEnd: number
  cssPath: string | null
  selectorFormat?: 'normalized-v1'
  textHash?: string
  ambiguousAtCreation?: boolean
  versionId?: string | null
  token?: string
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
}

export interface AnchorResolutionMessage {
  source: 'artifactshare'
  kind: 'anchor-resolutions'
  token: string
  versionId: string | null
  targetPath: string | null
  generation: number
  results: Array<{
    threadId: string
    state: 'attached' | 'needs-check' | 'checking'
    textStart: number | null
    textEnd: number | null
    textHash: string | null
  }>
}

export interface TextSelectionClearedMessage {
  source: 'artifactshare'
  kind: 'text-selection-cleared'
}

export interface CommentThreadSelectedMessage {
  source: 'artifactshare'
  kind: 'comment-thread-selected'
  threadId: string
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
}

export interface CommentOutsidePointerDownMessage {
  source: 'artifactshare'
  kind: 'comment-outside-pointer-down'
}

export interface LinkClickedMessage {
  source: 'artifactshare'
  kind: 'link-clicked'
  href: string
  token?: string
}

export interface MermaidRenderRequestMessage {
  source: 'artifactshare'
  kind: 'mermaid-render-request'
  renderToken: string
  diagrams: Array<{ id: string; source: string }>
}

export type ElementAnnotateMessage = {
  source: 'artifactshare'
  kind: 'element-annotate'
  selector: string
  label: string
  contextText: string
  rect: { top: number; left: number; width: number; height: number }
}

interface ReadyMessage {
  source: 'artifactshare'
  kind: 'ready'
  challenge?: string
  token?: string
}

export interface HashChangedMessage {
  source: 'artifactshare'
  kind: 'hash-changed'
  hash: string
  path: string
  token: string
}

export type SandboxMessage =
  | HashChangedMessage
  | CspViolationMessage
  | ReadyMessage
  | TextSelectionMessage
  | AnchorResolutionMessage
  | TextSelectionClearedMessage
  | CommentThreadSelectedMessage
  | CommentOutsidePointerDownMessage
  | LinkClickedMessage
  | MermaidRenderRequestMessage
  | ElementAnnotateMessage

export function isSandboxMessage(value: unknown): value is SandboxMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.source !== 'artifactshare') return false
  if (v.kind === 'hash-changed') {
    return (
      typeof v.token === 'string' &&
      /^[a-f0-9]{64}$/.test(v.token) &&
      typeof v.path === 'string' &&
      typeof v.hash === 'string' &&
      v.hash.length <= 2048 &&
      (v.hash === '' || v.hash[0] === '#')
    )
  }
  if (v.kind === 'csp-violation') {
    return (
      typeof v.directive === 'string' &&
      typeof v.blockedURI === 'string' &&
      (v.sourceFile === null || typeof v.sourceFile === 'string') &&
      (v.lineNumber === null ||
        (typeof v.lineNumber === 'number' &&
          Number.isFinite(v.lineNumber) &&
          v.lineNumber >= 0)) &&
      (v.sample === undefined ||
        (typeof v.sample === 'string' && v.sample.length <= 80)) &&
      (v.disposition === undefined ||
        v.disposition === 'enforce' ||
        v.disposition === 'report')
    )
  }
  if (
    v.kind === 'text-selection-cleared' ||
    v.kind === 'comment-outside-pointer-down'
  ) {
    return true
  }
  if (v.kind === 'ready') {
    return (
      (v.challenge === undefined || typeof v.challenge === 'string') &&
      (v.token === undefined || typeof v.token === 'string')
    )
  }
  if (v.kind === 'anchor-resolutions') {
    return (
      typeof v.token === 'string' &&
      /^[a-f0-9]{64}$/.test(v.token) &&
      (v.versionId === null || typeof v.versionId === 'string') &&
      (v.targetPath === null || typeof v.targetPath === 'string') &&
      Number.isSafeInteger(v.generation) &&
      (v.generation as number) >= 0 &&
      Array.isArray(v.results) &&
      v.results.length <= 100 &&
      v.results.every((result) => {
        if (!result || typeof result !== 'object') return false
        const r = result as Record<string, unknown>
        if (typeof r.threadId !== 'string' || r.threadId.length > 128)
          return false
        if (r.state === 'checking' || r.state === 'needs-check')
          return (
            r.textStart === null && r.textEnd === null && r.textHash === null
          )
        return (
          r.state === 'attached' &&
          Number.isSafeInteger(r.textStart) &&
          Number.isSafeInteger(r.textEnd) &&
          (r.textStart as number) >= 0 &&
          (r.textEnd as number) > (r.textStart as number) &&
          typeof r.textHash === 'string' &&
          /^[a-f0-9]{64}$/.test(r.textHash)
        )
      })
    )
  }
  if (v.kind === 'text-selection') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      (v.selectorFormat === undefined ||
        (v.selectorFormat === 'normalized-v1' &&
          typeof v.textHash === 'string' &&
          /^[a-f0-9]{64}$/.test(v.textHash) &&
          typeof v.ambiguousAtCreation === 'boolean' &&
          (v.versionId === null || typeof v.versionId === 'string'))) &&
      typeof v.quotedText === 'string' &&
      v.quotedText.length > 0 &&
      v.quotedText.length <= 1000 &&
      typeof v.prefixText === 'string' &&
      v.prefixText.length <= 400 &&
      typeof v.suffixText === 'string' &&
      v.suffixText.length <= 400 &&
      Number.isSafeInteger(v.textStart) &&
      Number.isSafeInteger(v.textEnd) &&
      (v.textStart as number) >= 0 &&
      (v.textEnd as number) - (v.textStart as number) === v.quotedText.length &&
      typeof v.prefixText === 'string' &&
      typeof v.suffixText === 'string' &&
      typeof v.textStart === 'number' &&
      typeof v.textEnd === 'number' &&
      (v.cssPath === null || typeof v.cssPath === 'string') &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'comment-thread-selected') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      typeof v.threadId === 'string' &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'link-clicked') {
    return (
      typeof v.href === 'string' &&
      (v.token === undefined || typeof v.token === 'string')
    )
  }
  if (v.kind === 'element-annotate') {
    const rect = v.rect as Record<string, unknown> | undefined
    return (
      typeof v.selector === 'string' &&
      typeof v.label === 'string' &&
      typeof v.contextText === 'string' &&
      Boolean(rect) &&
      typeof rect?.top === 'number' &&
      typeof rect.left === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
    )
  }
  if (v.kind === 'mermaid-render-request') {
    return (
      typeof v.renderToken === 'string' &&
      v.renderToken.length > 0 &&
      v.renderToken.length <= 128 &&
      Array.isArray(v.diagrams) &&
      v.diagrams.length > 0 &&
      v.diagrams.length <= 16 &&
      v.diagrams.every(
        (diagram) =>
          diagram !== null &&
          typeof diagram === 'object' &&
          typeof (diagram as Record<string, unknown>).id === 'string' &&
          /^artifactshare-mermaid-\d+$/.test(
            (diagram as Record<string, unknown>).id as string,
          ) &&
          typeof (diagram as Record<string, unknown>).source === 'string' &&
          ((diagram as Record<string, unknown>).source as string).length > 0 &&
          ((diagram as Record<string, unknown>).source as string).length <=
            20_000,
      )
    )
  }
  return false
}
