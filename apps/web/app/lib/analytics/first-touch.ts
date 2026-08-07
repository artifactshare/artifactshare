export const FIRST_TOUCH_COOKIE = '__as_first_touch'
export const FIRST_TOUCH_MAX_AGE_SECONDS = 1800

export interface FirstTouch {
  utm?: Partial<
    Record<
      'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_term' | 'utm_content',
      string
    >
  >
  referrerDomain?: string
  artifactId?: string
}

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const

export function utmFromSearch(search: string): FirstTouch['utm'] {
  const params = new URLSearchParams(search)
  const utm = Object.fromEntries(
    UTM_KEYS.flatMap((key) => {
      const value = params.get(key)
      return value ? [[key, value]] : []
    }),
  ) as FirstTouch['utm']
  return Object.keys(utm ?? {}).length ? utm : undefined
}

export function referrerDomainFromReferrer(
  referrer: string | null | undefined,
): string | undefined {
  if (!referrer) return undefined
  try {
    return new URL(referrer).host || undefined
  } catch {
    return undefined
  }
}

export function serializeFirstTouch(ft: FirstTouch): string {
  return JSON.stringify(ft)
}

export function parseFirstTouch(
  raw: string | null | undefined,
): FirstTouch | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const candidate = value as Record<string, unknown>
    if (
      candidate.artifactId !== undefined &&
      typeof candidate.artifactId !== 'string'
    )
      return null
    if (
      candidate.referrerDomain !== undefined &&
      typeof candidate.referrerDomain !== 'string'
    )
      return null
    if (
      candidate.utm !== undefined &&
      (!candidate.utm ||
        typeof candidate.utm !== 'object' ||
        Array.isArray(candidate.utm))
    )
      return null
    return value as FirstTouch
  } catch {
    return null
  }
}
