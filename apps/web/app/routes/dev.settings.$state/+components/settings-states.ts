import {
  BILLING_PRICES,
  PLAN_STORAGE_QUOTA_BYTES,
  STORAGE_OVERAGE_PRICES,
  type BillingPlan,
} from '~/lib/billing-prices'
import { isViteDev } from '~/lib/is-vite-dev'
import type { WorkspaceLinkPolicy } from '~/lib/link-sharing-policy'
import type {
  AuditEventEntry,
  AuditEventsPageResult,
  InventoryArtifactEntry,
  InventoryProjectEntry,
  TeamContributor,
  TeamMember,
  WorkspaceMemberRole,
} from '~/lib/team-management'
import type { MembersLoaderData } from '~/routes/_protected/settings/+components/members-page'
import type { TokensLoaderData } from '~/routes/_protected/settings/+components/ai-tools-page'
import type { BotsLoaderData } from '~/routes/_protected/settings/+components/bots-page'
import type { ExternalAccessLoaderData } from '~/routes/_protected/settings/+components/external-access-page'
import type { IntegrationsLoaderData } from '~/routes/_protected/settings/+components/integrations-page'
import type { InventoryProjectsLoaderData } from '~/routes/_protected/settings/_content/inventory/+components/projects-page'
import type { InventoryArtifactsLoaderData } from '~/routes/_protected/settings/_content/inventory/+components/artifacts-page'
import type { BillingLoaderData } from '~/routes/_protected/settings/+components/billing-page'
import type { GeneralLoaderData } from '~/routes/_protected/settings/+components/general-page'
import type { SettingsLoaderData } from '~/routes/_protected/settings/_layout'
import { planTier } from '~/lib/plan-tier'

export interface SettingsPageData {
  tokens: TokensLoaderData
  analytics: Record<string, never>
  members: MembersLoaderData
  bots: BotsLoaderData
  externalAccess: ExternalAccessLoaderData
  integrations: IntegrationsLoaderData
  activity: AuditEventsPageResult
  inventoryProjects: InventoryProjectsLoaderData
  inventoryArtifacts: InventoryArtifactsLoaderData
  billing: BillingLoaderData
  general: GeneralLoaderData
}

export type SettingsPageId = keyof SettingsPageData

export const SETTINGS_PAGE_PATHS = {
  tokens: 'tokens',
  analytics: 'analytics',
  members: '.',
  bots: 'bots',
  externalAccess: 'external-access',
  integrations: 'integrations',
  activity: 'activity',
  inventoryProjects: 'inventory/projects',
  inventoryArtifacts: 'inventory/artifacts',
  billing: 'billing',
  general: 'general',
} satisfies Record<SettingsPageId, string>

interface SettingsState {
  description: string
  shell: SettingsLoaderData
  pages: Partial<SettingsPageData>
}

const MB = 1024 ** 2
const GB = 1024 ** 3
const PERIOD_START = '2029-12-01T00:00:00.000Z'
const RENEWS_AT = '2030-01-01T00:00:00.000Z'

const PEOPLE = {
  aoi: { id: 'user-aoi', name: 'Aoi Tanaka', email: 'aoi.tanaka@example.test' },
  kenji: {
    id: 'user-kenji',
    name: 'Kenji Sato',
    email: 'kenji.sato@example.test',
  },
  maya: { id: 'user-maya', name: 'Maya Chen', email: 'maya.chen@example.test' },
  ren: {
    id: 'user-ren',
    name: 'Ren Kobayashi',
    email: 'ren.kobayashi@example.test',
  },
  yui: { id: 'user-yui', name: 'Yui Suzuki', email: 'yui.suzuki@example.test' },
  lucas: {
    id: 'user-lucas',
    name: 'Lucas Martin',
    email: 'lucas.martin@example.test',
  },
  hana: { id: 'user-hana', name: 'Hana Ito', email: 'hana.ito@example.test' },
}

function person(key: keyof typeof PEOPLE): TeamMember {
  return { ...PEOPLE[key], image: null, kind: 'human' }
}

