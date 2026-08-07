import type { ShouldRevalidateFunctionArgs } from 'react-router'

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // The root loader's forced ja can stay stale during client navigation home.
  const fromJapanesePublicPage =
    currentUrl.pathname === '/ja' || currentUrl.pathname.startsWith('/ja/')
  return fromJapanesePublicPage && nextUrl.pathname === '/'
    ? true
    : defaultShouldRevalidate
}
