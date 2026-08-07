import { Temporal } from '@js-temporal/polyfill'

export function timezoneDayUtcRange(dayKey: string, timeZone: string) {
  const start = Temporal.PlainDate.from(dayKey)
    .toZonedDateTime({ timeZone, plainTime: '00:00' })
    .toInstant()
  const end = Temporal.PlainDate.from(dayKey)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone, plainTime: '00:00' })
    .toInstant()
  return {
    start: start.toString({ fractionalSecondDigits: 3 }),
    end: end.toString({ fractionalSecondDigits: 3 }),
  }
}