function shell(
  plan: BillingPlan,
  storageUsedBytes: number,
  role: WorkspaceMemberRole = 'owner',
): SettingsLoaderData {
  const user = PEOPLE[role === 'member' ? 'ren' : 'aoi']
  return {
    kind: planTier(plan) === 'team' ? 'team' : 'upgrade',
    workspace: {
      id: 'fixture-workspace',
      name: 'Aozora Studio',
      hd: null,
      plan,
      storageUsedBytes,
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES[plan],
    },
    currentUserIsAdmin: role !== 'member',
    currentUserRole: role,
    user: { ...user, image: null, initial: user.name.charAt(0) },
  }
}

export const JOINED_PROJECTS = [
  { id: 'project-website', name: 'Website redesign', newCount: 3 },
  { id: 'project-launch', name: 'Q4 launch campaign', newCount: 0 },
  { id: 'project-research', name: 'User research 2026', newCount: 1 },
]

function subscription(plan: 'plus' | 'team', overageGb: number) {
  const amount = BILLING_PRICES[plan].jpy.month
  const overageAmount = overageGb * STORAGE_OVERAGE_PRICES.jpy
  return {
    stripeSubscriptionStatus: 'active',
    hasSubscription: true,
    contract: {
      plan,
      interval: 'monthly',
      currency: 'jpy',
      amount,
      renewsAt: RENEWS_AT,
      cancelAtPeriodEnd: false,
    },
    monthlyEstimate: {
      currency: 'jpy',
      planAmount: amount,
      overageAmount,
      totalAmount: amount + overageAmount,
      planCharge: 'upcoming',
      cancelAtPeriodEnd: false,
      planDate: RENEWS_AT,
      overageGb,
      overageEnabled: true,
    },
    showOverageProjection: true,
    includedBytes: PLAN_STORAGE_QUOTA_BYTES[plan],
    overageProjection: {
      gb: overageGb,
      currency: 'jpy',
      amount: overageAmount,
    },
  } satisfies Partial<BillingLoaderData>
}

const FREE: BillingLoaderData = {
  canManage: true,
  stripeSubscriptionStatus: 'none',
  hasSubscription: false,
  billingConfigured: true,
  defaultCurrency: 'jpy',
  initialPlan: 'team',
  initialInterval: 'monthly',
  activeProjectCount: 2,
  projectLimit: 5,
  entryContext: 'default',
  externalPostingEnabled: false,
  contract: null,
  monthlyEstimate: null,
  showOverageProjection: false,
  includedBytes: PLAN_STORAGE_QUOTA_BYTES.free,
  overageProjection: null,
  contributorCount: null,
}

const TEAM_SUBSCRIPTION = subscription('team', 0)

const TEAM: BillingLoaderData = {
  ...FREE,
  ...TEAM_SUBSCRIPTION,
  activeProjectCount: 12,
  projectLimit: null,
  externalPostingEnabled: true,
  contributorCount: 6,
}

function contributor(
  key: keyof typeof PEOPLE,
  role: WorkspaceMemberRole,
  firstContributedAt: string | null,
  lastContributedAt: string | null,
): TeamContributor {
  return {
    ...person(key),
    firstContributedAt,
    lastContributedAt,
    pendingUploads: 0,
    isAdmin: role !== 'member',
    role,
  }
}

function members(
  rows: TeamContributor[],
  removedMembers: MembersLoaderData['removedMembers'],
): MembersLoaderData {
  return {
    membersPage: { members: rows, total: rows.length, page: 1 },
    removedMembers,
    filters: { query: '', role: 'all', activity: 'all', page: 1 },
  }
}

const AOI = contributor(
  'aoi',
  'owner',
  '2026-02-03T01:00:00.000Z',
  '2026-11-26T00:40:00.000Z',
)
const MAYA = contributor(
  'maya',
  'member',
  '2026-03-11T05:20:00.000Z',
  '2026-11-25T09:15:00.000Z',
)
const LUCAS = contributor('lucas', 'member', null, null)

const TEAM_MEMBERS = [
  AOI,
  contributor(
    'kenji',
    'admin',
    '2026-02-05T02:30:00.000Z',
    '2026-11-24T07:00:00.000Z',
  ),
  MAYA,
  contributor(
    'ren',
    'member',
    '2026-06-18T04:10:00.000Z',
    '2026-11-19T03:45:00.000Z',
  ),
  contributor(
    'yui',
    'member',
    '2026-09-02T00:00:00.000Z',
    '2026-10-30T06:20:00.000Z',
  ),
  LUCAS,
]

