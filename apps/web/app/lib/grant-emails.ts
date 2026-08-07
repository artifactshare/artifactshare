export const MAX_GRANT_EMAILS = 50

export function isValidGrantEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
}

// メール群を正規化・検証・重複排除する。owner を渡すと自分を除外する。
// 文字列入力 (parseGrantEmails) と配列入力 (サーバー側の保存) の両方で使う。
export function normalizeGrantEmailList(
  emails: Iterable<string>,
  ownerEmail?: string | null,
): string[] {
  const owner = normalizeGrantEmail(ownerEmail)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of emails) {
    const email = normalizeGrantEmail(raw)
    if (!isValidGrantEmail(email) || email === owner || seen.has(email))
      continue
    seen.add(email)
    out.push(email)
  }
  return out
}

export function parseGrantEmails(
  value: string,
  ownerEmail?: string | null,
): string[] {
  return normalizeGrantEmailList(value.split(/[\s,]+/), ownerEmail)
}

export function normalizeGrantEmail(email?: string | null): string {
  return email?.trim().toLowerCase() ?? ''
}

// workspace のドメイン (hd) を持たない、または別ドメインなら組織外とみなす。
export function isExternalEmail(
  email: string,
  workspaceHd?: string | null,
): boolean {
  if (!workspaceHd) return false
  const domain = email.split('@')[1]?.toLowerCase()
  return Boolean(domain) && domain !== workspaceHd.toLowerCase()
}

export function isExternalAuthorEmail(
  email: string,
  workspaceHd?: string | null,
  selfEmail?: string | null,
): boolean {
  if (workspaceHd) return isExternalEmail(email, workspaceHd)
  const self = normalizeGrantEmail(selfEmail)
  if (!self) return false
  return normalizeGrantEmail(email) !== self
}
