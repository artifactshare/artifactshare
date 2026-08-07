const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
])

export function normalizeEmailDomain(value?: string | null): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed) return null
  const domain = trimmed.includes('@') ? trimmed.split('@').at(-1) : trimmed
  return domain || null
}

export function isPublicEmailDomain(domain?: string | null): boolean {
  const normalized = normalizeEmailDomain(domain)
  return normalized ? PUBLIC_EMAIL_DOMAINS.has(normalized) : false
}
