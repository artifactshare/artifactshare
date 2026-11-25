/**
 * Every primitive a route handed to a service, flattened out of its arguments.
 *
 * A loader's observable job is to pass on what the request and the session say.
 * How the service spells its parameters — positional arguments today, a single
 * options object tomorrow — is the service's own business, so compare the
 * values that reached it rather than the places they arrived in.
 */
export function serviceCallValues(args: readonly unknown[]): unknown[] {
  const values: unknown[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown) => {
    if (value === null || value === undefined) return
    if (typeof value === 'function') return
    if (typeof value !== 'object') {
      values.push(value)
      return
    }
    if (seen.has(value)) return
    seen.add(value)
    for (const inner of Object.values(value)) walk(inner)
  }
  for (const arg of args) walk(arg)
  return values
}
