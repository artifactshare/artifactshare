import { env } from 'cloudflare:workers'

import { isFlagKeyOn, type FlagSource } from '~/lib/feature-flags.server'
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

async function filterByFlagVisibility(
  entries: UpdateEntry[],
  source: FlagSource,
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
      enabledByFlag.set(
        flagKey,
        await isFlagKeyOn(source, flagKey, FLAG_CONTEXT),
      )
    }),
  )

  return entries.filter((entry) => {
    if (!entry.flag) {
      return true
    }
    return enabledByFlag.get(entry.flag) === true
  })
}

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
  source: FlagSource = env,
): Promise<UpdateEntry[]> {
  const entries = getAllUpdates(locale, product)
  const visible = await filterByFlagVisibility(entries, source)
  return visible.map(withoutFlag)
}

export async function getVisibleUpdateBySlug(
  slug: string,
  locale: UpdateLocale,
  source: FlagSource = env,
): Promise<UpdateEntry | undefined> {
  const entry = getUpdateBySlug(slug, locale)
  if (!entry) {
    return undefined
  }

  if (!entry.flag) {
    return withoutFlag(entry)
  }

  const enabled = await isFlagKeyOn(source, entry.flag, FLAG_CONTEXT)
  return isUpdateEntryVisible(entry, enabled) ? withoutFlag(entry) : undefined
}

export async function getLatestVisibleNotice(
  locale: UpdateLocale = 'en',
  source: FlagSource = env,
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
