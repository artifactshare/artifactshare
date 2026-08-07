import { env } from 'cloudflare:workers'

import {
  evaluateFlagshipFlag,
  type FlagshipSource,
} from '~/lib/flagship-fallback.server'
import type {
  UpdateDetail,
  UpdateEntry,
  UpdateListItem,
  UpdateLocale,
  UpdateProduct,
} from '~/lib/updates-types'
import {
  getAllUpdates,
  getUpdateBySlug,
} from '~/services/updates-content.server'

const NOTICE_WINDOW_DAYS = 14

const FLAG_CONTEXT: Record<string, string> = {}

export function isUpdateEntryVisible(
  entry: UpdateEntry,
  enabled: boolean,
): boolean {
  if (!entry.flag) {
    return true
  }
  return enabled
}

async function isFlagEnabled(
  flagKey: string,
  source: FlagshipSource,
): Promise<boolean> {
  const result = await evaluateFlagshipFlag(source, {
    flagKey,
    context: FLAG_CONTEXT,
  })
  if (result.kind === 'evaluated') return result.enabled
  if (result.kind === 'missing-binding' && !result.production) {
    return result.enabled
  }
  return false
}

async function filterByFlagVisibility(
  entries: UpdateEntry[],
  source: FlagshipSource,
): Promise<UpdateEntry[]> {
  const flagKeys = [
    ...new Set(
      entries
        .map((entry) => entry.flag)
        .filter((flag): flag is string => !!flag),
    ),
  ]

  const enabledByFlag = new Map<string, boolean>()
  await Promise.all(
    flagKeys.map(async (flagKey) => {
      enabledByFlag.set(flagKey, await isFlagEnabled(flagKey, source))
    }),
  )

  return entries.filter((entry) => {
    if (!entry.flag) {
      return true
    }
    return enabledByFlag.get(entry.flag) === true
  })
}

// 内部の flag key を公開 loader データへ流さない (hydration payload 経由で
// 匿名閲覧者に内部名が見えるため)。
function withoutFlag(entry: UpdateEntry): UpdateEntry {
  const { flag: _flag, notice: _notice, ...publicEntry } = entry
  return publicEntry
}

export function toListItem(entry: UpdateEntry): UpdateListItem {
  const { bodyHtml: _bodyHtml, flag: _flag, notice: _notice, ...item } = entry
  return item
}

export function toDetail(entry: UpdateEntry): UpdateDetail {
  const {
    summaryHtml: _summaryHtml,
    hasMore: _hasMore,
    flag: _flag,
    notice: _notice,
    ...detail
  } = entry
  return detail
}

export async function getVisibleUpdates(
  locale: UpdateLocale,
  product?: UpdateProduct,
  source: FlagshipSource = env,
): Promise<UpdateEntry[]> {
  const entries = getAllUpdates(locale, product)
  const visible = await filterByFlagVisibility(entries, source)
  return visible.map(withoutFlag)
}

export async function getVisibleUpdateBySlug(
  slug: string,
  locale: UpdateLocale,
  source: FlagshipSource = env,
): Promise<UpdateEntry | undefined> {
  const entry = getUpdateBySlug(slug, locale)
  if (!entry) {
    return undefined
  }

  if (!entry.flag) {
    return withoutFlag(entry)
  }

  const enabled = await isFlagEnabled(entry.flag, source)
  return isUpdateEntryVisible(entry, enabled) ? withoutFlag(entry) : undefined
}

export async function getLatestVisibleNotice(
  locale: UpdateLocale = 'en',
  source: FlagshipSource = env,
  now = new Date(),
): Promise<UpdateEntry | undefined> {
  const visible = await filterByFlagVisibility(getAllUpdates(locale), source)
  const noticeWindowMs = NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  return visible.find((entry) => {
    const publishedAt = Date.parse(`${entry.date}T00:00:00Z`)
    return (
      entry.notice === true &&
      publishedAt <= now.getTime() &&
      now.getTime() < publishedAt + noticeWindowMs
    )
  })
}