const OWNER_TOKENS: TokensLoaderData = {
  tokens: [
    {
      id: 'token-ci-preview',
      name: 'CI preview uploads',
      createdAt: '2026-10-15T06:30:00.000Z',
      lastUsedAt: '2026-11-26T00:45:00.000Z',
    },
    {
      id: 'token-weekly-report',
      name: 'Weekly report export',
      createdAt: '2026-08-04T03:00:00.000Z',
      lastUsedAt: '2026-11-23T23:00:00.000Z',
    },
    {
      id: 'token-figma-sync',
      name: 'Figma frame sync (old)',
      createdAt: '2026-03-02T01:00:00.000Z',
      lastUsedAt: null,
    },
  ],
  createdToken: null,
  cliFamilies: [
    {
      familyId: 'q8Fz3LkWm2Tn7RbXc4Hd9',
      deviceName: 'Studio MacBook Pro',
      preset: 'unrestricted',
      publisherClientName: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastUsedAt: '2026-11-26T00:10:00.000Z',
    },
    {
      familyId: 'Ka7Np2Vx9QsLe4Mr8Tz1W',
      deviceName: 'Render workstation',
      preset: 'agent',
      publisherClientName: null,
      createdAt: '2026-10-20T08:00:00.000Z',
      lastUsedAt: '2026-11-25T12:30:00.000Z',
    },
    {
      familyId: 'Bn5Ty7Jc2Wq9Ld3Rk6Pm0',
      deviceName: null,
      preset: 'publisher',
      publisherClientName: 'Release pipeline',
      createdAt: '2026-07-14T02:00:00.000Z',
      lastUsedAt: '2026-11-21T04:00:00.000Z',
    },
  ],
}

const MEMBER_TOKENS: TokensLoaderData = {
  tokens: [
    {
      id: 'token-ren-notes',
      name: 'Meeting notes publisher',
      createdAt: '2026-09-10T02:00:00.000Z',
      lastUsedAt: '2026-11-19T03:40:00.000Z',
    },
  ],
  createdToken: null,
  cliFamilies: [
    {
      familyId: 'Hs4Gk8Xv1Np6Cq3Zt7Lm2',
      deviceName: 'Ren’s ThinkPad',
      preset: 'unrestricted',
      publisherClientName: null,
      createdAt: '2026-06-18T04:00:00.000Z',
      lastUsedAt: '2026-11-19T03:45:00.000Z',
    },
  ],
}

const WEBSITE = { id: 'project-website', name: 'Website redesign' }
const LAUNCH = { id: 'project-launch', name: 'Q4 launch campaign' }

const TEAM_BOTS: BotsLoaderData = {
  botCreationEnabled: true,
  bots: [
    {
      id: 'bot-release-notes',
      name: 'Release notes bot',
      email: 'release-notes.bot@example.test',
      botStoppedAt: null,
      projectId: WEBSITE.id,
      projectName: WEBSITE.name,
      projectNameSnapshot: WEBSITE.name,
      credentialLive: true,
      lastAuthAt: '2026-11-26T01:05:00.000Z',
      cancelable: false,
      destinationsEditable: true,
      destinationRevision: 'fixture-1',
      approvedProjects: [
        { ...WEBSITE, unavailable: false },
        { ...LAUNCH, unavailable: false },
      ],
    },
    {
      id: 'bot-nightly-qa',
      name: 'Nightly QA screenshots',
      email: 'nightly-qa.bot@example.test',
      botStoppedAt: null,
      projectId: LAUNCH.id,
      projectName: LAUNCH.name,
      projectNameSnapshot: LAUNCH.name,
      credentialLive: false,
      lastAuthAt: '2026-10-29T18:00:00.000Z',
      cancelable: false,
      destinationsEditable: true,
      destinationRevision: 'fixture-1',
      approvedProjects: [{ ...LAUNCH, unavailable: false }],
    },
    {
      id: 'bot-survey-import',
      name: 'Survey importer',
      email: 'survey-import.bot@example.test',
      botStoppedAt: '2026-09-12T03:00:00.000Z',
      projectId: null,
      projectName: null,
      projectNameSnapshot: 'User research 2026',
      credentialLive: false,
      lastAuthAt: '2026-09-11T22:00:00.000Z',
      cancelable: false,
    },
  ],
}

