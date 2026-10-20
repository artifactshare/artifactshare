import {
  messageCursor as throughCursor,
  parseMessageCursor as boundary,
} from '~/lib/comment-cursor'
import type { CommentMessageView, CommentThreadView } from '~/lib/comments'

export type CommentPageRequest =
  import('~/lib/comment-page').CommentPageRequest & {
    coverageStart?: string | null
    interiorGap?: boolean
  }
export type CommentThreadPatch = {
  threadId?: string
  changedMessage?: CommentMessageView
  deletedMessageId?: string
  deletedThreadId?: string
  page?: CommentPageRequest
}
export type ChangeCommentThreads = (
  threads: ReadonlyArray<CommentThreadView>,
  patch?: CommentThreadPatch,
) => void

export function compareCommentMessages(
  a: Pick<CommentMessageView, 'createdAt' | 'id'>,
  b: Pick<CommentMessageView, 'createdAt' | 'id'>,
) {
  return a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
}

/** Compact retained tail coverage by tuple, not by notification count. Existing
 * explicitly fetched pages already cover their rows; don't request them twice. */
function compactTailPages(
  thread: CommentThreadView,
  pages: CommentPageRequest[],
  tail: CommentMessageView[],
): CommentPageRequest[] {
  const replies = thread.messages.slice(1)
  const covered = new Set<string>()
  const explicit = pages.filter((page) => !page.through)
  const rowsFor = (page: CommentPageRequest) => {
    // Requested limits do not establish coverage: an around lookup near the
    // latest message may return fewer rows than requested, across a cache gap.
    const lower = page.coverageStart
      ? boundary(page.coverageStart, thread.id)
      : undefined
    if (!lower) return []
    const coveredReplies = replies.filter(
      (message) => compareCommentMessages(message, lower) >= 0,
    )
    const edge = page.through ?? page.before
    if (edge) {
      const upper = boundary(edge, thread.id)
      if (!upper) return []
      return coveredReplies.filter((message) =>
        page.before
          ? compareCommentMessages(message, upper) < 0
          : compareCommentMessages(message, upper) <= 0,
      )
    }
    const start = coveredReplies.findIndex(
      (message) => message.id === page.aroundMessageId,
    )
    return start < 0
      ? []
      : coveredReplies.slice(start, start + (page.limit ?? 50))
  }
  for (const page of explicit)
    for (const message of rowsFor(page)) covered.add(message.id)
  // Each server window establishes continuity only within its own rows. Local
  // adjacency can hide a gap after coalesced notifications; join windows only
  // when they share a row, never merely because they are neighbours in cache.
  const groups: CommentMessageView[][] = []
  const windows = pages.flatMap((page) => (page.through ? [rowsFor(page)] : []))
  windows.push(tail)
  for (const rows of windows) {
    const ids = new Set(rows.map((message) => message.id))
    const joined = [...rows]
    for (let index = groups.length - 1; index >= 0; index--) {
      if (groups[index].some((message) => ids.has(message.id))) {
        for (const message of groups[index]) {
          if (!ids.has(message.id)) joined.push(message)
          ids.add(message.id)
        }
        groups.splice(index, 1)
      }
    }
    if (joined.length) groups.push(joined.sort(compareCommentMessages))
  }
  const result = [...explicit]
  for (const group of groups.sort((a, b) =>
    compareCommentMessages(a[0], b[0]),
  )) {
    let chunk: CommentMessageView[] = []
    const flush = () => {
      const last = chunk.at(-1)
      if (last)
        result.push({
          through: throughCursor(thread.id, last),
          limit: chunk.length,
          coverageStart: throughCursor(thread.id, chunk[0]),
        })
      chunk = []
    }
    for (const message of group) {
      if (covered.has(message.id)) {
        flush()
        continue
      }
      chunk.push(message)
      if (chunk.length === 50) flush()
    }
    flush()
  }
  return result
}

function samePageRequest(a: CommentPageRequest, b?: CommentPageRequest) {
  return (
    b !== undefined &&
    a.before === b.before &&
    a.through === b.through &&
    a.aroundMessageId === b.aroundMessageId &&
    a.limit === b.limit
  )
}

