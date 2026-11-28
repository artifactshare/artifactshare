import type { ShouldRevalidateFunctionArgs } from 'react-router'

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const fromJapanesePublicPage =
    currentUrl.pathname === '/ja' || currentUrl.pathname.startsWith('/ja/')
  return fromJapanesePublicPage && nextUrl.pathname === '/'
    ? true
    : defaultShouldRevalidate
}
