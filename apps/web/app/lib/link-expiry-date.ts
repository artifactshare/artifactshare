function localDateParts(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function toLocalDateInputValue(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : localDateParts(date)
}

export function addDaysToLocalDate(days: number, now = new Date()): string {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return localDateParts(date)
}

export function maximumSelectableLocalDate(
  maximumDays: number,
  now = new Date(),
): string {
  const cutoff = new Date(now.getTime() + maximumDays * 24 * 60 * 60 * 1000)
  const candidate = localDateParts(cutoff)
  const candidateEnd = localDateEndAsUtc(candidate)
  if (candidateEnd && Date.parse(candidateEnd) <= cutoff.getTime())
    return candidate
  cutoff.setDate(cutoff.getDate() - 1)
  return localDateParts(cutoff)
}

export function clampLocalDateToMaximum(
  value: string | null,
  maximum: string | undefined,
): string | null {
  return value && maximum && value > maximum ? maximum : value
}

export function localDateEndAsUtc(value: string | null): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
    999,
  )
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null
  }
  return date.toISOString()
}