const FREE_POLICY: WorkspaceLinkPolicy = {
  plan: 'free',
  linkSharingEnabled: true,
  externalPostingEnabled: false,
  linkExpiryDefaultDays: 30,
  linkExpiryMaxDays: null,
}

const TEAM_POLICY: WorkspaceLinkPolicy = {
  plan: 'team',
  linkSharingEnabled: true,
  externalPostingEnabled: true,
  linkExpiryDefaultDays: 30,
  linkExpiryMaxDays: 90,
}

const TEAM_INTEGRATIONS: IntegrationsLoaderData = {
  connections: [
    {
      id: 'slack-aozora',
      teamName: 'Aozora Studio',
      installedAt: '2026-04-08T02:00:00.000Z',
      installedByName: 'Aoi Tanaka',
      needsReauthorization: false,
    },
    {
      id: 'slack-partners',
      teamName: 'Aozora × Partners',
      installedAt: '2026-08-21T06:30:00.000Z',
      installedByName: 'Kenji Sato',
      needsReauthorization: true,
    },
  ],
}

function event(
  id: string,
  action: string,
  createdAt: string,
  actor: TeamMember | null,
  subject: TeamMember | null,
  detail: AuditEventEntry['detail'] = {},
): AuditEventEntry {
  return { id, action, createdAt, actor, subject, detail }
}

function activity(events: AuditEventEntry[]): AuditEventsPageResult {
  return { events, total: events.length, page: 1 }
}

const LAUNCH_DECK_REQUEST = {
  artifactTitle: 'Launch deck',
  projectName: LAUNCH.name,
  requesterName: 'Sam Rivera',
  requesterEmail: 'sam@example.org',
  accessRequestId: '7f3c9a12-5be0-4d8e-9a41-2c6f0b1e8d33',
}

const RELEASE_BOT = {
  id: 'bot-release-notes',
  name: 'Release notes bot',
  email: 'release-notes.bot@example.test',
  image: null,
  kind: 'bot',
} satisfies TeamMember

const TEAM_ACTIVITY = activity([
  event(
    'event-9',
    'access_request.approved',
    '2026-11-26T00:55:00.000Z',
    person('aoi'),
    null,
    { ...LAUNCH_DECK_REQUEST, resolutionScope: 'artifact' },
  ),
  event(
    'event-8',
    'access_request.email.succeeded',
    '2026-11-25T23:41:00.000Z',
    null,
    null,
    { ...LAUNCH_DECK_REQUEST, recipientEmail: PEOPLE.aoi.email },
  ),
  event(
    'event-7',
    'access_request.created',
    '2026-11-25T23:40:00.000Z',
    null,
    null,
    { ...LAUNCH_DECK_REQUEST, handlerEmail: PEOPLE.aoi.email },
  ),
  event(
    'event-6',
    'bot.create',
    '2026-11-24T05:10:00.000Z',
    person('kenji'),
    RELEASE_BOT,
    { name: RELEASE_BOT.name },
  ),
  event(
    'event-5',
    'admin.grant',
    '2026-11-20T02:00:00.000Z',
    person('aoi'),
    person('kenji'),
    { fromRole: 'member', toRole: 'admin' },
  ),
  event(
    'event-4',
    'artifact.delete',
    '2026-11-18T08:30:00.000Z',
    person('maya'),
    null,
    { name: 'Moodboard draft (old)' },
  ),
  event(
    'event-3',
    'member.remove',
    '2026-11-12T01:15:00.000Z',
    person('aoi'),
    person('hana'),
    { name: PEOPLE.hana.name, email: PEOPLE.hana.email },
  ),
  event(
    'event-2',
    'cli.refresh_credential.revoke',
    '2026-11-03T04:00:00.000Z',
    person('kenji'),
    person('yui'),
  ),
  event(
    'event-1',
    'plan.change',
    '2026-11-01T00:00:00.000Z',
    person('aoi'),
    null,
    { from: 'plus', to: 'team' },
  ),
])

const FREE_ACTIVITY = activity([
  event(
    'event-3',
    'artifact.delete',
    '2026-11-22T10:00:00.000Z',
    person('maya'),
    null,
    { name: 'Logo sketches v1' },
  ),
  event(
    'event-2',
    'admin.revoke',
    '2026-11-05T02:00:00.000Z',
    person('aoi'),
    person('maya'),
    { fromRole: 'admin', toRole: 'member' },
  ),
  event(
    'event-1',
    'admin.grant',
    '2026-11-04T02:00:00.000Z',
    person('aoi'),
    person('maya'),
    { fromRole: 'member', toRole: 'admin' },
  ),
])

