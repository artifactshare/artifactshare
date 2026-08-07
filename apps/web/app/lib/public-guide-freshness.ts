export const PUBLIC_GUIDE_KEYS = {
  connect: 'connect',
  workspaceOwner: 'workspace-owner',
  workspaceAdmin: 'workspace-admin',
  linkSharing: 'link-sharing',
  privateMobileDesignHandoff: 'private-mobile-design-handoff',
} as const

export type PublicGuideKey =
  (typeof PUBLIC_GUIDE_KEYS)[keyof typeof PUBLIC_GUIDE_KEYS]

export const PUBLIC_GUIDE_VERIFIED_DATES = {
  [PUBLIC_GUIDE_KEYS.connect]: '2026-07-18',
  [PUBLIC_GUIDE_KEYS.workspaceOwner]: '2026-07-18',
  [PUBLIC_GUIDE_KEYS.workspaceAdmin]: '2026-07-18',
  [PUBLIC_GUIDE_KEYS.linkSharing]: '2026-07-21',
  [PUBLIC_GUIDE_KEYS.privateMobileDesignHandoff]: '2026-07-21',
} satisfies Record<PublicGuideKey, string>

export function getPublicGuideVerifiedDate(key: PublicGuideKey) {
  return PUBLIC_GUIDE_VERIFIED_DATES[key]
}
