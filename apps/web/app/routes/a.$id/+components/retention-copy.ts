import type { Translator } from '~/lib/i18n'

export function retentionSummary(
  count: number | null,
  managed: boolean | undefined,
  t: Translator['t'],
) {
  if (count === null) return t('vw.retentionSummaryAll')
  const keys = managed
    ? ({
        one: 'vw.retentionManagedNoteOne',
        other: 'vw.retentionManagedNoteOther',
      } as const)
    : ({ one: 'vw.retentionNoteOne', other: 'vw.retentionNoteOther' } as const)
  return t(count === 1 ? keys.one : keys.other, { count })
}