const PROJECTS: InventoryProjectEntry[] = [
  {
    ...WEBSITE,
    archivedAt: null,
    baseVisibility: 'workspace',
    artifactCount: 42,
    sizeBytes: Math.round(1.8 * GB),
    updatedAt: '2026-11-26T00:40:00.000Z',
  },
  {
    ...LAUNCH,
    archivedAt: null,
    baseVisibility: 'private',
    artifactCount: 18,
    sizeBytes: 640 * MB,
    updatedAt: '2026-11-25T09:15:00.000Z',
  },
  {
    id: 'project-research',
    name: 'User research 2026',
    archivedAt: null,
    baseVisibility: 'workspace',
    artifactCount: 27,
    sizeBytes: Math.round(2.3 * GB),
    updatedAt: '2026-11-19T03:45:00.000Z',
  },
  {
    id: 'project-brand',
    name: 'Brand guidelines',
    archivedAt: null,
    baseVisibility: 'workspace',
    artifactCount: 9,
    sizeBytes: 210 * MB,
    updatedAt: '2026-10-30T06:20:00.000Z',
  },
  {
    id: 'project-offsite',
    name: '2025 offsite',
    archivedAt: '2026-02-10T00:00:00.000Z',
    baseVisibility: 'private',
    artifactCount: 6,
    sizeBytes: 96 * MB,
    updatedAt: '2026-02-10T00:00:00.000Z',
  },
]

function owner(key: keyof typeof PEOPLE) {
  return { name: PEOPLE[key].name, email: PEOPLE[key].email }
}

const ARTIFACTS: InventoryArtifactEntry[] = [
  {
    id: 'artifact-homepage',
    name: 'Homepage v3 prototype',
    owner: owner('maya'),
    location: { kind: 'project', name: WEBSITE.name },
    visibility: 'workspace',
    sizeBytes: 18 * MB,
    updatedAt: '2026-11-26T00:40:00.000Z',
  },
  {
    id: 'artifact-launch-deck',
    name: 'Launch deck.pdf',
    owner: owner('aoi'),
    location: { kind: 'project', name: LAUNCH.name },
    visibility: 'link',
    sizeBytes: Math.round(6.2 * MB),
    updatedAt: '2026-11-25T09:15:00.000Z',
  },
  {
    id: 'artifact-onboarding',
    name: 'Onboarding walkthrough.mp4',
    owner: owner('kenji'),
    location: { kind: 'project', name: WEBSITE.name },
    visibility: 'project',
    sizeBytes: 182 * MB,
    updatedAt: '2026-11-24T07:00:00.000Z',
  },
  {
    id: 'artifact-interviews',
    name: 'Interview notes, round 2',
    owner: owner('yui'),
    location: { kind: 'project', name: 'User research 2026' },
    visibility: 'project',
    sizeBytes: 48 * 1024,
    updatedAt: '2026-11-19T03:45:00.000Z',
  },
  {
    id: 'artifact-pricing',
    name: 'Pricing page draft',
    owner: owner('ren'),
    location: { kind: 'inbox', name: '' },
    visibility: 'private',
    sizeBytes: Math.round(2.1 * MB),
    updatedAt: '2026-11-18T02:00:00.000Z',
  },
  {
    id: 'artifact-logo',
    name: 'Logo explorations',
    owner: owner('hana'),
    location: { kind: 'project', name: 'Brand guidelines' },
    visibility: 'workspace',
    sizeBytes: 34 * MB,
    updatedAt: '2026-10-30T06:20:00.000Z',
  },
]

function teamPages(billing: BillingLoaderData, tokens: TokensLoaderData) {
  return {
    tokens,
    analytics: {},
    externalAccess: { policy: TEAM_POLICY },
    integrations: TEAM_INTEGRATIONS,
    billing,
    general: { owner: person('aoi') },
  } satisfies Partial<SettingsPageData>
}

