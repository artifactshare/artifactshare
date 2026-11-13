import type { FeedEventRow } from '~/services/events.server'
import type { Translator } from '~/lib/i18n'

type Translate = Translator['t']

function anonymousSuffix(row: FeedEventRow, t: Translate) {
  if (!row.viewUniqueCount || !row.anonymousViewCount) return ''
  return ` · ${t(
    row.anonymousViewCount === 1
      ? 'home.anonymousViewsSuffix_one'
      : 'home.anonymousViewsSuffix_other',
    { count: String(row.anonymousViewCount) },
  )}`
}

function viewedText(row: FeedEventRow, t: Translate) {
  const count = String(row.viewUniqueCount || (row.anonymousViewCount ?? 0))
  const named = Boolean(row.viewUniqueCount)
  const single = (named ? row.viewUniqueCount : row.anonymousViewCount) === 1
  if (typeof row.viewedFileCount === 'number') {
    const key = named
      ? single
        ? 'home.viewDigest_one'
        : 'home.viewDigest_other'
      : single
        ? 'home.viewDigestAnonymous_one'
        : 'home.viewDigestAnonymous_other'
    return (
      t(key, { files: String(row.viewedFileCount), count }) +
      anonymousSuffix(row, t)
    )
  }
  const key = named
    ? single
      ? 'home.viewedByInline_one'
      : 'home.viewedByInline_other'
    : single
      ? 'home.anonymousViewsInline_one'
      : 'home.anonymousViewsInline_other'
  return t(key, { title: '{title}', count }) + anonymousSuffix(row, t)
}

function publishedText(row: FeedEventRow, actor: string, t: Translate) {
  if (row.versionStart === null || row.versionEnd === null) {
    return t('home.actorPublishedInline', {
      actor,
      title: '{title}',
      version: String(row.versionNumber ?? 1),
    })
  }
  const range = {
    title: '{title}',
    start: String(row.versionStart),
    end: String(row.versionEnd),
  }
  return row.versionAuthorCount === 1
    ? t('home.actorPublishedRangeInline', { actor, ...range })
    : t('home.publishedRangeInline', range)
}

// Preserve placeholders so the renderer inserts links at the translated position.
export function feedEventText(row: FeedEventRow, t: Translate) {
  const actor = row.actorName ?? t('home.unknownActor')
  const vars = { actor, title: '{title}' }
  switch (row.type) {
    case 'artifact_viewed':
      return viewedText(row, t)
    case 'comment_posted':
      return row.commentCount !== null
        ? t('home.actorCommentedCountInline', {
            ...vars,
            count: String(row.commentCount),
          })
        : t('home.actorCommentedInline', vars)
    case 'version_published':
      return publishedText(row, actor, t)
    case 'artifact_created':
      if ((row.addCount ?? 0) >= 2) {
        return t('home.actorAddedToProjectCount', {
          actor,
          project: '{project}',
          count: String(row.addCount),
        })
      }
      return t('home.actorAddedInline', vars)
    default:
      return t('home.actorAddedInline', vars)
  }
}
