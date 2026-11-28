export interface SessionUser {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
  workspaceId: string
  selfUploadEnabled?: boolean
  hd: string | null
  msTenantId: string | null
  locale: string | null
  kind: 'human' | 'bot'
}

export function isOrgWorkspace(user: {
  hd: string | null
  msTenantId?: string | null
}): boolean {
  return user.hd !== null || (user.msTenantId ?? null) !== null
}

export interface UserInfo {
  id: string
  email: string
  name: string | null
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

export function avatarSlotFor(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i)
  }
  return ((h >>> 0) % 6) + 1
}
