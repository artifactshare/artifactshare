import { expect } from 'vitest'

type ApiErrorBody = {
  error?: { code?: string; message?: string; details?: unknown }
}

/**
 * Callers recover from an API failure by its status and code: the CLI maps the
 * code to its own advice, and the browser maps it to a catalog message. The
 * message in the body is prose for whoever reads the raw response, so require
 * that one is present instead of holding the route to its current wording.
 */
export async function expectApiError(
  response: Response,
  expected: {
    status: number
    code: string
    details?: Record<string, unknown>
  },
) {
  expect(response.status).toBe(expected.status)
  const body = (await response.json()) as ApiErrorBody
  expect(body.error?.code).toBe(expected.code)
  expect(body.error?.message).toMatch(/\S/)
  if (expected.details) expect(body.error?.details).toEqual(expected.details)
  return body.error
}
