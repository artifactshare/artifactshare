export function parsePageParam(searchParams: URLSearchParams): number {
  const page = Number.parseInt(searchParams.get('page') ?? '1', 10)
  return Number.isFinite(page) && page >= 1 ? page : 1
}
