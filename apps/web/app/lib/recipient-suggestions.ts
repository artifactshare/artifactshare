export const RECIPIENT_SUGGESTION_LIMIT = 8
export const RECIPIENT_SUGGESTION_QUERY_MAX_LENGTH = 100
export const RECIPIENT_SUGGESTION_PENDING_EMAIL_LIMIT = 50

const CJK_OR_KANA_RE =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u

export type RecipientSuggestionContext =
  | { kind: 'upload' }
  | { kind: 'shareable'; id: string }
  | { kind: 'project'; id: string }

export type RecipientSuggestion = {
  email: string
  user: {
    id: string
    name: string | null
    image: string | null
  } | null
  displayName: string | null
}

export function isRecipientSuggestionQuery(value: string): boolean {
  const query = value.trim()
  const length = Array.from(query).length
  if (length === 0) return false
  return CJK_OR_KANA_RE.test(query) ? length >= 1 : length >= 2
}