/** Revalidate the stored interval, not just the original requested row count.
 * Insertions can push retained rows out of a bounded response. Seek backwards
 * until the intended lower bound is reached, keeping one owner for the interval.
 * The caller publishes the result only after its request epoch is still current. */
export async function revalidateCommentPage(
  current: CommentThreadView,
  page: CommentPageRequest,
  load: (request: CommentPageRequest) => Promise<CommentThreadView>,
): Promise<CommentThreadView> {
  const lower = page.coverageStart
    ? boundary(page.coverageStart, current.id)
    : undefined
  let request = page
  let merged = current
  let previousOldest: CommentMessageView | undefined
  for (;;) {
    const incoming = await load(request)
    const owners = merged.loadedPages
    const olderCursor = merged.olderCursor
    merged = mergeCommentWindow(merged, incoming, request)
    if (request !== page) {
      // Continuations belong to the original interval, not independent pages.
      const oldest = incoming.messages[1]
      merged.olderCursor = olderCursor
      merged.loadedPages = owners?.map((owner) =>
        samePageRequest(owner, page) &&
        oldest &&
        (!owner.coverageStart ||
          compareCommentMessages(
            oldest,
            boundary(owner.coverageStart, current.id)!,
          ) < 0)
          ? { ...owner, coverageStart: throughCursor(current.id, oldest) }
          : owner,
      )
    }
    const oldest = incoming.messages[1]
    if (
      !lower ||
      !oldest ||
      incoming.olderCursor === null ||
      compareCommentMessages(oldest, lower) <= 0
    )
      return merged
    if (previousOldest && compareCommentMessages(oldest, previousOldest) >= 0)
      throw new Error('Comment page did not advance')
    previousOldest = oldest
    request = {
      before: incoming.olderCursor,
      limit: Math.max(
        1,
        Math.min(
          50,
          merged.messages.filter(
            (message) =>
              compareCommentMessages(message, lower) >= 0 &&
              compareCommentMessages(message, oldest) < 0,
          ).length,
        ),
      ),
    }
  }
}

/** Replace the covered tuple interval, including vanished rows. Keep other pages,
 * and use the server's promoted first message after first-message deletion. */
export function mergeCommentWindow(
  current: CommentThreadView | undefined,
  incoming: CommentThreadView,
  page?: CommentPageRequest,
): CommentThreadView {
  const first = incoming.messages[0]
  const replies = incoming.messages.slice(1)
  const oldest = replies[0]
  const previousPage = current?.loadedPages?.find((value) =>
    samePageRequest(value, page),
  )
  const previousLower = previousPage?.coverageStart
    ? boundary(previousPage.coverageStart, incoming.id)
    : undefined
  const coverageStart =
    previousLower && oldest && compareCommentMessages(previousLower, oldest) < 0
      ? previousPage!.coverageStart
      : oldest
        ? throughCursor(incoming.id, oldest)
        : null
  const coveredPage = page
    ? {
        ...page,
        coverageStart,
      }
    : undefined
  const latestReplyIds = page
    ? (current?.latestReplyIds ??
      current?.messages
        .slice(1)
        .slice(-3)
        .map((message) => message.id) ??
      [])
    : replies.map((message) => message.id)
  if (!current)
    return {
      ...incoming,
      latestReplyIds,
      loadedPages: coveredPage ? [coveredPage] : [],
    }
  const upper = page?.before
    ? boundary(page.before, incoming.id)
    : page?.through
      ? boundary(page.through, incoming.id)
      : page?.aroundMessageId
        ? replies.at(-1)
        : undefined
  if (page?.before && !upper) return current
  const retained = current.messages.filter((message) => {
    if (!first || compareCommentMessages(message, first) <= 0) return false
    if (
      (page?.aroundMessageId || page?.through) &&
      upper &&
      compareCommentMessages(message, upper) > 0
    )
      return true
    if (page?.before && upper && compareCommentMessages(message, upper) >= 0)
      return true
    return (
      incoming.olderCursor !== null &&
      oldest !== undefined &&
      compareCommentMessages(message, oldest) < 0
    )
  })
  const messages = new Map(retained.map((message) => [message.id, message]))
  for (const message of incoming.messages) messages.set(message.id, message)
  let pages = [...(current.loadedPages ?? [])]
  // A latest-window refresh can displace replies that remain displayed. Keep a
  // stable bounded range for that old tail so later edits/deletions reach it.
  const retainedIds = new Set(retained.map((message) => message.id))
  const latestIds = new Set(current.latestReplyIds)
  const previousTail = current.latestReplyIds
    ? current.messages.filter((message) => latestIds.has(message.id))
    : current.messages.slice(1).slice(-3)
  const last = previousTail.at(-1)
  if (
    !page &&
    last &&
    previousTail.some((message) => retainedIds.has(message.id))
  ) {
    pages = compactTailPages(current, pages, previousTail)
  }
  if (coveredPage) {
    const index = pages.findIndex((value) =>
      samePageRequest(value, coveredPage),
    )
    if (index < 0) pages.push(coveredPage)
    else pages[index] = coveredPage
  }
  const loadedPages = pages
  return {
    ...incoming,
    latestReplyIds,
    subject:
      incoming.subject.kind === 'text' && current.subject.kind === 'text'
        ? { ...incoming.subject, checking: current.subject.checking }
        : incoming.subject,
    messages: [...messages.values()].sort(compareCommentMessages),
    // Around pages can be disjoint; they must not skip the contiguous older path.
    olderCursor:
      page?.aroundMessageId || page?.through || page?.interiorGap
        ? current.olderCursor
        : page
          ? incoming.olderCursor
          : loadedPages.some((value) => value.before)
            ? current.olderCursor
            : incoming.olderCursor,
    loadedPages,
  }
}

