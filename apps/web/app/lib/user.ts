export interface SessionUser {
  id: string
  email: string
  // Whether the email is proven (Google / verified Microsoft / email-code).
  // Email-grant access (shareable_grants / project_share_defaults) is gated on
  // this, so an unverified address (a Microsoft tenant that asserts no
  // verification) can't reach content shared to an email it hasn't proven.
  emailVerified: boolean
  name: string | null
  image: string | null
  workspaceId: string
  selfUploadEnabled?: boolean
  hd: string | null
  msTenantId: string | null
  locale: string | null
  // 'human' | 'bot'. Bots are workspace automation members: they never hold
  // cookie sessions (resolution rejects them) and only authenticate via
  // restricted agent-preset CLI credentials.
  kind: 'human' | 'bot'
}

export function isOrgWorkspace(user: {
  hd: string | null
  msTenantId?: string | null
}): boolean {
  return user.hd !== null || (user.msTenantId ?? null) !== null
}

/** UI-friendly subset rendered in the topbar / avatar / viewer chrome. */
export interface UserInfo {
  /** Stable, opaque — feeds avatarSlotFor() for deterministic color. */
  id: string
  email: string
  name: string | null
  /** Google profile picture URL, or null if the user has none. */
  image: string | null
  initial: string
}

export function toUserInfo(user: SessionUser): UserInfo {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    initial: getOwnerInitial(user.name, user.email),
  }
}

export function getOwnerInitial(name: string | null, email: string): string {
  return (name?.[0] ?? email[0] ?? '?').toUpperCase()
}

/**
 * Cheap stable hash → 1..6, picks an `--avatar-N` token. djb2-style;
 * collisions are fine, we only need uniformity across users.
 */
export function avatarSlotFor(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i)
  }
  return ((h >>> 0) % 6) + 1
}