export const SETTINGS_STATES = {
  free: {
    description: 'Free workspace seen by its owner, with room to spare',
    shell: shell('free', 12 * MB),
    pages: {
      members: members([AOI, MAYA, LUCAS], []),
      tokens: OWNER_TOKENS,
      analytics: {},
      bots: { bots: [], botCreationEnabled: true },
      externalAccess: { policy: FREE_POLICY },
      integrations: { connections: [] },
      activity: FREE_ACTIVITY,
      billing: FREE,
      general: { owner: person('aoi') },
    },
  },
  'free-near-limit': {
    description: 'Free plan at 92% of its storage',
    shell: shell('free', Math.round(PLAN_STORAGE_QUOTA_BYTES.free * 0.92)),
    pages: { billing: FREE },
  },
  'free-unconfigured': {
    description: 'Free plan on a stack without Stripe values',
    shell: shell('free', 12 * MB),
    pages: { billing: { ...FREE, billingConfigured: false } },
  },
  'team-subscribed': {
    description: 'Team workspace seen by its owner, contract in good standing',
    shell: shell('team', 18 * GB),
    pages: {
      ...teamPages(TEAM, OWNER_TOKENS),
      members: members(TEAM_MEMBERS, [
        { ...person('hana'), ownedArtifactCount: 7 },
      ]),
      bots: TEAM_BOTS,
      activity: TEAM_ACTIVITY,
      inventoryProjects: {
        projects: { projects: PROJECTS, total: PROJECTS.length, page: 1 },
      },
      inventoryArtifacts: {
        artifacts: { artifacts: ARTIFACTS, total: ARTIFACTS.length, page: 1 },
        filters: { visibility: 'all', sort: 'updated', page: 1 },
      },
    },
  },
  'team-past-due': {
    description: 'Team contract whose last payment failed',
    shell: shell('team', 18 * GB),
    pages: {
      billing: {
        ...TEAM,
        stripeSubscriptionStatus: 'past_due',
        monthlyEstimate: {
          ...TEAM_SUBSCRIPTION.monthlyEstimate,
          planCharge: 'unpaid',
          planDate: PERIOD_START,
        },
      },
    },
  },
  'team-cancel-scheduled': {
    description: 'Team contract set to end at the period end',
    shell: shell('team', 18 * GB),
    pages: {
      billing: {
        ...TEAM,
        contract: { ...TEAM_SUBSCRIPTION.contract, cancelAtPeriodEnd: true },
        monthlyEstimate: {
          ...TEAM_SUBSCRIPTION.monthlyEstimate,
          planAmount: 0,
          totalAmount: 0,
          planCharge: 'none',
          cancelAtPeriodEnd: true,
        },
      },
    },
  },
  'team-overage': {
    description: 'Team workspace 12 GB past its included storage',
    shell: shell('team', PLAN_STORAGE_QUOTA_BYTES.team + 12 * GB),
    pages: { billing: { ...TEAM, ...subscription('team', 12) } },
  },
  'team-member': {
    description: 'Team workspace seen by a member, who manages none of it',
    shell: shell('team', 18 * GB, 'member'),
    pages: {
      ...teamPages(
        { ...TEAM, canManage: false, contract: null, monthlyEstimate: null },
        MEMBER_TOKENS,
      ),
      members: members(TEAM_MEMBERS, []),
    },
  },
  'plus-overage': {
    description: 'Plus workspace 2 GB past its included storage',
    shell: shell('plus', PLAN_STORAGE_QUOTA_BYTES.plus + 2 * GB),
    pages: {
      billing: {
        ...TEAM,
        ...subscription('plus', 2),
        activeProjectCount: 8,
        projectLimit: 20,
        entryContext: 'plusOverage',
        contributorCount: null,
      },
    },
  },
} satisfies Record<string, SettingsState>

export type SettingsStateId = keyof typeof SETTINGS_STATES

export const SETTINGS_STATE_IDS = Object.keys(
  SETTINGS_STATES,
) as SettingsStateId[]

function isSettingsStateId(value: unknown): value is SettingsStateId {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_STATES, value)
}

export function requireSettingsState(state: string | undefined): SettingsState {
  if (!isViteDev() || !isSettingsStateId(state))
    throw new Response(null, { status: 404 })
  return SETTINGS_STATES[state]
}

export function requireSettingsPage<P extends SettingsPageId>(
  state: string | undefined,
  page: P,
): SettingsPageData[P] {
  const data = requireSettingsState(state).pages[page]
  if (!data) throw new Response(null, { status: 404 })
  return data
}
