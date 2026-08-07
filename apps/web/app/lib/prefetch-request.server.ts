const PREFETCH_HEADER_VALUES = ['prefetch', 'prerender']

export function isPrefetchRequest(request: Request): boolean {
  return (
    hasPrefetchHeader(request.headers.get('purpose')) ||
    hasPrefetchHeader(request.headers.get('sec-purpose')) ||
    hasPrefetchHeader(request.headers.get('x-moz'))
  )
}

function hasPrefetchHeader(value: string | null): boolean {
  if (!value) return false
  const tokens = value.toLowerCase().split(/[,\s;]+/)
  return PREFETCH_HEADER_VALUES.some((headerValue) =>
    tokens.includes(headerValue),
  )
}
