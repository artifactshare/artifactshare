import type { z } from 'zod'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a wire value with the shared public contract without rewriting it. */
export function isContract<T extends z.ZodType>(
  schema: T,
  value: unknown,
): value is z.infer<T> {
  return schema.safeParse(value).success
}

export function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