export function patchCommentThreads(
  current: ReadonlyArray<CommentThreadView>,
  incoming: ReadonlyArray<CommentThreadView>,
  patch: CommentThreadPatch,
): CommentThreadView[] {
  const byId = new Map(current.map((thread) => [thread.id, thread]))
  for (const thread of incoming)
    byId.set(
      thread.id,
      mergeCommentWindow(byId.get(thread.id), thread, patch.page),
    )
  if (patch.deletedThreadId) byId.delete(patch.deletedThreadId)
  if (patch.threadId && byId.has(patch.threadId)) {
    const thread = byId.get(patch.threadId)!
    const messages = new Map<string, CommentMessageView>()
    for (const message of thread.messages)
      if (message.id !== patch.deletedMessageId)
        messages.set(message.id, message)
    if (patch.changedMessage)
      messages.set(patch.changedMessage.id, patch.changedMessage)
    byId.set(thread.id, {
      ...thread,
      messages: [...messages.values()].sort(compareCommentMessages),
    })
  }
  return [...byId.values()]
}

/** Only a server window proves continuity. Sorted cached rows alone do not. */
export function commentGapRequests(
  thread: CommentThreadView,
): Map<string, CommentPageRequest> {
  const gaps = new Map<string, CommentPageRequest>()
  if (thread.messages.length >= thread.messageCount) return gaps
  const replies = thread.messages.slice(1)
  const latestIds = new Set(
    thread.latestReplyIds ?? replies.slice(-3).map((message) => message.id),
  )
  const tail = replies.filter((message) => latestIds.has(message.id))
  const intervals = (thread.loadedPages ?? []).flatMap((page) => {
    const lower = page.coverageStart
      ? boundary(page.coverageStart, thread.id)
      : undefined
    const upper =
      page.through || page.before
        ? boundary((page.through ?? page.before)!, thread.id)
        : undefined
    return lower && upper ? [{ lower, upper }] : []
  })
  if (tail.length)
    intervals.push({ lower: tail[0], upper: tail[tail.length - 1] })
  for (let index = 1; index < replies.length; index++) {
    const previous = replies[index - 1]
    const next = replies[index]
    if (
      !intervals.some(
        ({ lower, upper }) =>
          compareCommentMessages(previous, lower) >= 0 &&
          compareCommentMessages(next, upper) <= 0,
      )
    )
      gaps.set(next.id, {
        before: throughCursor(thread.id, next),
        limit: 50,
        interiorGap: true,
      })
  }
  return gaps
}
