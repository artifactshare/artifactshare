export function displayTitle(s: {
  titleOverride: string | null
  derivedTitle: string | null
  name: string
}): string {
  return s.titleOverride ?? s.derivedTitle ?? s.name
}
