import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import { INVENTORY_PAGE_SIZE } from '~/lib/team-management'
import { devPublisherUserCode } from '~/lib/dev-device-user-code'
import { CSP_DIAGNOSTIC_BODIES } from './dev-csp-diagnostic-fixtures'
import scenarioIds from '../../../../scripts/screen-scenarios.json'
import { env } from 'cloudflare:workers'
import { sql, type Kysely, type OnConflictBuilder } from 'kysely'
import { nanoid } from 'nanoid'
import { joinProject } from './project-membership.server'
import { nowIso } from '~/lib/datetime'
import {
  LINK_SHARING_PLAN_DEFAULTS,
  linkExpiryStartingColumns,
} from '~/lib/link-sharing-policy'
import type { DB } from '~/types/db'

export function devShareableId(seed: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const char of seed) {
    const code = char.codePointAt(0) ?? 0
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
  }
  const ordinal = /-file-(\d+)$/.exec(seed)?.[1]
  const prefix = ordinal
    ? Number.parseInt(ordinal, 10).toString(36).padStart(2, '0').slice(-2)
    : 'zz'
  return `${prefix}${first.toString(36).padStart(7, '0')}${second.toString(36).padStart(7, '0')}`.slice(
    0,
    10,
  )
}
import {
  createProjectContainer,
  getOrCreateInboxContainerId,
  INBOX_CONTAINER_NAME,
  updateProjectContainer,
} from './projects.server'
import { createApiToken } from './api-tokens.server'
import { createWorkspaceBot, stopWorkspaceBot } from './bot-members.server'
import {
  attachAgentBootstrapAuthority,
  attachPublisherBootstrapAuthority,
  loadDeviceAuthorizationIntent,
  selectAgentApprovalProject,
  selectPublisherApprovalClient,
  storeDeviceAuthorizationIntent,
} from './cli-device-authority.server'
import {
  CLI_DEVICE_SESSION_USER_AGENT,
  issueCliRefreshCredential,
} from './cli-refresh-credentials.server'
import { updateWorkspaceExternalAccessPolicy } from './link-sharing.server'
import { editShareableSettings } from './shareables.server'
import {
  ensureActiveWorkspaceMembership,
  grantWorkspaceAdmin,
  removeWorkspaceMember,
  restoreWorkspaceMember,
} from './team-management.server'
import {
  createStripeClient,
  isBillingConfigured,
  parseStripeApiOrigin,
  type BillingEnv,
} from './billing.server'
import { syncWorkspaceSubscription } from './billing-sync.server'

const SCREEN_SCENARIO_IDS = scenarioIds as readonly string[]
const screenScenarioAllowlist = new Set(SCREEN_SCENARIO_IDS)
// These scenarios require a header because browser navigations cannot attach it.
// Screens whose representative state comes from a display-only fixture keyed by
// the capture header. A browser navigation cannot set it, so /dev/sign-in must
// not offer them: the state would be seeded but never shown. The billing
// states instead need the local capture's fake Stripe configuration, which a
// developer's own dev server does not have.
export const HEADER_DEPENDENT_SCREEN_SCENARIOS: readonly string[] = [
  'settings-general/root-error',
  'settings-billing/subscribed',
  'settings-billing/purchase',
  'settings-billing/past-due',
  'settings-billing/near-limit',
  'settings-billing/continuing-near-limit',
  'viewer/revisit-context',
  'viewer/bridge-attribution',
  'search/capped',
  'search/error',
  'search/daily-limit',
  'search/palette-daily-limit',
  'search/continuation-error',
]

export function isScreenScenario(value: unknown): value is string {
  return typeof value === 'string' && screenScenarioAllowlist.has(value)
}

export function isDevScreenStateRequest(
  request: Request,
  scenario: string,
): boolean {
  return (
    import.meta.env.DEV &&
    isScreenScenario(scenario) &&
    request.headers.get('X-ArtifactShare-Dev-Screen-State') === scenario
  )
}

function scenarioWorkspaceId(
  plan: 'free' | 'plus' | 'team',
  scenario: string,
): string {
  return `dev-screen-${plan}-${scenario.replaceAll('/', '-')}`
}

export function devScreenUserEmail(persona: string, scenario: string): string {
  if (
    scenario === 'settings-general/long-owner' &&
    persona.endsWith('-owner')
  ) {
    return `${persona}-with-a-long-synthetic-owner-address-for-phone-layout@example.test`
  }
  return `dev-${persona}+${scenario.replaceAll('/', '-')}@artifactshare.local`
}

const RECENT_CONTENT_RICH_BODIES = {
  quarterlyReport: {
    version: 'v1',
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Quarterly report</title></head><body><main><h1>Quarterly report</h1><p>第2四半期の結果と、次の四半期に向けた見通しをまとめています。</p><h2>部門別の推移</h2><p>プロダクト部門は前月比12%増、営業部門は前月比8%増でした。</p></main></body></html>`,
  },
  archivedReview21: [
    {
      version: 'v1',
      html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Archived review 21</title></head><body><main><h1>Archived review 21</h1><p>前回閲覧時のレビュー記録です。</p><h2>確認事項</h2><p>公開前に担当者と日程を確認します。</p></main></body></html>`,
    },
    {
      version: 'v2',
      html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Archived review 21</title></head><body><main><h1>Archived review 21</h1><p>前回閲覧後に更新されたレビュー記録です。</p><h2>確認事項</h2><p>担当者の確認が完了し、公開日を8月20日に決定しました。</p><h2>今回の更新</h2><p>公開日と最終確認の結果を追記しました。</p></main></body></html>`,
    },
  ],
} as const

function recentContentRichBody(
  index: number,
  version: 'v1' | 'v2',
): string | null {
  if (index === 0 && version === 'v1')
    return RECENT_CONTENT_RICH_BODIES.quarterlyReport.html
  if (index === 20)
    return (
      RECENT_CONTENT_RICH_BODIES.archivedReview21.find(
        (entry) => entry.version === version,
      )?.html ?? null
    )
  return null
}

const managedRetentionScenarios = new Set([
  'viewer/retention-managed-owner',
  'viewer/retention-managed-older-current',
  'viewer/retention-managed-readonly',
  'viewer/retention-managed-unlimited',
])

function managedRetentionBody(number: number) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scheduled report</title></head><body><main><h1>Scheduled report</h1><p>${number <= 2 ? 'Reviewed by a person' : 'Scheduled data refresh'}: version ${number}.</p></main></body></html>`
}

/** Stores the deterministic viewer bodies owned by the recent task scenario. */
export async function seedDevScreenArtifactBodies(
  bucket: Pick<R2Bucket, 'put'> | undefined,
  scenario: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!bucket) return
  if (scenario.startsWith('search/')) {
    await seedDevScreenArtifactBodies(
      bucket,
      'recent/content-rich',
      workspaceId,
      userId,
    )
    // The recent fixture's second "Archived review 21" (file 22) has no body,
    // so the index would hold only one of the two same-title files. Give it
    // the earlier body so search shows a same-title group.
    await bucket.put(
      `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-22`)}-v1`,
      RECENT_CONTENT_RICH_BODIES.archivedReview21[0].html,
      { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
    )
    return
  }
  if (managedRetentionScenarios.has(scenario)) {
    await seedDevScreenArtifactBodies(
      bucket,
      scenario === 'viewer/retention-managed-readonly'
        ? 'viewer/revisit-context'
        : 'recent/content-rich',
      workspaceId,
      userId,
    )
    const index = scenario === 'viewer/retention-managed-readonly' ? 1 : 21
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-${index}`)
    await Promise.all(
      [1, 2, 3, 4].map((number) =>
        bucket.put(
          `dev-screen/${shareableId}-v${number}`,
          managedRetentionBody(number),
          {
            httpMetadata: { contentType: 'text/html; charset=utf-8' },
          },
        ),
      ),
    )
    return
  }

  if (scenario === 'viewer/scheduled-updates') {
    await seedDevScreenArtifactBodies(
      bucket,
      'recent/content-rich',
      workspaceId,
      userId,
    )
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-21`)
    await bucket.put(
      `dev-screen/${shareableId}-v3`,
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scheduled report</title></head><body><main><h1>Scheduled report</h1><p>Data refreshed by the hourly publisher.</p></main></body></html>',
      { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
    )
    return
  }
  if (
    scenario === 'viewer/retention-expanded' ||
    scenario === 'viewer/retention-saved'
  ) {
    scenario = 'recent/content-rich'
  }
  if (scenario === 'viewer/retention-removed') {
    await seedDevScreenArtifactBodies(
      bucket,
      'recent/content-rich',
      workspaceId,
      userId,
    )
    return
  }
  if (scenario === 'viewer/csp-diagnostics') {
    await Promise.all(
      CSP_DIAGNOSTIC_BODIES.map((html, index) =>
        bucket.put(
          `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-${index + 1}`)}-v1`,
          html,
          { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
        ),
      ),
    )
    return
  }
  if (scenario === 'viewer/bridge-attribution') {
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    await bucket.put(
      `dev-screen/${shareableId}-v1`,
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>市場調査レポート</title></head><body><main><h1>市場調査レポート</h1><p>bridge 経由で共有された成果物です。</p></main></body></html>',
      { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
    )
    return
  }
  if (scenario === 'viewer/revisit-context') {
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    await Promise.all(
      (['v1', 'v2'] as const).map((version) =>
        bucket.put(
          `dev-screen/${shareableId}-${version}`,
          `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Review handoff</title></head><body><main><h1>Review handoff</h1><p>${version === 'v1' ? '前回確認した内容です。' : '前回の閲覧後に更新された内容です。'}</p></main></body></html>`,
          { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
        ),
      ),
    )
    return
  }
  if (
    scenario !== 'recent/content-rich' &&
    scenario !== 'home/unopened-file' &&
    scenario !== 'viewer/link-suspended'
  )
    return
  const bodies = [
    {
      key: `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-1`)}-${RECENT_CONTENT_RICH_BODIES.quarterlyReport.version}`,
      html: RECENT_CONTENT_RICH_BODIES.quarterlyReport.html,
    },
    ...(scenario === 'home/unopened-file'
      ? [
          {
            key: `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-6`)}-v1`,
            html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release checklist</title></head><body><main><h1>Release checklist</h1><p>Final checks before release.</p></main></body></html>',
          },
        ]
      : []),
    ...(scenario === 'recent/content-rich'
      ? RECENT_CONTENT_RICH_BODIES.archivedReview21.map(
          ({ version, html }) => ({
            key: `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-21`)}-${version}`,
            html,
          }),
        )
      : []),
  ]
  await Promise.all(
    bodies.map(({ key, html }) =>
      bucket.put(key, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      }),
    ),
  )
}

// Billing capture states whose contract the sync service stores from the
// local capture's fake Stripe (`scripts/capture-stripe.mjs`).
const CONTRACT_SCENARIOS = new Set([
  'settings-billing/subscribed',
  'settings-billing/past-due',
  'settings-billing/continuing-near-limit',
])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// Storage used in the near-limit states, as a share of the actual quota:
// above the 90% warning threshold, below the limit.
const NEAR_LIMIT_USAGE_SHARE = 0.95

/** The fake Stripe subscription of a paid billing capture workspace. */
export function captureSubscriptionId(workspaceId: string): string {
  return `sub_capture_${workspaceId}`
}

function captureStripeClient(
  billing: BillingEnv | undefined,
  scenario: string,
): { billing: BillingEnv; stripe: ReturnType<typeof createStripeClient> } {
  const origin = billing?.STRIPE_API_ORIGIN
  if (
    !billing ||
    !isBillingConfigured(billing) ||
    !origin ||
    !LOOPBACK_HOSTS.has(parseStripeApiOrigin(origin).host)
  )
    throw new Error(
      `${scenario} reads its contract from the local capture's fake Stripe; run it with pnpm screens:capture:local`,
    )
  return { billing, stripe: createStripeClient(billing) }
}

/**
 * Stores a paid capture contract through the production sync, from the fake
 * Stripe subscription of this workspace. Plan, status and quota are what the
 * sync derives; any failure fails the setup.
 */
async function syncCaptureSubscription(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
  billingEnv: BillingEnv | undefined,
) {
  const { billing, stripe } = captureStripeClient(billingEnv, scenario)
  const result = await syncWorkspaceSubscription(
    db,
    stripe,
    billing,
    captureSubscriptionId(workspaceId),
  )
  if (result.kind !== 'ok')
    throw new Error(
      `${scenario} could not sync its fake Stripe subscription: ${result.kind}`,
    )
}

async function setNearLimitUsage(db: Kysely<DB>, workspaceId: string) {
  const { storage_quota_bytes } = await db
    .selectFrom('workspaces')
    .select('storage_quota_bytes')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('workspaces')
    .set({
      storage_used_bytes: Math.round(
        storage_quota_bytes * NEAR_LIMIT_USAGE_SHARE,
      ),
    })
    .where('id', '=', workspaceId)
    .execute()
}

/**
 * Creates the isolated workspace anchor used by screen-capture scenarios.
 * The paid billing states also need `billing`, the local capture's fake
 * Stripe configuration; dev sign-in passes none and uses the Worker env.
 */
export async function ensureDevScreenState(
  db: Kysely<DB>,
  scenario: string,
  now: string,
  plan: 'free' | 'plus' | 'team',
  billing: BillingEnv | undefined = env,
): Promise<{ workspaceId: string }> {
  if (!isScreenScenario(scenario))
    throw new Error(`Unknown screen scenario: ${scenario}`)
  const workspaceId = scenarioWorkspaceId(plan, scenario)
  const settings = isSettingsScenario(scenario)
  const existing = await db
    .selectFrom('workspaces')
    .select([
      'id',
      'link_sharing_enabled',
      'external_posting_enabled',
      'link_expiry_default_days',
      'link_expiry_max_days',
    ])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  if (existing) await refuseAuthoredFixtureBots(db, scenario, workspaceId)
  // Settings anchors hold what production stores for a new workspace of the
  // plan; other scenarios keep their historical capture values.
  const planLinkSharing = LINK_SHARING_PLAN_DEFAULTS[plan].linkSharingEnabled
    ? 1
    : 0
  if (!existing) {
    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        hd: null,
        name: `Screen state: ${scenario}`,
        created_at: now,
        plan,
        storage_quota_bytes:
          !settings && plan === 'free'
            ? 5_000_000_000
            : PLAN_STORAGE_QUOTA_BYTES[plan],
        link_sharing_enabled: settings ? planLinkSharing : 1,
        external_posting_enabled: 0,
        ...linkExpiryStartingColumns(),
      })
      .execute()
  } else if (!settings) {
    await db
      .updateTable('workspaces')
      .set(linkExpiryStartingColumns())
      .where('id', '=', workspaceId)
      .execute()
  } else if (externalAccessPolicyConverged(scenario, existing)) {
    // Keep a converged exception so reseeding adds no policy-change audit.
    await db
      .updateTable('workspaces')
      .set({ storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[plan] })
      .where('id', '=', workspaceId)
      .execute()
  } else {
    await db
      .updateTable('workspaces')
      .set({
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[plan],
        link_sharing_enabled: planLinkSharing,
        ...linkExpiryStartingColumns(),
      })
      .where('id', '=', workspaceId)
      .execute()
  }
  if (scenario.startsWith('settings-billing/')) {
    // Every billing seed rebuilds the same starting row: Free billing fields,
    // no contract, and the sharing settings a new workspace starts with. A
    // contract state then holds exactly what the sync stores for a first paid
    // contract, however often the state is seeded.
    await db
      .updateTable('workspaces')
      .set({
        plan: 'free',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_subscription_status: 'none',
        storage_used_bytes: 0,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        link_sharing_enabled: LINK_SHARING_PLAN_DEFAULTS.free.linkSharingEnabled
          ? 1
          : 0,
        external_posting_enabled: 0,
      })
      .where('id', '=', workspaceId)
      .execute()
  }
  if (CONTRACT_SCENARIOS.has(scenario))
    await syncCaptureSubscription(db, scenario, workspaceId, billing)
  if (
    scenario === 'settings-billing/near-limit' ||
    scenario === 'settings-billing/continuing-near-limit'
  )
    await setNearLimitUsage(db, workspaceId)
  return { workspaceId }
}

function isSettingsScenario(scenario: string): boolean {
  return scenario.startsWith('settings/') || scenario.startsWith('settings-')
}

/** Named per-state policy exceptions; every other anchor keeps its plan default. */
const EXTERNAL_ACCESS_EXCEPTIONS: Readonly<
  Record<string, { linkExpiryMaxDays: number | null }>
> = {
  'settings-external-access/finite': { linkExpiryMaxDays: 90 },
  'settings-external-access/unlimited': { linkExpiryMaxDays: null },
  'settings-external-access/zero': { linkExpiryMaxDays: 90 },
}
const EXTERNAL_ACCESS_DEFAULT_DAYS = 30
const EXTERNAL_ACCESS_LINK_TITLE = 'Shared report.html'

function externalAccessPolicyConverged(
  scenario: string,
  row: {
    link_sharing_enabled: number
    external_posting_enabled: number
    link_expiry_default_days: number | null
    link_expiry_max_days: number | null
  },
): boolean {
  const exception = EXTERNAL_ACCESS_EXCEPTIONS[scenario]
  return (
    exception !== undefined &&
    row.link_sharing_enabled === 1 &&
    row.external_posting_enabled === 1 &&
    row.link_expiry_default_days === EXTERNAL_ACCESS_DEFAULT_DAYS &&
    row.link_expiry_max_days === exception.linkExpiryMaxDays
  )
}

function expectSeedOk(step: string, result: { kind: string }): void {
  if (result.kind !== 'ok')
    throw new Error(`Settings seed ${step} failed: ${result.kind}`)
}

function laterIso(first: string, second: string): string {
  return Date.parse(first) >= Date.parse(second) ? first : second
}

const AUDIT_FIXTURE_COLUMNS = [
  'workspace_id',
  'actor_user_id',
  'action',
  'subject_type',
  'subject_id',
  'detail',
  'created_at',
] as const

/**
 * A fixed-ID historical audit event returns to its fixture values; one that
 * already matches them (compared null-safely) is left unwritten.
 */
function resetFixtureAuditEvent(oc: OnConflictBuilder<DB, 'audit_events'>) {
  return oc
    .column('id')
    .doUpdateSet((eb) =>
      Object.fromEntries(
        AUDIT_FIXTURE_COLUMNS.map((column) => [
          column,
          eb.ref(`excluded.${column}`),
        ]),
      ),
    )
    .where(
      sql<boolean>`${sql.join(
        AUDIT_FIXTURE_COLUMNS.map(
          (column) =>
            sql`${sql.ref(`audit_events.${column}`)} IS NOT ${sql.ref(`excluded.${column}`)}`,
        ),
        sql` OR `,
      )}`,
    )
}

type ScenarioActor = { id: string; workspaceId: string }

/**
 * The authorized actor for service writes. Dev sign-in provisions a Team owner
 * for the member persona, so a member's sign-in still seeds as that owner.
 */
async function scenarioOwnerActor(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<ScenarioActor> {
  const owners = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'owner')
    .where('status', '=', 'active')
    .orderBy('user_id')
    .execute()
  const ownerId = owners.some((owner) => owner.user_id === userId)
    ? userId
    : (owners[0]?.user_id ?? userId)
  return { id: ownerId, workspaceId }
}

async function upsertScenarioHuman(
  db: Kysely<DB>,
  workspaceId: string,
  memberId: string,
  profile: { email: string; name: string; image: null },
  now: string,
) {
  await db
    .insertInto('users')
    .values({
      id: memberId,
      ...profile,
      email_verified: 1,
      workspace_id: workspaceId,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doUpdateSet(profile))
    .execute()
}

function loadScenarioMembership(
  db: Kysely<DB>,
  workspaceId: string,
  memberId: string,
) {
  return db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'workspace_members.status',
      'workspace_members.role',
      'users.workspace_id as homeWorkspaceId',
    ])
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', memberId)
    .executeTakeFirst()
}

/**
 * Returns a fixture human to active membership. A production removal moved the
 * human to a personal workspace, so it is undone by the restore service; a row
 * still homed here is reactivated by the membership service.
 */
async function ensureScenarioMemberActive(
  db: Kysely<DB>,
  actor: ScenarioActor,
  memberId: string,
  now: string,
) {
  const membership = await loadScenarioMembership(
    db,
    actor.workspaceId,
    memberId,
  )
  if (membership?.status !== 'removed') {
    if (!membership)
      await ensureActiveWorkspaceMembership(
        db,
        memberId,
        actor.workspaceId,
        now,
      )
    return
  }
  if (membership.homeWorkspaceId === actor.workspaceId) {
    await ensureActiveWorkspaceMembership(
      db,
      memberId,
      actor.workspaceId,
      now,
      { reactivateRemoved: true },
    )
    return
  }
  expectSeedOk(
    'member restore',
    await restoreWorkspaceMember(db, actor, memberId),
  )
}

async function seedLongMemberAddresses(
  db: Kysely<DB>,
  actor: ScenarioActor,
  now: string,
) {
  const { workspaceId } = actor
  for (const status of ['active', 'removed'] as const) {
    const memberId = `${workspaceId}-long-member-${status}`
    await upsertScenarioHuman(
      db,
      workspaceId,
      memberId,
      {
        email: `${status}-member-with-a-long-synthetic-address-${workspaceId}@example.test`,
        name:
          status === 'active'
            ? 'Synthetic active member with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones'
            : 'Synthetic removed member with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
        image: null,
      },
      now,
    )
    if (status === 'active') {
      await ensureScenarioMemberActive(db, actor, memberId, now)
      expectSeedOk(
        'admin grant',
        await grantWorkspaceAdmin(db, actor, memberId),
      )
      continue
    }
    const membership = await loadScenarioMembership(db, workspaceId, memberId)
    if (
      membership?.status === 'removed' &&
      membership.homeWorkspaceId !== workspaceId
    )
      continue
    await ensureScenarioMemberActive(db, actor, memberId, now)
    expectSeedOk(
      'member removal',
      await removeWorkspaceMember(db, actor, memberId),
    )
  }
}

const TRANSFER_FILE_TITLE = 'Review notes.html'

async function seedResultWarningMember(
  db: Kysely<DB>,
  actor: ScenarioActor,
  now: string,
) {
  const { workspaceId } = actor
  const memberId = `${workspaceId}-removed-member`
  await upsertScenarioHuman(
    db,
    workspaceId,
    memberId,
    {
      name: 'Casey Morgan',
      email: `casey-${workspaceId}@example.test`,
      image: null,
    },
    now,
  )
  await ensureScenarioMemberActive(db, actor, memberId, now)
  const fileId = devShareableId(`${workspaceId}-transfer-file`)
  const [containerId, file] = await Promise.all([
    getOrCreateInboxContainerId(db, workspaceId, memberId, now),
    claimFixedIdArtifact(db, workspaceId, fileId, TRANSFER_FILE_TITLE),
  ])
  if (!file) {
    await db
      .insertInto('shareables')
      .values({
        id: fileId,
        workspace_id: workspaceId,
        owner_user_id: memberId,
        container_id: containerId,
        name: TRANSFER_FILE_TITLE,
        artifact_kind: 'html_page',
        visibility: 'private',
        created_at: now,
        updated_at: now,
      })
      .execute()
    return
  }
  // The fixture returns to its title and private shape in Casey's inbox, and
  // to its untouched times: inserted with updated_at equal to created_at, and
  // activity_at following updated_at.
  if (
    file.name !== TRANSFER_FILE_TITLE ||
    file.title_override !== null ||
    file.derived_title !== null ||
    file.owner_user_id !== memberId ||
    file.container_id !== containerId ||
    file.visibility !== 'private' ||
    file.link_expires_at !== null ||
    file.updated_at !== file.created_at ||
    file.activity_at !== file.created_at
  )
    await db
      .updateTable('shareables')
      .set({
        name: TRANSFER_FILE_TITLE,
        title_override: null,
        derived_title: null,
        owner_user_id: memberId,
        container_id: containerId,
        visibility: 'private',
        link_expires_at: null,
        updated_at: file.created_at,
      })
      .where('id', '=', fileId)
      .where('workspace_id', '=', workspaceId)
      .execute()
}

// A fixture project is the scenario workspace's live project with its name,
// compared like the live-project unique index (NOCASE). Descriptions are only
// the values the seed writes, not ownership.
const INVENTORY_PROJECT_DESCRIPTION =
  'Screen capture fixture: inventory project'
const BOT_NIGHTLY_DESCRIPTION =
  'Screen capture fixture: destination project for bot uploads'
const BOT_MANAGEMENT_DESCRIPTION =
  'Screen capture fixture: management destination'
const AGENT_PROJECT_DESCRIPTION = 'Screen capture fixture: Agent destination'

const INVENTORY_PROJECT_NAME =
  'Quarterly reports and review materials for the whole workspace'

function findLiveProjectByName(
  db: Kysely<DB>,
  workspaceId: string,
  name: string,
) {
  return db
    .selectFrom('artifact_containers')
    .select(['id', 'name', 'description', 'base_visibility', 'created_by_id'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .where(sql<boolean>`name = ${name} COLLATE NOCASE`)
    .executeTakeFirst()
}

/** Reuses and resets the same-name live project, or creates it. */
async function ensureFixtureProject(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  input: { name: string; description: string },
): Promise<string> {
  const existing = await findLiveProjectByName(db, workspaceId, input.name)
  if (!existing) {
    const created = await createProjectContainer(db, workspaceId, userId, {
      ...input,
      baseVisibility: 'workspace',
    })
    if (created.kind !== 'ok')
      throw new Error(`Settings seed project ${input.name}: ${created.kind}`)
    return created.id
  }
  if (
    existing.name !== input.name ||
    existing.description !== input.description ||
    existing.base_visibility !== 'workspace'
  )
    expectSeedOk(
      'project reset',
      await updateProjectContainer(db, workspaceId, existing.id, {
        ...input,
        baseVisibility: 'workspace',
      }),
    )
  await ensureCreatorMembership(db, existing.id, existing.created_by_id)
  return existing.id
}

/**
 * An earlier seed inserted the project without the creator membership that
 * creation writes; the creator rejoins the workspace-visible project.
 */
async function ensureCreatorMembership(
  db: Kysely<DB>,
  projectId: string,
  creatorId: string | null,
) {
  const creator =
    creatorId &&
    (await db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'email_verified',
        'name',
        'image',
        'workspace_id',
        'locale',
        'kind',
      ])
      .where('id', '=', creatorId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('project_members')
              .select('user_id')
              .where('container_id', '=', projectId)
              .whereRef('project_members.user_id', '=', 'users.id'),
          ),
        ),
      )
      .executeTakeFirst())
  if (creator) {
    const joined = await joinProject(db, {
      containerId: projectId,
      user: {
        id: creator.id,
        email: creator.email,
        emailVerified: creator.email_verified === 1,
        name: creator.name,
        image: creator.image,
        workspaceId: creator.workspace_id,
        hd: null,
        msTenantId: null,
        locale: creator.locale,
        kind: creator.kind,
      },
    })
    if (joined !== 'joined')
      throw new Error(`Settings seed project membership failed: ${joined}`)
  }
}

function selectScenarioArtifacts(db: Kysely<DB>, workspaceId: string) {
  return db
    .selectFrom('shareables')
    .select([
      'id',
      sql<string>`coalesce(title_override, derived_title, name)`.as('title'),
      'name',
      'title_override',
      'derived_title',
      'owner_user_id',
      'container_id',
      'visibility',
      'link_expires_at',
      'created_at',
      'updated_at',
      'activity_at',
      'last_accessed_at',
    ])
    .where('workspace_id', '=', workspaceId)
}

/** Directly written fixtures are the rows at their fixed IDs. */
function findArtifactsByIds(
  db: Kysely<DB>,
  workspaceId: string,
  ids: readonly string[],
) {
  return selectScenarioArtifacts(db, workspaceId)
    .where('id', 'in', ids)
    .execute()
}

/** Artifacts in the scenario workspace showing one of these titles. */
function findArtifactsByTitle(
  db: Kysely<DB>,
  workspaceId: string,
  titles: readonly string[],
) {
  return selectScenarioArtifacts(db, workspaceId)
    .where(
      sql<boolean>`coalesce(title_override, derived_title, name) IN (${sql.join(titles)})`,
    )
    .orderBy('id')
    .execute()
}

/**
 * Removes the scenario workspace's different-ID copies of a fixed-ID fixture
 * and returns the fixture row, if present.
 */
async function claimFixedIdArtifact(
  db: Kysely<DB>,
  workspaceId: string,
  id: string,
  title: string,
) {
  const [[row], sameTitle] = await Promise.all([
    findArtifactsByIds(db, workspaceId, [id]),
    findArtifactsByTitle(db, workspaceId, [title]),
  ])
  const copyIds = sameTitle
    .filter((copy) => copy.id !== id)
    .map((copy) => copy.id)
  if (copyIds.length > 0)
    await db.deleteFrom('shareables').where('id', 'in', copyIds).execute()
  return row
}

const INVENTORY_POPULATED_TITLE = 'Quarterly report.html'
const INVENTORY_PAGED_TITLES = Array.from(
  { length: INVENTORY_PAGE_SIZE + 1 },
  (_, index) => `Quarterly report ${index + 1}.html`,
)

async function seedSettingsInventory(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
  userId: string,
  now: string,
) {
  const paginated = scenario === 'settings-inventory-artifacts/paginated'
  const populated = paginated || scenario.endsWith('/populated')
  // An empty state owns no fixture rows, so it has nothing to reset.
  if (!populated) return null
  // Only this state's own titles are its fixtures. Each sits at its fixed ID,
  // which the listing uses to break equal activity times, so the row at that
  // ID is the fixture whatever a capture renamed or moved it to.
  const wanted = paginated
    ? INVENTORY_PAGED_TITLES
    : [INVENTORY_POPULATED_TITLE]
  const fixtureIds = new Map(
    wanted.map((title, index) => [
      devShareableId(`${workspaceId}-inventory-file${index || ''}`),
      title,
    ]),
  )
  const [atFixtureIds, sameTitle] = await Promise.all([
    findArtifactsByIds(db, workspaceId, [...fixtureIds.keys()]),
    findArtifactsByTitle(db, workspaceId, wanted),
  ])
  // A different-ID artifact with a fixture title is a fixture copy.
  const copyIds = sameTitle
    .filter((row) => !fixtureIds.has(row.id))
    .map((row) => row.id)
  if (copyIds.length > 0)
    await db.deleteFrom('shareables').where('id', 'in', copyIds).execute()
  const projectId = await ensureFixtureProject(db, workspaceId, userId, {
    name: INVENTORY_PROJECT_NAME,
    description: INVENTORY_PROJECT_DESCRIPTION,
  })
  const existing = new Map(atFixtureIds.map((row) => [row.id, row]))
  for (const [id, title] of fixtureIds) {
    const shape = {
      name: title,
      title_override: null,
      derived_title: null,
      owner_user_id: userId,
      container_id: projectId,
      visibility: 'project' as const,
      link_expires_at: null,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
    }
    const row = existing.get(id)
    if (!row) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: workspaceId,
          artifact_kind: 'html_page',
          ...shape,
        })
        .execute()
      continue
    }
    if (
      (Object.keys(shape) as (keyof typeof shape)[]).some(
        (key) => row[key] !== shape[key],
      )
    )
      await db
        .updateTable('shareables')
        .set(shape)
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .execute()
  }
  return projectId
}

const BOT_PROJECT_NIGHTLY = 'Nightly reports'
const BOT_PROJECT_MANAGEMENT = 'Management reports'
const BOT_PROJECT_NAMES = [BOT_PROJECT_NIGHTLY, BOT_PROJECT_MANAGEMENT]
const BOT_PROJECT_TEMPORARY_PREFIX = 'Bot destination '
const ACTIVE_BOT_NAME = 'Nightly report bot'
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

// Creation precedes every shown use and stop; the small steps keep table order.
const BOT_CREATED_AGO_MS = 30 * DAY_MS

const BOT_FIXTURES = [
  {
    key: 'active',
    name: ACTIVE_BOT_NAME,
    createdAgoMs: BOT_CREATED_AGO_MS + MINUTE_MS,
    stoppedAgoMs: null,
    expiredAgoMs: null,
    lastUsedAgoMs: 30 * MINUTE_MS,
    bothDestinations: true,
  },
  {
    key: 'expired',
    name: 'Metrics sync bot',
    createdAgoMs: BOT_CREATED_AGO_MS + 2 * MINUTE_MS,
    stoppedAgoMs: null,
    expiredAgoMs: DAY_MS,
    lastUsedAgoMs: 10 * DAY_MS,
    bothDestinations: false,
  },
  {
    key: 'stopped',
    name: 'Retired handoff bot',
    createdAgoMs: BOT_CREATED_AGO_MS + 3 * MINUTE_MS,
    stoppedAgoMs: 3 * DAY_MS,
    expiredAgoMs: null,
    lastUsedAgoMs: 4 * DAY_MS,
    bothDestinations: false,
  },
  {
    key: 'unused-stopped',
    name: 'Setup failed bot',
    createdAgoMs: BOT_CREATED_AGO_MS + 4 * MINUTE_MS,
    stoppedAgoMs: 60 * MINUTE_MS,
    expiredAgoMs: null,
    lastUsedAgoMs: null,
    bothDestinations: false,
  },
] as const

type BotFixture = (typeof BOT_FIXTURES)[number]

/**
 * Earlier seeds inserted these fixed IDs without the services' linked rows.
 * Only rows still carrying a fixture name are the fixture's. An empty legacy
 * destination is rebuilt; one holding content keeps it and gives up the name.
 */
async function removeLegacyBotFixtures(db: Kysely<DB>, workspaceId: string) {
  const legacyBots = await db
    .selectFrom('users')
    .select(['id', 'email', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'bot')
    .where(
      'id',
      'in',
      BOT_FIXTURES.map((fixture) => `${workspaceId}-bot-${fixture.key}`),
    )
    .where(
      'name',
      'in',
      BOT_FIXTURES.map((fixture) => fixture.name),
    )
    .execute()
  for (const bot of legacyBots) await deleteFixtureBot(db, workspaceId, bot)
  const legacyProjects = await db
    .selectFrom('artifact_containers')
    .select(({ selectFrom }) => [
      'id',
      'name',
      'description',
      'base_visibility',
      selectFrom('shareables')
        .select(sql<number>`count(*)`.as('count'))
        .whereRef('shareables.container_id', '=', 'artifact_containers.id')
        .as('fileCount'),
      selectFrom('bot_destination_projects')
        .select(sql<number>`count(*)`.as('count'))
        .whereRef(
          'bot_destination_projects.project_id',
          '=',
          'artifact_containers.id',
        )
        .as('botCount'),
    ])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('id', 'in', legacyBotProjectIds(workspaceId))
    // An archived one holds no live name, so it and its files stay as they are.
    .where('archived_at', 'is', null)
    .where(
      sql<boolean>`name COLLATE NOCASE IN (${sql.join(BOT_PROJECT_NAMES)})`,
    )
    .execute()
  for (const project of legacyProjects) {
    if (Number(project.fileCount) + Number(project.botCount) === 0) {
      await db
        .deleteFrom('artifact_containers')
        .where('id', '=', project.id)
        .execute()
    } else {
      expectSeedOk(
        'legacy bot project rename',
        await updateProjectContainer(db, workspaceId, project.id, {
          name: `${project.name} (earlier fixture)`,
          description: project.description,
          baseVisibility: project.base_visibility,
        }),
      )
    }
  }
}

function legacyBotProjectIds(workspaceId: string) {
  return [`${workspaceId}-bot-project`, `${workspaceId}-bot-management`]
}

/**
 * Bot destinations list by project ID, so Management reports must hold the
 * lower ID for the table and edit dialog to keep their order.
 */
async function ensureBotDestinationProjects(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<{ nightlyId: string; managementId: string; createdAt: string }> {
  await removeLegacyBotFixtures(db, workspaceId)
  // Only a live project with a fixture name under the unique index's NOCASE
  // rule is the fixture's own; any differently named project is left alone.
  const rows = await db
    .selectFrom('artifact_containers')
    .select([
      'id',
      'name',
      'description',
      'base_visibility',
      'created_at',
      'created_by_id',
    ])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .where(
      sql<boolean>`name COLLATE NOCASE IN (${sql.join(BOT_PROJECT_NAMES)})`,
    )
    .orderBy('id')
    .execute()
  const nightly = rows.find((row) => row.name === BOT_PROJECT_NIGHTLY)
  const management = rows.find((row) => row.name === BOT_PROJECT_MANAGEMENT)
  if (
    nightly?.description === BOT_NIGHTLY_DESCRIPTION &&
    management?.description === BOT_MANAGEMENT_DESCRIPTION &&
    management.id < nightly.id &&
    nightly.base_visibility === 'workspace' &&
    management.base_visibility === 'workspace'
  ) {
    await Promise.all(
      [management, nightly].map((row) =>
        ensureCreatorMembership(db, row.id, row.created_by_id),
      ),
    )
    return {
      nightlyId: nightly.id,
      managementId: management.id,
      createdAt: nightly.created_at,
    }
  }

  const missing = [BOT_MANAGEMENT_DESCRIPTION, BOT_NIGHTLY_DESCRIPTION].slice(
    rows.length,
  )
  const created = await Promise.all(
    missing.map((description) =>
      createProjectContainer(db, workspaceId, userId, {
        name: `${BOT_PROJECT_TEMPORARY_PREFIX}setup ${nanoid(8)}`,
        description,
        baseVisibility: 'workspace',
      }),
    ),
  )
  const createdIds = created.map((result) => {
    if (result.kind !== 'ok')
      throw new Error(`Settings seed bot project: ${result.kind}`)
    return result.id
  })
  const [managementId, nightlyId] = [
    ...rows.map((row) => row.id),
    ...createdIds,
  ].sort()
  // Names are unique among live projects, so a swap passes through temporary
  // names before each project takes its display role.
  const renamed = await Promise.all(
    [
      [managementId, BOT_MANAGEMENT_DESCRIPTION],
      [nightlyId, BOT_NIGHTLY_DESCRIPTION],
    ].map(([id, description]) =>
      updateProjectContainer(db, workspaceId, id, {
        name: `${BOT_PROJECT_TEMPORARY_PREFIX}assigning ${id}`,
        description,
        baseVisibility: 'workspace',
      }),
    ),
  )
  for (const result of renamed) expectSeedOk('bot project rename', result)
  expectSeedOk(
    'bot project assignment',
    await updateProjectContainer(db, workspaceId, managementId, {
      name: BOT_PROJECT_MANAGEMENT,
      description: BOT_MANAGEMENT_DESCRIPTION,
      baseVisibility: 'workspace',
    }),
  )
  expectSeedOk(
    'bot project assignment',
    await updateProjectContainer(db, workspaceId, nightlyId, {
      name: BOT_PROJECT_NIGHTLY,
      description: BOT_NIGHTLY_DESCRIPTION,
      baseVisibility: 'workspace',
    }),
  )
  // A reused same-name project gets the creator membership creation writes.
  await Promise.all(
    rows.map((row) => ensureCreatorMembership(db, row.id, row.created_by_id)),
  )
  const { created_at } = await db
    .selectFrom('artifact_containers')
    .select('created_at')
    .where('id', '=', nightlyId)
    .executeTakeFirstOrThrow()
  return { nightlyId, managementId, createdAt: created_at }
}

async function loadFixtureBotState(
  db: Kysely<DB>,
  workspaceId: string,
  botId: string,
) {
  const member = await db
    .selectFrom('workspace_members')
    .select('status')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', botId)
    .executeTakeFirst()
  const families = await db
    .selectFrom('cli_family_authorities')
    .select(['family_id', 'status', 'project_id'])
    .where('user_id', '=', botId)
    .execute()
  const credentials = await db
    .selectFrom('cli_refresh_credentials')
    .select(['family_id', 'revoked_at', 'expires_at'])
    .where('user_id', '=', botId)
    .execute()
  const destinations = families[0]
    ? await db
        .selectFrom('bot_destination_projects')
        .select('project_id')
        .where('family_id', '=', families[0].family_id)
        .execute()
    : []
  return {
    member,
    families,
    credentials,
    destinations: destinations.map((row) => row.project_id),
  }
}

function fixtureBotHealthy(
  fixture: BotFixture,
  bot: { name: string | null; bot_stopped_at: string | null },
  state: Awaited<ReturnType<typeof loadFixtureBotState>>,
  projects: { nightlyId: string; managementId: string },
  clock: string,
): boolean {
  const [family] = state.families
  const [credential] = state.credentials
  const stopped = fixture.stoppedAgoMs !== null
  const expected = fixture.bothDestinations
    ? [projects.managementId, projects.nightlyId]
    : [projects.nightlyId]
  return (
    bot.name === fixture.name &&
    state.families.length === 1 &&
    state.credentials.length === 1 &&
    credential.family_id === family.family_id &&
    family.project_id === projects.nightlyId &&
    [...state.destinations].sort().join() === [...expected].sort().join() &&
    (stopped
      ? bot.bot_stopped_at !== null &&
        state.member?.status === 'removed' &&
        family.status === 'revoked' &&
        credential.revoked_at !== null
      : bot.bot_stopped_at === null &&
        state.member?.status === 'active' &&
        family.status === 'active' &&
        credential.revoked_at === null &&
        (fixture.expiredAgoMs !== null || credential.expires_at > clock))
  )
}

/**
 * Whether anything outside the bot's own auth state is attributed to it or its
 * agent profile, as in the product's cancellation rule. Such records match no
 * fixture, and deleting the bot would cascade into them or be blocked by them.
 */
async function fixtureBotHasRecords(
  db: Kysely<DB>,
  botId: string,
): Promise<boolean> {
  const { rows } = await sql<{ found: number }>`
    SELECT (
      EXISTS (SELECT 1 FROM shareables WHERE owner_user_id = ${botId})
      OR EXISTS (
        SELECT 1 FROM artifact_containers
        WHERE owner_user_id = ${botId} OR created_by_id = ${botId}
      )
      OR EXISTS (SELECT 1 FROM versions WHERE created_by_id = ${botId})
      OR EXISTS (SELECT 1 FROM comment_threads WHERE created_by_id = ${botId})
      OR EXISTS (SELECT 1 FROM comment_messages WHERE created_by_id = ${botId})
      OR EXISTS (SELECT 1 FROM artifact_keys WHERE owner_user_id = ${botId})
      OR EXISTS (SELECT 1 FROM audit_events WHERE actor_user_id = ${botId})
      OR EXISTS (
        SELECT 1 FROM bridge_authorities WHERE bot_user_id = ${botId}
      )
      OR EXISTS (
        SELECT 1 FROM shareables s
        JOIN agent_profiles p ON p.id = s.created_by_agent_profile_id
        WHERE p.user_id = ${botId}
      )
      OR EXISTS (
        SELECT 1 FROM versions v
        JOIN agent_profiles p ON p.id = v.created_by_agent_profile_id
        WHERE p.user_id = ${botId}
      )
      OR EXISTS (
        SELECT 1 FROM comment_messages m
        JOIN agent_profiles p ON p.id = m.created_by_agent_profile_id
        WHERE p.user_id = ${botId}
      )
    ) AS found
  `.execute(db)
  return rows[0]?.found === 1
}

const BOT_SCENARIOS = new Set([
  'settings/with-bots',
  'settings-bots/long-email',
])

/**
 * No capture makes a fixture bot publish or author records, so a fixture bot
 * (current, or at a legacy fixed ID, both carrying a fixture name) that has
 * them is outside every capture state. Rebuilding it would delete or reassign
 * those records, so the seed refuses before any write of the sign-in.
 */
async function refuseAuthoredFixtureBots(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
) {
  if (!BOT_SCENARIOS.has(scenario)) return
  const bots = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'bot')
    .where(
      'name',
      'in',
      BOT_FIXTURES.map((fixture) => fixture.name),
    )
    .orderBy('id')
    .execute()
  const used: string[] = []
  for (const bot of bots)
    if (await fixtureBotHasRecords(db, bot.id)) used.push(bot.name ?? bot.id)
  if (used.length > 0)
    throw new Error(
      `Settings seed cannot reset fixture bot ${used.join(', ')} in ${scenario}: it has published or authored records`,
    )
}

async function deleteFixtureBot(
  db: Kysely<DB>,
  workspaceId: string,
  bot: { id: string; email: string },
) {
  // Only the bot's grants on the scenario's fixture-named projects go with
  // it; its address on any other project, even one later added as a
  // destination, is not the fixture's.
  await db
    .deleteFrom('project_share_defaults')
    .where(sql<boolean>`lower(email) = ${bot.email.toLowerCase()}`)
    .where(
      'project_container_id',
      'in',
      db
        .selectFrom('artifact_containers')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', 'project')
        .where(
          sql<boolean>`name COLLATE NOCASE IN (${sql.join(BOT_PROJECT_NAMES)})`,
        ),
    )
    .execute()
  await db.deleteFrom('sessions').where('user_id', '=', bot.id).execute()
  await db
    .deleteFrom('cli_refresh_credentials')
    .where('user_id', '=', bot.id)
    .execute()
  await db
    .deleteFrom('bot_destination_projects')
    .where(
      'family_id',
      'in',
      db
        .selectFrom('cli_family_authorities')
        .select('family_id')
        .where('user_id', '=', bot.id),
    )
    .execute()
  await db
    .deleteFrom('cli_family_authorities')
    .where('user_id', '=', bot.id)
    .execute()
  await db
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', bot.id)
    .execute()
  await db.deleteFrom('agent_profiles').where('user_id', '=', bot.id).execute()
  await db
    .deleteFrom('audit_events')
    .where('workspace_id', '=', workspaceId)
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', bot.id)
    .execute()
  await db.deleteFrom('users').where('id', '=', bot.id).execute()
}

/** Applies the past timestamps a capture shows; services write the clock. */
async function applyBotFixtureTimes(
  db: Kysely<DB>,
  workspaceId: string,
  botId: string,
  fixture: BotFixture,
  now: string,
  projectCreatedAt: string,
) {
  const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString()
  // Anchored to the destination's creation so a reseed writes the same time.
  const createdAt = new Date(
    Math.min(Date.parse(now), Date.parse(projectCreatedAt)) -
      fixture.createdAgoMs,
  ).toISOString()
  const stoppedAt =
    fixture.stoppedAgoMs === null ? null : ago(fixture.stoppedAgoMs)
  const changedAt = stoppedAt ?? createdAt
  await db
    .updateTable('users')
    .set({
      created_at: createdAt,
      updated_at: changedAt,
      bot_stopped_at: stoppedAt,
    })
    .where('id', '=', botId)
    .execute()
  await db
    .updateTable('workspace_members')
    .set({
      created_at: createdAt,
      updated_at: changedAt,
      ...(stoppedAt && { removed_at: stoppedAt }),
    })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', botId)
    .execute()
  await db
    .updateTable('agent_profiles')
    .set({ created_at: createdAt })
    .where('user_id', '=', botId)
    .execute()
  await db
    .updateTable('bot_destination_projects')
    .set({ created_at: createdAt })
    .where(
      'family_id',
      'in',
      db
        .selectFrom('cli_family_authorities')
        .select('family_id')
        .where('user_id', '=', botId),
    )
    .execute()
  await db
    .updateTable('cli_family_authorities')
    .set({
      created_at: createdAt,
      approved_at: createdAt,
      updated_at: changedAt,
    })
    .where('user_id', '=', botId)
    .execute()
  await db
    .updateTable('cli_refresh_credentials')
    .set({
      created_at: createdAt,
      last_used_at:
        fixture.lastUsedAgoMs === null ? null : ago(fixture.lastUsedAgoMs),
      ...(stoppedAt && { revoked_at: stoppedAt }),
      ...(fixture.expiredAgoMs !== null && {
        expires_at: ago(fixture.expiredAgoMs),
      }),
    })
    .where('user_id', '=', botId)
    .execute()
  await db
    .updateTable('audit_events')
    .set({
      created_at: sql<string>`CASE WHEN action = 'bot.create' THEN ${createdAt} ELSE ${changedAt} END`,
    })
    .where('workspace_id', '=', workspaceId)
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', botId)
    .execute()
}

async function seedSettingsBots(
  db: Kysely<DB>,
  actor: ScenarioActor,
  now: string,
) {
  const { workspaceId } = actor
  const projects = await ensureBotDestinationProjects(db, workspaceId, actor.id)
  const clock = laterIso(now, nowIso())
  const fixtureNames = BOT_FIXTURES.map((fixture) => fixture.name)
  // A bot's name is its fixture identity, whatever its current destinations.
  // The first healthy one per fixture is kept; every other one is superseded.
  const owned = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'bot_stopped_at'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'bot')
    .where('name', 'in', fixtureNames)
    .orderBy('id')
    .execute()
  const kept = new Map<BotFixture, string>()
  const superseded: typeof owned = []
  for (const fixture of BOT_FIXTURES)
    for (const bot of owned.filter((row) => row.name === fixture.name)) {
      const state = await loadFixtureBotState(db, workspaceId, bot.id)
      if (
        !kept.has(fixture) &&
        fixtureBotHealthy(fixture, bot, state, projects, clock)
      )
        kept.set(fixture, bot.id)
      else superseded.push(bot)
    }
  // Cancellation deletes the bot and leaves its backdated creation audit.
  const cancelled = await db
    .selectFrom('audit_events')
    .select('subject_id')
    .where('workspace_id', '=', workspaceId)
    .where('action', '=', 'bot.create')
    .where('subject_type', '=', 'user')
    .where('created_at', '<', projects.createdAt)
    .where(
      sql<boolean>`json_extract(detail, '$.project_id') = ${projects.nightlyId}`,
    )
    .where(
      sql<boolean>`json_extract(detail, '$.name') IN (${sql.join(fixtureNames)})`,
    )
    .where('subject_id', 'not in', db.selectFrom('users').select('id'))
    .execute()
  if (cancelled.length > 0)
    await db
      .deleteFrom('audit_events')
      .where('workspace_id', '=', workspaceId)
      .where('subject_type', '=', 'user')
      .where(
        'subject_id',
        'in',
        cancelled.map((row) => row.subject_id),
      )
      .execute()
  for (const bot of superseded) await deleteFixtureBot(db, workspaceId, bot)
  for (const fixture of BOT_FIXTURES) {
    let botId = kept.get(fixture) ?? null
    if (botId === null) {
      const created = await createWorkspaceBot(db, actor, {
        name: fixture.name,
        projectId: projects.nightlyId,
        projectIds: fixture.bothDestinations
          ? [projects.nightlyId, projects.managementId]
          : [projects.nightlyId],
      })
      if (created.kind !== 'ok')
        throw new Error(`Settings seed bot create failed: ${created.kind}`)
      botId = created.botUserId
      if (fixture.stoppedAgoMs !== null)
        expectSeedOk('bot stop', await stopWorkspaceBot(db, actor, botId))
    }
    await applyBotFixtureTimes(
      db,
      workspaceId,
      botId,
      fixture,
      now,
      projects.createdAt,
    )
  }
}

async function publishExternalAccessLink(
  db: Kysely<DB>,
  user: { id: string; email: string; workspaceId: string },
  shareableId: string,
  linkExpiresAt: string | null,
) {
  expectSeedOk(
    'external link publish',
    await editShareableSettings(db, { ...user, hd: null }, shareableId, {
      visibility: 'link',
      linkExpiresAt,
    }),
  )
}

async function seedExternalAccessFixture(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
  userId: string,
  now: string,
) {
  const exception = EXTERNAL_ACCESS_EXCEPTIONS[scenario]
  if (!exception) throw new Error(`Unknown external access state: ${scenario}`)
  const [actor, policy] = await Promise.all([
    scenarioOwnerActor(db, workspaceId, userId),
    db
      .selectFrom('workspaces')
      .select([
        'link_sharing_enabled',
        'external_posting_enabled',
        'link_expiry_default_days',
        'link_expiry_max_days',
      ])
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow(),
  ])
  if (!externalAccessPolicyConverged(scenario, policy))
    expectSeedOk(
      'external access policy',
      await updateWorkspaceExternalAccessPolicy(db, actor, {
        linkSharingEnabled: true,
        externalPostingEnabled: true,
        linkExpiryDefaultDays: EXTERNAL_ACCESS_DEFAULT_DAYS,
        linkExpiryMaxDays: exception.linkExpiryMaxDays,
      }),
    )
  const shareableId = devShareableId(workspaceId + '-expiry-preview')
  const found = await claimFixedIdArtifact(
    db,
    workspaceId,
    shareableId,
    EXTERNAL_ACCESS_LINK_TITLE,
  )
  const fixtureTitle = {
    name: EXTERNAL_ACCESS_LINK_TITLE,
    title_override: null,
    derived_title: null,
  }
  const renamed =
    !!found &&
    (found.name !== EXTERNAL_ACCESS_LINK_TITLE ||
      found.title_override !== null ||
      found.derived_title !== null)
  let link = found
    ? await db
        .selectFrom('shareables')
        .leftJoin('link_publications as publication', (join) =>
          join
            .onRef('publication.shareable_id', '=', 'shareables.id')
            .onRef('publication.workspace_id', '=', 'shareables.workspace_id'),
        )
        .select([
          'shareables.visibility',
          'shareables.link_expires_at',
          'shareables.created_at',
          'publication.latest_published_at',
        ])
        .where('shareables.id', '=', shareableId)
        .executeTakeFirst()
    : undefined
  // A link inserted directly is published at its creation time by the insert
  // trigger. The private precursor below always predates its publication.
  if (
    link?.visibility === 'link' &&
    (link.latest_published_at ?? link.created_at) === link.created_at
  ) {
    await db
      .updateTable('shareables')
      .set({ visibility: 'private', link_expires_at: null })
      .where('id', '=', shareableId)
      .execute()
    link = { ...link, visibility: 'private', link_expires_at: null }
  }
  const ownerInbox = await getOrCreateInboxContainerId(
    db,
    workspaceId,
    actor.id,
    now,
  )
  // Only the owner may share, so a fixture taken over by another member
  // returns to the private precursor in the owner's inbox first; sharing it
  // again below writes its times.
  if (link && found && found.owner_user_id !== actor.id) {
    await db
      .updateTable('shareables')
      .set({
        ...fixtureTitle,
        owner_user_id: actor.id,
        container_id: ownerInbox,
        visibility: 'private',
        link_expires_at: null,
      })
      .where('id', '=', shareableId)
      .execute()
    link = { ...link, visibility: 'private', link_expires_at: null }
  } else if (link && found && (renamed || found.container_id !== ownerInbox)) {
    // Renamed or moved: the fixture returns to its title and the owner's
    // inbox; its times are restored once its sharing state is settled.
    await db
      .updateTable('shareables')
      .set({ ...fixtureTitle, container_id: ownerInbox })
      .where('id', '=', shareableId)
      .execute()
  }
  if (!link) {
    const precursorAt = new Date(Date.parse(now) - 1).toISOString()
    // Recreating a deleted fixture must also clear its retained publication ID.
    await db
      .deleteFrom('link_publications')
      .where('workspace_id', '=', workspaceId)
      .where('shareable_id', '=', shareableId)
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: shareableId,
        workspace_id: workspaceId,
        owner_user_id: actor.id,
        name: EXTERNAL_ACCESS_LINK_TITLE,
        artifact_kind: 'html_page',
        visibility: 'private',
        container_id: ownerInbox,
        created_at: precursorAt,
        updated_at: precursorAt,
        link_expires_at: null,
      })
      .execute()
    link = {
      visibility: 'private',
      link_expires_at: null,
      created_at: precursorAt,
      latest_published_at: null,
    }
  }
  const { email } = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', actor.id)
    .executeTakeFirstOrThrow()
  const user = { id: actor.id, email, workspaceId }
  // The fixture expiry follows the seed clock, so a reseed at the same clock
  // restores the same date.
  const finiteExpiry = new Date(Date.parse(now) + 60 * DAY_MS).toISOString()
  if (scenario.endsWith('/unlimited')) {
    if (link.visibility !== 'link' || link.link_expires_at !== null)
      await publishExternalAccessLink(db, user, shareableId, null)
  } else if (scenario.endsWith('/zero')) {
    if (link.visibility !== 'link')
      await publishExternalAccessLink(db, user, shareableId, finiteExpiry)
    if (link.link_expires_at !== now)
      await db
        .updateTable('shareables')
        .set({ link_expires_at: now })
        .where('id', '=', shareableId)
        .execute()
  } else if (
    link.visibility !== 'link' ||
    link.link_expires_at !== finiteExpiry
  ) {
    // Any other expiry, even one that would still be shortenable, is an edit
    // the seed returns to the fixture's through the product's edit service.
    await publishExternalAccessLink(db, user, shareableId, finiteExpiry)
  }
  await restoreExternalLinkTimes(db, workspaceId, shareableId)
}

/**
 * The shared fixture's times are those of its publication: any later edit
 * (a rename, a move or an expiry change through the product) advances
 * updated_at and activity_at, and the seed returns both to that time.
 */
async function restoreExternalLinkTimes(
  db: Kysely<DB>,
  workspaceId: string,
  shareableId: string,
) {
  const row = await db
    .selectFrom('shareables')
    .innerJoin('link_publications as publication', (join) =>
      join
        .onRef('publication.shareable_id', '=', 'shareables.id')
        .onRef('publication.workspace_id', '=', 'shareables.workspace_id'),
    )
    .select([
      'shareables.updated_at',
      'shareables.activity_at',
      'publication.latest_published_at',
    ])
    .where('shareables.id', '=', shareableId)
    .where('shareables.workspace_id', '=', workspaceId)
    .executeTakeFirst()
  if (
    row &&
    (row.updated_at !== row.latest_published_at ||
      row.activity_at !== row.latest_published_at)
  )
    await db
      .updateTable('shareables')
      .set({ updated_at: row.latest_published_at })
      .where('id', '=', shareableId)
      .where('workspace_id', '=', workspaceId)
      .execute()
}

// The name the registered capture types into the real create form.
const CAPTURE_CREATED_TOKEN_NAME = 'Release automation'
const BASELINE_TOKEN_NAME = 'CLI deploy'

async function seedCreatedSecretToken(db: Kysely<DB>, userId: string) {
  // The fixture user's tokens are the fixture's by label: one live baseline
  // stays, and every token the capture's form creates is cleared. The service
  // stores a SHA-256 hex digest, so a placeholder hash (as the earlier seed
  // wrote) never counts as healthy, whatever its ID.
  const tokens = await db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'token_hash', 'revoked_at'])
    .where('user_id', '=', userId)
    .where('name', 'in', [BASELINE_TOKEN_NAME, CAPTURE_CREATED_TOKEN_NAME])
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const baseline = tokens.find(
    (token) =>
      token.name === BASELINE_TOKEN_NAME &&
      token.revoked_at === null &&
      /^[0-9a-f]{64}$/.test(token.token_hash),
  )
  const staleIds = tokens
    .filter((token) => token.id !== baseline?.id)
    .map((token) => token.id)
  if (staleIds.length > 0)
    await db.deleteFrom('api_tokens').where('id', 'in', staleIds).execute()
  if (!baseline) await createApiToken(db, userId, BASELINE_TOKEN_NAME)
}

const CLI_SOURCE_SESSION_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const ACTIVE_CLI_DEVICE_NAME =
  'Artifact Share CLI on darwin arm64 (default, a1b2c3d4)'
const ACTIVE_CLI_DEVICE_ID = 'a1b2c3d4-example-device-id'
const MIXED_AGENT_PROJECT = 'Reports'
const MIXED_PUBLISHER_CLIENT = 'Employee dashboard'
// Newest first in the family list: Unrestricted, Publisher, Agent.
const MIXED_PRESET_OFFSET_MS = {
  unrestricted: 0,
  publisher: -1_000,
  agent: -2_000,
} as const
type MixedPreset = keyof typeof MIXED_PRESET_OFFSET_MS
const MIXED_PRESETS = ['unrestricted', 'publisher', 'agent'] as const

/** Stands in for the bearer session the device endpoints would redeem. */
async function insertCliSourceSession(
  db: Kysely<DB>,
  userId: string,
  now: string,
  id: string = nanoid(),
): Promise<string> {
  const token = nanoid(32)
  await db.deleteFrom('sessions').where('id', '=', id).execute()
  await db
    .insertInto('sessions')
    .values({
      id,
      user_id: userId,
      token,
      expires_at: CLI_SOURCE_SESSION_EXPIRES_AT,
      ip_address: null,
      user_agent: CLI_DEVICE_SESSION_USER_AGENT,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return token
}

async function deleteCliFixtureFamilies(
  db: Kysely<DB>,
  userId: string,
  familyIds: string[],
) {
  if (familyIds.length === 0) return
  await db
    .deleteFrom('sessions')
    .where('user_id', '=', userId)
    .where(
      'id',
      'in',
      db
        .selectFrom('cli_refresh_sessions')
        .select('session_id')
        .where('family_id', 'in', familyIds),
    )
    .execute()
  await db
    .deleteFrom('cli_refresh_credentials')
    .where('user_id', '=', userId)
    .where('family_id', 'in', familyIds)
    .execute()
  await db
    .deleteFrom('cli_family_authorities')
    .where('user_id', '=', userId)
    .where('family_id', 'in', familyIds)
    .execute()
}

/** Reads the family the issuer just linked to this source session. */
async function issuedSessionFamilyId(db: Kysely<DB>, sessionToken: string) {
  const { family_id } = await db
    .selectFrom('cli_refresh_sessions')
    .innerJoin('sessions', 'sessions.id', 'cli_refresh_sessions.session_id')
    .select('cli_refresh_sessions.family_id')
    .where('sessions.token', '=', sessionToken)
    .executeTakeFirstOrThrow()
  return family_id
}

async function seedActiveCliFixture(
  db: Kysely<DB>,
  userId: string,
  now: string,
) {
  const clock = laterIso(now, nowIso())
  const credentials = await db
    .selectFrom('cli_refresh_credentials as credential')
    .leftJoin(
      'cli_family_authorities as family',
      'family.family_id',
      'credential.family_id',
    )
    .select(({ exists, selectFrom }) => [
      'credential.family_id as familyId',
      'credential.device_id',
      'credential.revoked_at',
      'credential.expires_at',
      'credential.last_used_at',
      'family.status',
      'family.preset',
      exists(
        selectFrom('cli_refresh_sessions as link')
          .innerJoin('sessions', 'sessions.id', 'link.session_id')
          .select('link.session_id')
          .whereRef('link.family_id', '=', 'credential.family_id')
          .where('sessions.expires_at', '>', clock),
      ).as('linked'),
    ])
    .where('credential.user_id', '=', userId)
    // The fixture is the Unrestricted family the list labels with its device.
    .where('credential.device_name', '=', ACTIVE_CLI_DEVICE_NAME)
    .where(
      sql<boolean>`coalesce(family.preset, 'unrestricted') = 'unrestricted'`,
    )
    .orderBy('credential.family_id')
    .execute()
  const familyIds = [
    ...new Set(
      credentials.flatMap((row) => (row.familyId ? [row.familyId] : [])),
    ),
  ]
  const kept = credentials.find(
    (row) =>
      row.familyId !== null &&
      credentials.filter((other) => other.familyId === row.familyId).length ===
        1 &&
      row.device_id === ACTIVE_CLI_DEVICE_ID &&
      // A fresh production reissue has not been used; the capture shows use.
      row.last_used_at !== null &&
      row.revoked_at === null &&
      row.expires_at > clock &&
      row.status === 'active' &&
      Boolean(row.linked),
  )
  await deleteCliFixtureFamilies(
    db,
    userId,
    familyIds.filter((id) => id !== kept?.familyId),
  )
  if (kept) return
  const sessionToken = await insertCliSourceSession(db, userId, now)
  const issued = await issueCliRefreshCredential(
    db,
    userId,
    sessionToken,
    ACTIVE_CLI_DEVICE_NAME,
    ACTIVE_CLI_DEVICE_ID,
  )
  if (!issued) throw new Error('Settings seed active CLI issue failed')
  const familyId = await issuedSessionFamilyId(db, sessionToken)
  const { created_at } = await db
    .selectFrom('cli_refresh_credentials')
    .select('created_at')
    .where('id', '=', familyId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('cli_refresh_credentials')
    .set({ last_used_at: laterIso(now, created_at) })
    .where('id', '=', familyId)
    .execute()
}

function ensureMixedAgentProject(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<string> {
  return ensureFixtureProject(db, workspaceId, userId, {
    name: MIXED_AGENT_PROJECT,
    description: AGENT_PROJECT_DESCRIPTION,
  })
}

function mixedSessionId(
  workspaceId: string,
  userId: string,
  preset: 'agent' | 'publisher',
) {
  return `${workspaceId}-${userId}-mixed-${preset}-session`
}

/** The pending code the auth device endpoint would have stored. */
async function insertPendingFixtureDeviceCode(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  preset: 'agent' | 'publisher',
) {
  const id = `${workspaceId}-${userId}-mixed-${preset}-code`
  const deviceCode = `${workspaceId}-${userId}-mixed-${preset}-token`
  const userCode = devPublisherUserCode(id)
  await db.deleteFrom('deviceCode').where('id', '=', id).execute()
  await db
    .insertInto('deviceCode')
    .values({
      id,
      deviceCode,
      userCode,
      userId,
      expiresAt: new Date(Date.now() + 10 * MINUTE_MS).toISOString(),
      status: 'pending',
      lastPolledAt: null,
      pollingInterval: 5,
      clientId: 'artifactshare-cli',
      scope: null,
      preset: null,
      deviceName: null,
      approvalNonce: null,
      selectedProjectId: null,
      requestedProjectSelector: null,
    })
    .execute()
  return { id, deviceCode, userCode }
}

async function issueMixedAgentFamily(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  projectId: string,
  now: string,
): Promise<string> {
  const code = await insertPendingFixtureDeviceCode(
    db,
    workspaceId,
    userId,
    'agent',
  )
  await storeDeviceAuthorizationIntent(code.deviceCode, {
    preset: 'agent',
    deviceName: null,
    projectSelector: null,
  })
  const { email } = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  const selected = await selectAgentApprovalProject({
    userCode: code.userCode,
    userId,
    workspaceId,
    email,
    projectId,
  })
  if (!selected) throw new Error('Settings seed agent approval failed')
  const intent = await loadDeviceAuthorizationIntent(code.deviceCode)
  if (!intent) throw new Error('Settings seed agent intent missing')
  const sessionToken = await insertCliSourceSession(
    db,
    userId,
    now,
    mixedSessionId(workspaceId, userId, 'agent'),
  )
  if (!(await attachAgentBootstrapAuthority(sessionToken, intent)))
    throw new Error('Settings seed agent bootstrap failed')
  if (!(await issueCliRefreshCredential(db, userId, sessionToken)))
    throw new Error('Settings seed agent issue failed')
  await db.deleteFrom('deviceCode').where('id', '=', code.id).execute()
  return issuedSessionFamilyId(db, sessionToken)
}

async function issueMixedPublisherFamily(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
): Promise<string> {
  // Client names are unique per user, so approval continues the named client.
  const [client, code] = await Promise.all([
    db
      .selectFrom('publisher_clients')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where('name', '=', MIXED_PUBLISHER_CLIENT)
      .executeTakeFirst(),
    insertPendingFixtureDeviceCode(db, workspaceId, userId, 'publisher'),
  ])
  await storeDeviceAuthorizationIntent(code.deviceCode, {
    preset: 'publisher',
    deviceName: MIXED_PUBLISHER_CLIENT,
    projectSelector: null,
  })
  const selected = await selectPublisherApprovalClient({
    userCode: code.userCode,
    userId,
    workspaceId,
    choice: client
      ? { mode: 'continue-existing', client_id: client.id }
      : { mode: 'create-new' },
  })
  if (!selected) throw new Error('Settings seed publisher approval failed')
  const intent = await loadDeviceAuthorizationIntent(code.deviceCode)
  if (!intent?.selectedPublisherClientId)
    throw new Error('Settings seed publisher intent missing')
  const sessionToken = await insertCliSourceSession(
    db,
    userId,
    now,
    mixedSessionId(workspaceId, userId, 'publisher'),
  )
  if (!(await attachPublisherBootstrapAuthority(sessionToken, intent)))
    throw new Error('Settings seed publisher bootstrap failed')
  if (!(await issueCliRefreshCredential(db, userId, sessionToken)))
    throw new Error('Settings seed publisher issue failed')
  await db.deleteFrom('deviceCode').where('id', '=', code.id).execute()
  return issuedSessionFamilyId(db, sessionToken)
}

function loadMixedFamilies(
  db: Kysely<DB>,
  userId: string,
  familyIds: string[],
) {
  return db
    .selectFrom('cli_family_authorities as family')
    .leftJoin(
      'publisher_clients as client',
      'client.id',
      'family.publisher_client_id',
    )
    .leftJoin(
      'cli_refresh_sessions as link',
      'link.family_id',
      'family.family_id',
    )
    .leftJoin(
      'cli_session_authorities as authority',
      'authority.session_id',
      'link.session_id',
    )
    .leftJoin(
      'cli_refresh_credentials as credential',
      'credential.family_id',
      'family.family_id',
    )
    .select(({ selectFrom }) => [
      'family.family_id as familyId',
      'family.preset',
      'family.status',
      'family.project_id as projectId',
      'family.agent_profile_id as agentProfileId',
      'family.publisher_client_id as publisherClientId',
      'client.name as clientName',
      'authority.kind as authorityKind',
      'authority.family_id as authorityFamilyId',
      'authority.project_id as authorityProjectId',
      'authority.agent_profile_id as authorityProfileId',
      'authority.publisher_client_id as authorityClientId',
      'credential.created_at as credentialCreatedAt',
      'credential.revoked_at as credentialRevokedAt',
      'credential.expires_at as credentialExpiresAt',
      'credential.last_used_at as credentialLastUsedAt',
      'credential.token_hash as credentialTokenHash',
      selectFrom('cli_refresh_credentials as counted')
        .select(sql<number>`count(*)`.as('count'))
        .whereRef('counted.family_id', '=', 'family.family_id')
        .as('credentialCount'),
    ])
    .where('family.user_id', '=', userId)
    .where('family.family_id', 'in', familyIds)
    .orderBy('family.family_id')
    .execute()
}

function mixedFamilyHealthy(
  row: Awaited<ReturnType<typeof loadMixedFamilies>>[number],
  preset: MixedPreset,
  agentProjectId: string,
  clock: string,
): boolean {
  const live =
    row.preset === preset &&
    row.status === 'active' &&
    Number(row.credentialCount) === 1 &&
    row.credentialRevokedAt === null &&
    row.credentialExpiresAt !== null &&
    row.credentialExpiresAt > clock &&
    // The issuer stores a SHA-256 hex digest; hand-written rows did not.
    /^[0-9a-f]{64}$/.test(row.credentialTokenHash ?? '')
  if (!live) return false
  if (preset === 'unrestricted') return row.authorityKind === null
  if (row.authorityKind !== 'family' || row.authorityFamilyId !== row.familyId)
    return false
  return preset === 'agent'
    ? row.projectId === agentProjectId &&
        row.authorityProjectId === agentProjectId &&
        row.agentProfileId !== null &&
        row.authorityProfileId === row.agentProfileId
    : row.clientName === MIXED_PUBLISHER_CLIENT &&
        row.authorityClientId === row.publisherClientId
}

async function applyMixedFamilyTime(
  db: Kysely<DB>,
  familyId: string,
  createdAt: string,
  now: string,
) {
  await db
    .updateTable('cli_refresh_credentials')
    .set({ created_at: createdAt, last_used_at: laterIso(now, createdAt) })
    .where('family_id', '=', familyId)
    .execute()
  await db
    .updateTable('cli_family_authorities')
    .set({
      created_at: createdAt,
      approved_at: createdAt,
      updated_at: createdAt,
    })
    .where('family_id', '=', familyId)
    .execute()
  await db
    .updateTable('cli_session_authorities')
    .set({ created_at: createdAt })
    .where('family_id', '=', familyId)
    .execute()
}

async function issueMixedUnrestrictedFamily(db: Kysely<DB>, userId: string) {
  const known = await db
    .selectFrom('cli_refresh_credentials')
    .select('id')
    .where('user_id', '=', userId)
    .execute()
  const before = new Set(known.map((row) => row.id))
  await issueCliRefreshCredential(db, userId)
  const issued = await db
    .selectFrom('cli_refresh_credentials')
    .select('id')
    .where('user_id', '=', userId)
    .execute()
  const credential = issued.find((row) => !before.has(row.id))
  if (!credential) throw new Error('Settings seed CLI issue failed')
  return credential.id
}

async function seedMixedPresetsFixture(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
) {
  const agentProjectId = await ensureMixedAgentProject(db, workspaceId, userId)
  const clock = laterIso(now, nowIso())
  // A family is the fixture's by preset and the label the list renders for
  // the fixture user, even once a revoke has deleted its session link:
  // Publisher by its client name, Agent and Unrestricted by having no device
  // label. Scoped families also belong to the scenario workspace. Rows an
  // earlier seed wrote by hand fail the health check and are replaced.
  const unlabeled = sql<boolean>`NOT EXISTS (SELECT 1 FROM cli_refresh_credentials labeled WHERE labeled.family_id = family.family_id AND labeled.device_name IS NOT NULL)`
  const owned = await db
    .selectFrom('cli_family_authorities as family')
    .leftJoin(
      'publisher_clients as client',
      'client.id',
      'family.publisher_client_id',
    )
    .select('family.family_id')
    .where('family.user_id', '=', userId)
    .where((eb) =>
      eb.or([
        eb.and([eb('family.preset', '=', 'unrestricted'), unlabeled]),
        eb.and([
          eb('family.preset', '=', 'agent'),
          eb('family.workspace_id', '=', workspaceId),
          unlabeled,
        ]),
        eb.and([
          eb('family.preset', '=', 'publisher'),
          eb('family.workspace_id', '=', workspaceId),
          eb('client.name', '=', MIXED_PUBLISHER_CLIENT),
        ]),
      ]),
    )
    .execute()
  const ownedIds = owned.map((row) => row.family_id)
  const rows =
    ownedIds.length > 0 ? await loadMixedFamilies(db, userId, ownedIds) : []
  // Only rows in the fixture state stay: healthy, already used, and on the
  // creation offsets of the families kept before them.
  const retained = new Map<MixedPreset, (typeof rows)[number]>()
  let baseMs: number | null = null
  for (const preset of MIXED_PRESETS)
    for (const row of rows) {
      if (
        row.credentialLastUsedAt === null ||
        !mixedFamilyHealthy(row, preset, agentProjectId, clock)
      )
        continue
      const rowBase =
        Date.parse(row.credentialCreatedAt!) - MIXED_PRESET_OFFSET_MS[preset]
      if (baseMs !== null && rowBase !== baseMs) continue
      baseMs = rowBase
      retained.set(preset, row)
      break
    }
  const retainedIds = new Set([...retained.values()].map((row) => row.familyId))
  await deleteCliFixtureFamilies(
    db,
    userId,
    ownedIds.filter((id) => !retainedIds.has(id)),
  )
  for (const preset of MIXED_PRESETS) {
    if (retained.has(preset)) continue
    const familyId =
      preset === 'unrestricted'
        ? await issueMixedUnrestrictedFamily(db, userId)
        : preset === 'publisher'
          ? await issueMixedPublisherFamily(db, workspaceId, userId, now)
          : await issueMixedAgentFamily(
              db,
              workspaceId,
              userId,
              agentProjectId,
              now,
            )
    if (baseMs === null) {
      const { created_at } = await db
        .selectFrom('cli_refresh_credentials')
        .select('created_at')
        .where('id', '=', familyId)
        .executeTakeFirstOrThrow()
      baseMs = Date.parse(created_at)
    }
    await applyMixedFamilyTime(
      db,
      familyId,
      new Date(baseMs + MIXED_PRESET_OFFSET_MS[preset]).toISOString(),
      now,
    )
  }
}

/**
 * Settings capture states write their rows through the production services
 * that create them in the product (bots, API tokens, members, CLI credentials,
 * external links). The direct writes that remain, and why:
 *
 * - Workspace anchor and default reset, Billing reset fields before the
 *   subscription sync, near-limit usage counters: a deterministic local anchor;
 *   production derives the workspace from sign-up, and capture usage is
 *   synthetic.
 * - Synthetic human accounts and profile updates (long-owner name and address,
 *   initial-avatar reset): accounts come from auth; membership is still a
 *   service write.
 * - Transfer file, inventory artifact rows and the private link precursor, and
 *   their ownership, container and reset: creating an artifact needs upload
 *   storage; sharing the link still goes through the product's edit service.
 * - Synthetic CLI source sessions and the pending Agent and Publisher device
 *   codes: they stand in for the auth device endpoints; the production
 *   helpers write the approval, client, profile, authorities, credential and
 *   family.
 * - Timestamps that show past use, expiry, order or stopped history, and the
 *   zero-state link expiry: services write at the current clock.
 * - The single long bot email: an overflow fixture beyond the generator's
 *   normal length.
 * - Historical activity audit events: past actions without replaying
 *   destructive or external operations.
 * - Slack connection upsert and delete: install and revoke need live Slack.
 * - Scoped cleanup of old or capture-changed fixture rows: capture reset is
 *   local-only.
 *
 * A fixture row is recognized inside its scenario workspace by its name (or by
 * its fixed ID when the seed writes it directly). Rows in other workspaces and
 * rows whose name matches no fixture are left alone.
 */
export async function seedDevScreenState(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
  userId: string,
  now: string,
): Promise<{ containerId: string | null; containerKind: 'inbox' | 'project' }> {
  await refuseAuthoredFixtureBots(db, scenario, workspaceId)
  if (scenario === 'settings/long-member-addresses') {
    await seedLongMemberAddresses(
      db,
      await scenarioOwnerActor(db, workspaceId, userId),
      now,
    )
    return { containerId: null, containerKind: 'inbox' }
  }
  if (scenario === 'settings/result-warning') {
    await seedResultWarningMember(
      db,
      await scenarioOwnerActor(db, workspaceId, userId),
      now,
    )
    return { containerId: null, containerKind: 'inbox' }
  }
  if (scenario === 'settings-bots/long-email') {
    const result = await seedDevScreenState(
      db,
      'settings/with-bots',
      workspaceId,
      userId,
      now,
    )
    await db
      .updateTable('users')
      .set({
        email: `nightly-report-automation-with-a-long-destination-address-${workspaceId}@bots.artifactshare.invalid`,
      })
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'bot')
      .where('name', '=', ACTIVE_BOT_NAME)
      .where('bot_stopped_at', 'is', null)
      .execute()
    return result
  }
  if (scenario === 'settings-general/long-owner') {
    const workspace = await db
      .selectFrom('workspaces')
      .select('plan')
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('users')
      .set({
        name: 'Synthetic workspace owner with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
        email: devScreenUserEmail(`${workspace.plan}-owner`, scenario),
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', workspaceId)
          .where('role', '=', 'owner')
          .where('status', '=', 'active'),
      )
      .execute()
  }
  if (scenario === 'settings-general/initial-avatar') {
    await db
      .updateTable('users')
      .set({ image: null })
      .where('id', '=', userId)
      .execute()
  }
  if (scenario.startsWith('settings-inventory-')) {
    const projectId = await seedSettingsInventory(
      db,
      scenario,
      workspaceId,
      userId,
      now,
    )
    return { containerId: projectId, containerKind: 'project' }
  }
  if (scenario.startsWith('search/'))
    return seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
  if (managedRetentionScenarios.has(scenario)) {
    const readonly = scenario === 'viewer/retention-managed-readonly'
    const index = readonly ? 1 : 21
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-${index}`)
    // Reset only this scenario's artifact before the base fixture restores access.
    await db
      .updateTable('shareables')
      .set({ current_version_id: null })
      .where('id', '=', shareableId)
      .execute()
    await db
      .deleteFrom('versions')
      .where('shareable_id', '=', shareableId)
      .execute()
    await db
      .deleteFrom('version_retention_tombstones')
      .where('shareable_id', '=', shareableId)
      .execute()
    const seeded = await seedDevScreenState(
      db,
      readonly ? 'viewer/revisit-context' : 'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    const artifact = await db
      .selectFrom('shareables')
      .select('owner_user_id')
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const clientId = `${workspaceId}-scheduled`
    await db
      .insertInto('publisher_clients')
      .values({
        id: clientId,
        workspace_id: workspaceId,
        user_id: artifact.owner_user_id,
        name: 'Scheduled reports',
        created_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .updateTable('shareables')
      .set({ current_version_id: null, version_sequence: 0 })
      .where('id', '=', shareableId)
      .execute()
    await db
      .deleteFrom('versions')
      .where('shareable_id', '=', shareableId)
      .execute()
    for (let number = 1; number <= 4; number++) {
      const versionId = `${shareableId}-v${number}`
      const publishedAt = new Date(
        Date.parse(now) - (4 - number) * 3_600_000,
      ).toISOString()
      await db
        .insertInto('versions')
        .values({
          id: versionId,
          shareable_id: shareableId,
          artifact_kind: 'html_page',
          status: 'published',
          entrypoint_path: '/index.html',
          r2_key: `dev-screen/${versionId}`,
          size_bytes: new TextEncoder().encode(managedRetentionBody(number))
            .byteLength,
          sha256: versionId,
          created_by_id: artifact.owner_user_id,
          created_by_publisher_client_id: number > 2 ? clientId : null,
          created_at: publishedAt,
          published_at: publishedAt,
        })
        .execute()
    }
    await db
      .updateTable('shareables')
      .set({
        current_version_id: `${shareableId}-v${scenario === 'viewer/retention-managed-older-current' ? 3 : 4}`,
        created_by_publisher_client_id: clientId,
        assigned_publisher_client_id: null,
        retain_versions:
          scenario === 'viewer/retention-managed-unlimited'
            ? null
            : scenario === 'viewer/retention-managed-older-current'
              ? 1
              : 2,
        updated_at: now,
      })
      .where('id', '=', shareableId)
      .execute()
    return seeded
  }
  if (
    scenario === 'viewer/retention-expanded' ||
    scenario === 'viewer/retention-saved'
  ) {
    scenario = 'recent/content-rich'
  }
  if (scenario === 'viewer/retention-removed') {
    const seeded = await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    await db
      .deleteFrom('version_retention_tombstones')
      .where('shareable_id', '=', shareableId)
      .execute()
    await db
      .insertInto('version_retention_tombstones')
      .values({
        version_id: `${shareableId}-removed-v1`,
        shareable_id: shareableId,
        version_number: 1,
        removed_at: now,
      })
      .execute()
    return seeded
  }
  if (scenario === 'viewer/scheduled-updates') {
    const seeded = await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-21`)
    const clientId = `${workspaceId}-scheduled`
    await db
      .insertInto('publisher_clients')
      .values({
        id: clientId,
        workspace_id: workspaceId,
        user_id: userId,
        name: 'Scheduled reports',
        created_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    const human = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', `${shareableId}-v2`)
      .executeTakeFirstOrThrow()
    const versionId = `${shareableId}-v3`
    await db
      .insertInto('versions')
      .values({
        ...human,
        id: versionId,
        number: 3,
        label: 'Hourly data refresh',
        created_by_publisher_client_id: clientId,
        created_at: now,
        published_at: now,
        r2_key: `dev-screen/${versionId}`,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .updateTable('shareables')
      .set({
        current_version_id: versionId,
        created_by_publisher_client_id: clientId,
        updated_at: now,
      })
      .where('id', '=', shareableId)
      .execute()
    return seeded
  }
  const hasProjectPins =
    scenario === 'project-detail/with-pins' ||
    scenario === 'project-detail/scheduled-pins'

  const seedsRepresentativeFeed =
    scenario === 'home/content-rich' ||
    scenario === 'home/updates-menu-open' ||
    scenario === 'project-detail/with-files'
  const needsProject =
    scenario.startsWith('project-detail/') ||
    scenario === 'viewer/access-requests' ||
    scenario === 'projects-archived/with-archived-project' ||
    scenario === 'device/fixed-project'
  const settingsScenario = isSettingsScenario(scenario)
  const containerId = needsProject
    ? `${workspaceId}-container`
    : settingsScenario
      ? await getOrCreateInboxContainerId(db, workspaceId, userId, now)
      : `${workspaceId}-${userId}-container`
  if (!settingsScenario)
    await db
      .insertInto('artifact_containers')
      .values({
        id: containerId,
        workspace_id: workspaceId,
        kind: needsProject ? 'project' : 'inbox',
        owner_user_id: needsProject ? null : userId,
        created_by_id: userId,
        name:
          scenario === 'projects-archived/with-archived-project'
            ? 'Archived launch'
            : needsProject
              ? 'Launch review'
              : INBOX_CONTAINER_NAME,
        description: needsProject ? 'Representative screen state' : null,
        base_visibility:
          scenario === 'device/fixed-project' ? 'workspace' : 'private',
        archived_at:
          scenario === 'projects-archived/with-archived-project' ? now : null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  if (
    scenario === 'device/fixed-project' ||
    scenario === 'device/fixed-project-unavailable'
  ) {
    await db
      .insertInto('deviceCode')
      .values({
        id: `${workspaceId}-device-code`,
        deviceCode: `${workspaceId}-device-token`,
        userCode: scenario === 'device/fixed-project' ? 'ABCD1234' : 'EFGH5678',
        userId,
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'pending',
        lastPolledAt: null,
        pollingInterval: 5,
        clientId: 'artifactshare-cli',
        scope: null,
        preset: 'agent',
        deviceName: 'Artifact Share CLI',
        approvalNonce: `${workspaceId}-approval`,
        selectedProjectId: null,
        requestedProjectSelector:
          scenario === 'device/fixed-project'
            ? 'Launch review'
            : 'Unavailable project',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }
  if (
    scenario === 'device/unrestricted' ||
    scenario === 'device/unrestricted-confirmed'
  ) {
    await db
      .insertInto('deviceCode')
      .values({
        id: `${workspaceId}-device-code`,
        deviceCode: `${workspaceId}-device-token`,
        userCode: devPublisherUserCode(workspaceId),
        userId,
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'pending',
        lastPolledAt: null,
        pollingInterval: 5,
        clientId: 'artifactshare-cli',
        scope: null,
        preset: null,
        deviceName: null,
        approvalNonce: null,
        selectedProjectId: null,
        requestedProjectSelector: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }
  if (scenario.startsWith('device/publisher-')) {
    const expiresAt =
      scenario === 'device/publisher-expired'
        ? '2000-01-01T00:00:00.000Z'
        : '2099-01-01T00:00:00.000Z'
    const name =
      scenario === 'device/publisher-long-name'
        ? 'Dashboard '.repeat(10).trim()
        : 'Employee dashboard'
    await db
      .insertInto('deviceCode')
      .values({
        id: `${workspaceId}-publisher-code`,
        deviceCode: `${workspaceId}-publisher-token`,
        userCode: devPublisherUserCode(workspaceId),
        userId,
        expiresAt,
        status: 'pending',
        lastPolledAt: null,
        pollingInterval: 5,
        clientId: 'artifactshare-cli',
        scope: null,
        preset: 'publisher',
        deviceName: name,
        approvalNonce: `${workspaceId}-publisher-approval`,
        selectedProjectId: null,
        requestedProjectSelector: null,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          userCode: devPublisherUserCode(workspaceId),
          expiresAt,
        }),
      )
      .execute()
    if (scenario !== 'device/publisher-new')
      await db
        .insertInto('publisher_clients')
        .values({
          id: `${workspaceId}-publisher-client`,
          user_id: userId,
          workspace_id: workspaceId,
          name,
          created_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
  }
  if (scenario === 'settings-tokens/mixed-presets')
    await seedMixedPresetsFixture(db, workspaceId, userId, now)
  if (scenario === 'project-detail/slack-reauthorization') {
    await db
      .insertInto('container_slack_channels')
      .values({
        container_id: containerId,
        webhook_url: 'https://hooks.slack.test/expired',
        channel_id: 'C-SCREEN',
        channel_name: 'launch-review',
        slack_team_id: 'T-SCREEN',
        slack_team_name: 'Screen workspace',
        configuration_url: null,
        created_by: userId,
        updated_by: userId,
        created_at: now,
        updated_at: now,
        last_error_at: now,
        last_error_status: 404,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
  const representativeFeedAnchor = seedsRepresentativeFeed
    ? (
        await db
          .selectFrom('artifact_containers')
          .select('created_at')
          .where('id', '=', containerId)
          .executeTakeFirstOrThrow()
      ).created_at
    : now

  if (scenario === 'recent/content-rich') {
    await db
      .deleteFrom('version_retention_tombstones')
      .where(
        'shareable_id',
        'in',
        db
          .selectFrom('shareables')
          .select('id')
          .where('workspace_id', '=', workspaceId),
      )
      .execute()
  }

  if (scenario === 'home/empty' || scenario === 'home/first-file') {
    await db
      .deleteFrom('shareables')
      .where('workspace_id', '=', workspaceId)
      .execute()
  }

  if (
    scenario === 'files/unopened-and-sharing' ||
    scenario === 'home/content-rich' ||
    scenario === 'home/updates-menu-open' ||
    scenario === 'home/unopened-file' ||
    scenario === 'home/first-file' ||
    scenario === 'recent/content-rich' ||
    scenario === 'viewer/link-suspended' ||
    scenario === 'viewer/bridge-attribution' ||
    scenario === 'viewer/csp-diagnostics' ||
    scenario === 'viewer/access-requests' ||
    scenario === 'project-detail/with-files' ||
    hasProjectPins
  ) {
    const representativeNames =
      scenario === 'files/unopened-and-sharing'
        ? [
            'Unopened report.html',
            'Updated unopened report.html',
            'Shared with a recipient.html',
            'Private notes.html',
          ]
        : scenario === 'viewer/csp-diagnostics'
          ? ['Script diagnostic.html', 'Environment diagnostic.html']
          : scenario === 'home/first-file'
            ? ['First file.html']
            : scenario === 'viewer/bridge-attribution'
              ? ['Market research.html']
              : scenario === 'viewer/access-requests'
                ? ['FY2027 product strategy.html']
                : scenario === 'home/unopened-file'
                  ? [
                      'Quarterly report.html',
                      'Design handoff.html',
                      'Launch notes.md',
                      'Hiring plan.html',
                      'KPI review.md',
                      'Release checklist.html',
                    ]
                  : [
                      'Quarterly report.html',
                      'Design handoff.html',
                      'Launch notes.md',
                    ]
    const names =
      scenario === 'recent/content-rich'
        ? [
            ...representativeNames,
            // Keep the recent v2 original and its same-name v1 duplicate on page 2.
            ...Array.from(
              { length: 20 },
              (_, index) =>
                `Archived review ${index === 18 ? 21 : index + 4}.html`,
            ),
          ]
        : representativeNames
    const firstViewedAt = new Date(
      Date.parse(now) - 2 * 3_600_000,
    ).toISOString()
    const commentAt = new Date(Date.parse(now) - 3_600_000).toISOString()
    const shareableIds = names.map((_, index) =>
      devShareableId(
        needsProject
          ? `${workspaceId}-file-${index + 1}`
          : `${workspaceId}-${userId}-file-${index + 1}`,
      ),
    )
    if (hasProjectPins) {
      await db
        .insertInto('publisher_clients')
        .values({
          id: `${workspaceId}-scheduled`,
          workspace_id: workspaceId,
          user_id: userId,
          name: 'Scheduled reports',
          created_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
    await Promise.all(
      names.map(async (name, index) => {
        const shareableId = shareableIds[index]!
        const minutesAgo = seedsRepresentativeFeed
          ? index === 2
            ? 5
            : index === 0
              ? 180
              : index * 26 * 60
          : hasProjectPins
            ? (index + 1) * 26 * 60
            : index * 26 * 60
        const timestamp = new Date(
          Date.parse(representativeFeedAnchor) - minutesAgo * 60_000,
        ).toISOString()
        const visibility = needsProject
          ? 'project'
          : ((scenario === 'recent/content-rich' ||
                scenario === 'viewer/link-suspended') &&
                index === 0) ||
              scenario === 'viewer/bridge-attribution' ||
              scenario === 'viewer/csp-diagnostics'
            ? 'link'
            : 'private'
        const existing = await db
          .selectFrom('shareables')
          .select('id')
          .where('id', '=', shareableId)
          .executeTakeFirst()
        if (existing) {
          if (visibility === 'link') {
            await db
              .updateTable('shareables')
              .set({ visibility: 'link' })
              .where('id', '=', shareableId)
              .execute()
          }
        } else {
          // Deleted deterministic fixtures can retain an active publication
          // ID. Reset only that fixture row before recreating the fixture.
          await db
            .deleteFrom('link_publications')
            .where('workspace_id', '=', workspaceId)
            .where('shareable_id', '=', shareableId)
            .execute()
          await db
            .insertInto('shareables')
            .values({
              id: shareableId,
              workspace_id: workspaceId,
              owner_user_id: userId,
              slug: null,
              name,
              derived_title: name.replace(/\.(html|md)$/, ''),
              title_override: null,
              description: null,
              artifact_kind: name.endsWith('.md')
                ? 'markdown_page'
                : 'html_page',
              visibility,
              current_version_id: null,
              container_id: containerId,
              created_at: timestamp,
              updated_at: timestamp,
              last_accessed_at: timestamp,
              link_expires_at: null,
            })
            .execute()
        }
        if (
          scenario === 'recent/content-rich' ||
          scenario === 'viewer/link-suspended' ||
          scenario === 'viewer/bridge-attribution' ||
          scenario === 'viewer/csp-diagnostics' ||
          scenario === 'home/unopened-file' ||
          scenario === 'files/unopened-and-sharing'
        ) {
          const versionNames =
            scenario === 'files/unopened-and-sharing'
              ? index === 1
                ? (['v1', 'v2'] as const)
                : (['v1'] as const)
              : scenario === 'home/unopened-file'
                ? (['v1'] as const)
                : scenario === 'viewer/bridge-attribution' ||
                    scenario === 'viewer/csp-diagnostics'
                  ? (['v1'] as const)
                  : index === 20
                    ? (['v1', 'v2'] as const)
                    : index === 0 || index === 19 || index === 21
                      ? (['v1'] as const)
                      : []
          if (versionNames.length > 0) {
            for (const versionName of versionNames) {
              const versionId = `${shareableId}-${versionName}`
              const isUpdatedVersion =
                versionName === 'v2' &&
                (index === 20 || scenario === 'files/unopened-and-sharing')
              const versionTimestamp = isUpdatedVersion
                ? new Date(Date.parse(now) - 30 * 60_000).toISOString()
                : timestamp
              const body =
                scenario === 'viewer/csp-diagnostics'
                  ? CSP_DIAGNOSTIC_BODIES[index]
                  : recentContentRichBody(index, versionName)
              const sizeBytes = body
                ? new TextEncoder().encode(body).byteLength
                : 1
              await db
                .insertInto('versions')
                .values({
                  id: versionId,
                  label: isUpdatedVersion ? 'Restructured' : null,
                  shareable_id: shareableId,
                  artifact_kind: 'html_page',
                  status: 'published',
                  entrypoint_path: '/index.html',
                  r2_key: `dev-screen/${versionId}`,
                  size_bytes: sizeBytes,
                  sha256: versionId,
                  created_by_id: userId,
                  created_at: versionTimestamp,
                  published_at: versionTimestamp,
                })
                .onConflict((oc) =>
                  oc.column('id').doUpdateSet({
                    label: isUpdatedVersion ? 'Restructured' : null,
                    shareable_id: shareableId,
                    artifact_kind: 'html_page',
                    status: 'published',
                    entrypoint_path: '/index.html',
                    r2_key: `dev-screen/${versionId}`,
                    size_bytes: sizeBytes,
                    sha256: versionId,
                    created_by_id: userId,
                    created_at: versionTimestamp,
                    published_at: versionTimestamp,
                  }),
                )
                .execute()
            }
            const currentVersionId = `${shareableId}-${versionNames.at(-1)}`
            await db
              .updateTable('shareables')
              .set({
                current_version_id: currentVersionId,
                ...(scenario === 'recent/content-rich' && index === 0
                  ? { retain_versions: 1 }
                  : {}),
                ...(index === 20
                  ? {
                      updated_at: new Date(
                        Date.parse(now) - 30 * 60_000,
                      ).toISOString(),
                    }
                  : {}),
              })
              .where('id', '=', shareableId)
              .execute()
          }
          await db
            .insertInto('shareable_viewer_recency')
            .values({
              shareable_id: shareableId,
              viewer_user_id: userId,
              first_viewed_at: index === 0 ? firstViewedAt : timestamp,
              last_viewed_at: index === 0 ? firstViewedAt : timestamp,
            })
            .onConflict((oc) =>
              oc.columns(['shareable_id', 'viewer_user_id']).doUpdateSet({
                first_viewed_at: index === 0 ? firstViewedAt : timestamp,
                last_viewed_at: index === 0 ? firstViewedAt : timestamp,
              }),
            )
            .execute()
          if (index === 0 && scenario !== 'files/unopened-and-sharing') {
            const commenterId = `${workspaceId}-commenter`
            const threadId = `${shareableId}-thread`
            const latestThreadId = `${shareableId}-thread-latest`
            const messageId = `${shareableId}-message`
            const latestMessageId = `${shareableId}-message-latest`
            await db
              .insertInto('users')
              .values({
                id: commenterId,
                email: `dev-commenter+${workspaceId}@artifactshare.local`,
                email_verified: 1,
                name: 'Mina Kato from the International Research Team',
                image: null,
                created_at: now,
                updated_at: now,
                workspace_id: workspaceId,
                locale: null,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  name: 'Mina Kato from the International Research Team',
                  email: `dev-commenter+${workspaceId}@artifactshare.local`,
                  updated_at: now,
                }),
              )
              .execute()
            await db
              .insertInto('comment_threads')
              .values({
                id: threadId,
                shareable_id: shareableId,
                status: 'open',
                created_by_id: commenterId,
                resolved_by_id: null,
                resolved_at: null,
                created_at: commentAt,
                updated_at: commentAt,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  shareable_id: shareableId,
                  status: 'open',
                  created_by_id: commenterId,
                  resolved_by_id: null,
                  resolved_at: null,
                  created_at: commentAt,
                  updated_at: commentAt,
                }),
              )
              .execute()
            await db
              .insertInto('comment_messages')
              .values({
                id: messageId,
                thread_id: threadId,
                body: '確認しました。次回の見通しも追記できますか？',
                agent: null,
                created_by_id: commenterId,
                created_at: commentAt,
                updated_at: commentAt,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  thread_id: threadId,
                  body: '確認しました。次回の見通しも追記できますか？',
                  created_by_id: commenterId,
                  created_at: commentAt,
                  updated_at: commentAt,
                }),
              )
              .execute()
            const latestCommentAt = new Date(
              Date.parse(commentAt) + 60_000,
            ).toISOString()
            await db
              .insertInto('comment_threads')
              .values({
                id: latestThreadId,
                shareable_id: shareableId,
                status: 'open',
                created_by_id: commenterId,
                resolved_by_id: null,
                resolved_at: null,
                created_at: latestCommentAt,
                updated_at: latestCommentAt,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  shareable_id: shareableId,
                  status: 'open',
                  created_by_id: commenterId,
                  resolved_by_id: null,
                  resolved_at: null,
                  created_at: latestCommentAt,
                  updated_at: latestCommentAt,
                }),
              )
              .execute()
            await db
              .insertInto('comment_messages')
              .values({
                id: latestMessageId,
                thread_id: latestThreadId,
                body: '部門別でも見られると助かります。特に第2四半期の数値について、前月との比較も確認したいです。次回の更新で補足をお願いします。 https://example.com/reports/quarterly/this-is-a-deliberately-long-unbroken-reference-that-must-wrap-inside-the-comment-card',
                agent: 'Research Assistant for Q4 Data',
                created_by_id: commenterId,
                created_at: latestCommentAt,
                updated_at: latestCommentAt,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  thread_id: latestThreadId,
                  body: '部門別でも見られると助かります。特に第2四半期の数値について、前月との比較も確認したいです。次回の更新で補足をお願いします。 https://example.com/reports/quarterly/this-is-a-deliberately-long-unbroken-reference-that-must-wrap-inside-the-comment-card',
                  agent: 'Research Assistant for Q4 Data',
                  created_by_id: commenterId,
                  created_at: latestCommentAt,
                  updated_at: latestCommentAt,
                }),
              )
              .execute()
            // Text comments for capturing anchor states: one whose quote and
            // context still occur once (attached) and one whose quoted text
            // is no longer in the file (needs a position check).
            const textComments = [
              {
                key: 'text-attached',
                quote: '前月比12%増',
                prefix: 'プロダクト部門は',
                suffix: '、営業部門は',
                body: 'この伸びの内訳も知りたいです。',
              },
              {
                key: 'text-needs-check',
                quote: '前年比20%減',
                prefix: '物流部門は',
                suffix: 'でした。',
                body: 'この数値は前回の版で見た箇所です。',
              },
            ]
            const textVersion = await db
              .selectFrom('shareables')
              .select('current_version_id')
              .where('id', '=', shareableId)
              .executeTakeFirst()
            for (const [offset, comment] of textComments.entries()) {
              const textThreadId = `${shareableId}-${comment.key}`
              const textAt = new Date(
                Date.parse(commentAt) - (offset + 1) * 120_000,
              ).toISOString()
              await db
                .insertInto('comment_threads')
                .values({
                  id: textThreadId,
                  shareable_id: shareableId,
                  status: 'open',
                  created_by_id: commenterId,
                  resolved_by_id: null,
                  resolved_at: null,
                  created_at: textAt,
                  updated_at: textAt,
                })
                .onConflict((oc) => oc.column('id').doNothing())
                .execute()
              await db
                .insertInto('comment_messages')
                .values({
                  id: `${textThreadId}-message`,
                  thread_id: textThreadId,
                  body: comment.body,
                  agent: null,
                  created_by_id: commenterId,
                  created_at: textAt,
                  updated_at: textAt,
                })
                .onConflict((oc) => oc.column('id').doNothing())
                .execute()
              await db
                .insertInto('comment_anchors')
                .values({
                  id: `${textThreadId}-anchor`,
                  thread_id: textThreadId,
                  version_id: textVersion?.current_version_id ?? null,
                  target_path: '/index.html',
                  quoted_text: comment.quote,
                  prefix_text: comment.prefix,
                  suffix_text: comment.suffix,
                  text_start: 0,
                  text_end: comment.quote.length,
                  css_path: null,
                  selector_format: 'quote-v1',
                  text_hash: null,
                  ambiguous_at_creation: null,
                  created_at: textAt,
                })
                .onConflict((oc) => oc.column('id').doNothing())
                .execute()
            }
            await db
              .updateTable('shareable_viewer_recency')
              .set({ comment_seen_through_at: commentAt })
              .where('shareable_id', '=', shareableId)
              .where('viewer_user_id', '=', userId)
              .execute()
            // 閲覧した人 (viewer list) capture 用: capture ユーザーと
            // commenter を active な workspace member にし、第 3 の閲覧者は
            // 個別共有だけを持つ社外行として recency をこの成果物へ足す。
            const thirdViewerId = `${workspaceId}-viewer-third`
            await db
              .insertInto('users')
              .values({
                id: thirdViewerId,
                email: `dev-viewer-third+${workspaceId}@artifactshare.local`,
                email_verified: 1,
                name: 'Sota Watanabe',
                image: null,
                created_at: now,
                updated_at: now,
                workspace_id: workspaceId,
                locale: null,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  name: 'Sota Watanabe',
                  email: `dev-viewer-third+${workspaceId}@artifactshare.local`,
                  workspace_id: workspaceId,
                  updated_at: now,
                }),
              )
              .execute()
            const memberRows = [
              { userId, role: 'owner' as const },
              { userId: commenterId, role: 'member' as const },
            ]
            for (const member of memberRows) {
              await db
                .insertInto('workspace_members')
                .values({
                  workspace_id: workspaceId,
                  user_id: member.userId,
                  role: member.role,
                  status: 'active',
                  first_contributed_at: null,
                  last_contributed_at: null,
                  removed_at: null,
                  removed_by: null,
                  created_at: now,
                  updated_at: now,
                })
                .onConflict((oc) =>
                  oc.columns(['workspace_id', 'user_id']).doUpdateSet({
                    status: 'active',
                    removed_at: null,
                    removed_by: null,
                    updated_at: now,
                  }),
                )
                .execute()
            }
            await db
              .insertInto('workspace_members')
              .values({
                workspace_id: workspaceId,
                user_id: thirdViewerId,
                role: 'member',
                status: 'removed',
                first_contributed_at: null,
                last_contributed_at: null,
                removed_at: now,
                removed_by: userId,
                created_at: now,
                updated_at: now,
              })
              .onConflict((oc) =>
                oc.columns(['workspace_id', 'user_id']).doUpdateSet({
                  status: 'removed',
                  removed_at: now,
                  removed_by: userId,
                  updated_at: now,
                }),
              )
              .execute()
            await db
              .insertInto('shareable_grants')
              .values({
                shareable_id: shareableId,
                granted_email: `dev-viewer-third+${workspaceId}@artifactshare.local`,
                granted_at: now,
                granted_by: userId,
              })
              .onConflict((oc) => oc.doNothing())
              .execute()
            const viewerRecencyRows = [
              { viewerUserId: commenterId, viewedAt: commentAt },
              { viewerUserId: thirdViewerId, viewedAt: firstViewedAt },
            ]
            for (const row of viewerRecencyRows) {
              await db
                .insertInto('shareable_viewer_recency')
                .values({
                  shareable_id: shareableId,
                  viewer_user_id: row.viewerUserId,
                  first_viewed_at: row.viewedAt,
                  last_viewed_at: row.viewedAt,
                })
                .onConflict((oc) =>
                  oc.columns(['shareable_id', 'viewer_user_id']).doUpdateSet({
                    first_viewed_at: row.viewedAt,
                    last_viewed_at: row.viewedAt,
                  }),
                )
                .execute()
            }
          }
        }
        if (hasProjectPins && index < 2) {
          // Scheduled pins cover publisher-only and mixed history; ordinary
          // pins keep human publication metadata without a freshness line.
          const versionNumbers = [1, 2, 3]
          for (const number of versionNumbers) {
            const scheduled =
              scenario === 'project-detail/scheduled-pins' &&
              (index === 0 || number !== 2)
            const versionId = `${shareableId}-scheduled-${number}`
            await db
              .insertInto('versions')
              .values({
                id: versionId,
                number,
                shareable_id: shareableId,
                artifact_kind: 'html_page',
                status: 'published',
                entrypoint_path: '/index.html',
                r2_key: `dev-screen/${versionId}`,
                size_bytes: 1,
                sha256: versionId,
                created_by_id: userId,
                created_by_publisher_client_id: scheduled
                  ? `${workspaceId}-scheduled`
                  : null,
                created_at: scheduled && number > 1 ? now : timestamp,
                published_at: scheduled && number > 1 ? now : timestamp,
              })
              .onConflict((oc) => oc.column('id').doNothing())
              .execute()
          }
          const currentId = `${shareableId}-scheduled-${versionNumbers.at(-1)}`
          await db
            .updateTable('shareables')
            .set({ current_version_id: currentId, updated_at: now })
            .where('id', '=', shareableId)
            .where(sql<boolean>`current_version_id IS NOT ${currentId}`)
            .execute()

          await db
            .insertInto('project_pins')
            .values({
              container_id: containerId!,
              shareable_id: shareableId,
              pinned_by_user_id: userId,
              created_at: timestamp,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        }
        if (seedsRepresentativeFeed) {
          await seedFeedEvents(db, {
            workspaceId,
            shareableId,
            ownerUserId: userId,
            index,
            now: representativeFeedAnchor,
            shareableCreatedAt: timestamp,
          })
        }
      }),
    )
    if (scenario === 'files/unopened-and-sharing') {
      await db
        .deleteFrom('shareable_viewer_recency')
        .where('viewer_user_id', '=', userId)
        .where('shareable_id', 'in', shareableIds.slice(0, 2))
        .execute()
      await db
        .insertInto('shareable_grants')
        .values({
          shareable_id: shareableIds[2]!,
          granted_email: 'reader@example.com',
          granted_at: now,
          granted_by: userId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    if (scenario === 'home/unopened-file') {
      await db
        .deleteFrom('shareable_viewer_recency')
        .where('viewer_user_id', '=', userId)
        .execute()
    }
  }

  if (scenario === 'projects/with-membership') {
    const otherId = `${workspaceId}-membership-other`
    await db
      .insertInto('users')
      .values({
        id: otherId,
        email: `dev-membership-other+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Aoi Sato',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    const projects = [
      { id: `${workspaceId}-joined-project`, name: 'Measurement platform' },
      { id: `${workspaceId}-joinable-project`, name: 'CS reply drafts' },
      { id: `${workspaceId}-joinable-empty`, name: 'Data analysis' },
    ]
    for (const project of projects) {
      await db
        .insertInto('artifact_containers')
        .values({
          id: project.id,
          workspace_id: workspaceId,
          kind: 'project',
          owner_user_id: null,
          created_by_id: otherId,
          name: project.name,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
    await db
      .insertInto('project_members')
      .values({
        container_id: `${workspaceId}-joined-project`,
        user_id: userId,
        joined_at: now,
        last_seen_at: '2026-01-01T00:00:00Z',
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    for (let index = 0; index < 2; index++) {
      await db
        .insertInto('shareables')
        .values({
          id: `${workspaceId}-membership-file-${index}`,
          workspace_id: workspaceId,
          owner_user_id: otherId,
          slug: null,
          name: `Weekly metrics ${index + 1}.html`,
          derived_title: `Weekly metrics ${index + 1}`,
          title_override: null,
          description: null,
          artifact_kind: 'html_page',
          visibility: 'workspace',
          current_version_id: null,
          container_id: `${workspaceId}-joined-project`,
          created_at: now,
          updated_at: now,
          last_accessed_at: now,
          link_expires_at: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
  }

  if (scenario === 'projects/stress-states') {
    const otherId = `${workspaceId}-stress-owner`
    const sourceWorkspaceId = `${workspaceId}-shared-source`
    const sourceOwnerId = `${sourceWorkspaceId}-owner`
    const sourceProjectId = `${sourceWorkspaceId}-project`
    const ensureWorkspace = async (id: string, name: string) => {
      await db
        .insertInto('workspaces')
        .values({
          id,
          hd: null,
          name,
          created_at: now,
          plan: 'free',
          storage_quota_bytes: 5_000_000_000,
          link_sharing_enabled: 1,
          external_posting_enabled: 0,
          ...linkExpiryStartingColumns(),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet(linkExpiryStartingColumns()),
        )
        .execute()
    }
    await ensureWorkspace(sourceWorkspaceId, 'Shared source workspace')
    await db
      .insertInto('users')
      .values({
        id: sourceOwnerId,
        email: `dev-shared-owner+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Shared project owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: sourceWorkspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.doUpdateSet({ updated_at: now }))
      .execute()
    await db
      .insertInto('users')
      .values({
        id: otherId,
        email: `dev-stress-owner+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Stress fixture owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.doUpdateSet({ updated_at: now }))
      .execute()
    const projectRows = [
      {
        id: `${workspaceId}-stress-joined`,
        name: 'Long project name that wraps to three lines on mobile screens',
        description:
          'A deliberately long description for checking compact project rows and mobile wrapping behavior.',
        createdById: otherId,
        archivedAt: null,
      },
      {
        id: `${workspaceId}-stress-joinable`,
        name: 'Joinable project with a deliberately long name for mobile wrapping',
        description:
          'A deliberately long joinable project description keeps the Join button beside a realistic multi-line row on narrow screens.',
        createdById: otherId,
        archivedAt: null,
      },
      {
        id: `${workspaceId}-stress-archived`,
        name: 'Archived project',
        description: 'Archived project for the toggle state.',
        createdById: otherId,
        archivedAt: now,
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `${workspaceId}-stress-extra-${index + 1}`,
        name: `Additional project ${String(index + 1).padStart(2, '0')}`,
        description: null,
        createdById: otherId,
        archivedAt: null,
      })),
    ]
    for (const project of projectRows) {
      await db
        .insertInto('artifact_containers')
        .values({
          id: project.id,
          workspace_id: workspaceId,
          kind: 'project',
          owner_user_id: null,
          created_by_id: project.createdById,
          name: project.name,
          description: project.description,
          base_visibility: 'workspace',
          archived_at: project.archivedAt,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.doUpdateSet({
            name: project.name,
            description: project.description,
            base_visibility: 'workspace',
            archived_at: project.archivedAt,
            updated_at: now,
          }),
        )
        .execute()
    }
    await db
      .insertInto('project_members')
      .values({
        container_id: `${workspaceId}-stress-joined`,
        user_id: userId,
        joined_at: now,
        last_seen_at: '2026-01-01T00:00:00.000Z',
      })
      .onConflict((oc) =>
        oc.doUpdateSet({
          last_seen_at: '2026-01-01T00:00:00.000Z',
        }),
      )
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: `${workspaceId}-stress-new-file`,
        workspace_id: workspaceId,
        owner_user_id: otherId,
        slug: null,
        name: 'New shared update.html',
        derived_title: 'New shared update',
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'project',
        current_version_id: null,
        container_id: `${workspaceId}-stress-joined`,
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        link_expires_at: null,
      })
      .onConflict((oc) => oc.doUpdateSet({ created_at: now, updated_at: now }))
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: sourceProjectId,
        workspace_id: sourceWorkspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: sourceOwnerId,
        name: 'Shared measurement platform with a deliberately long name',
        description: 'A project shared from a separate workspace.',
        base_visibility: 'private',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.doUpdateSet({
          name: 'Shared measurement platform with a deliberately long name',
          description: 'A project shared from a separate workspace.',
          updated_at: now,
        }),
      )
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: `${sourceProjectId}-grant`,
        project_container_id: sourceProjectId,
        email: 'dev-free-owner+projects-stress-states@artifactshare.local',
        role: 'viewer',
        display_name: 'Screen capture member',
        created_by_id: sourceOwnerId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('project_members')
      .values({
        container_id: sourceProjectId,
        user_id: userId,
        joined_at: now,
        last_seen_at: '2026-01-01T00:00:00.000Z',
      })
      .onConflict((oc) =>
        oc.doUpdateSet({
          last_seen_at: '2026-01-01T00:00:00.000Z',
        }),
      )
      .execute()
  }

  if (scenario === 'viewer/revisit-context') {
    const ownerId = `${workspaceId}-revisit-owner`
    const ownerContainerId = `${ownerId}-container`
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    const v1At = new Date(Date.parse(now) - 2 * 3_600_000).toISOString()
    const openingAt = new Date(Date.parse(now) - 90 * 60_000).toISOString()
    const boundaryAt = new Date(Date.parse(now) - 60 * 60_000).toISOString()
    const updateAt = new Date(Date.parse(now) - 30 * 60_000).toISOString()
    await db
      .insertInto('users')
      .values({
        id: ownerId,
        email: `revisit-owner+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Mina Kato',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: ownerContainerId,
        workspace_id: workspaceId,
        kind: 'inbox',
        owner_user_id: ownerId,
        created_by_id: ownerId,
        name: INBOX_CONTAINER_NAME,
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: shareableId,
        workspace_id: workspaceId,
        owner_user_id: ownerId,
        slug: null,
        name: 'Review handoff.html',
        derived_title: 'Review handoff',
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'workspace',
        current_version_id: `${shareableId}-v2`,
        retain_versions: 2,
        container_id: ownerContainerId,
        created_at: v1At,
        updated_at: updateAt,
        last_accessed_at: updateAt,
        link_expires_at: null,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          owner_user_id: ownerId,
          visibility: 'workspace',
          current_version_id: `${shareableId}-v2`,
          retain_versions: 2,
          container_id: ownerContainerId,
          updated_at: updateAt,
        }),
      )
      .execute()
    for (const [index, publishedAt] of [v1At, updateAt].entries()) {
      const versionId = `${shareableId}-v${index + 1}`
      await db
        .insertInto('versions')
        .values({
          id: versionId,
          shareable_id: shareableId,
          artifact_kind: 'html_page',
          status: 'published',
          entrypoint_path: '/index.html',
          r2_key: `dev-screen/${versionId}`,
          size_bytes: 200,
          sha256: versionId,
          created_by_id: ownerId,
          created_at: publishedAt,
          published_at: publishedAt,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            created_at: publishedAt,
            published_at: publishedAt,
          }),
        )
        .execute()
    }
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: shareableId,
        viewer_user_id: userId,
        first_viewed_at: v1At,
        last_viewed_at: v1At,
        version_seen_through_at: v1At,
        comment_seen_through_at: boundaryAt,
      })
      .onConflict((oc) =>
        oc.columns(['shareable_id', 'viewer_user_id']).doUpdateSet({
          first_viewed_at: v1At,
          last_viewed_at: v1At,
          version_seen_through_at: v1At,
          comment_seen_through_at: boundaryAt,
        }),
      )
      .execute()
    for (let index = 1; index <= 3; index += 1) {
      const threadId = `${shareableId}-thread-${index}`
      await db
        .insertInto('comment_threads')
        .values({
          id: threadId,
          shareable_id: shareableId,
          status: 'open',
          created_by_id: userId,
          resolved_by_id: null,
          resolved_at: null,
          created_at: openingAt,
          updated_at: updateAt,
        })
        .onConflict((oc) =>
          oc
            .column('id')
            .doUpdateSet({ created_at: openingAt, updated_at: updateAt }),
        )
        .execute()
      await db
        .insertInto('comment_messages')
        .values({
          id: `${threadId}-opening`,
          thread_id: threadId,
          body: `確認ポイント ${index}`,
          agent: null,
          created_by_id: index === 1 ? userId : ownerId,
          created_at: index === 2 ? updateAt : openingAt,
          updated_at: index === 2 ? updateAt : openingAt,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            created_at: index === 2 ? updateAt : openingAt,
            updated_at: index === 2 ? updateAt : openingAt,
          }),
        )
        .execute()
      if (index !== 2) {
        await db
          .insertInto('comment_messages')
          .values({
            id: `${threadId}-reply`,
            thread_id: threadId,
            body: index === 1 ? '反映しました。' : '確認します。',
            agent: null,
            created_by_id: index === 1 ? ownerId : userId,
            created_at: updateAt,
            updated_at: updateAt,
          })
          .onConflict((oc) =>
            oc
              .column('id')
              .doUpdateSet({ created_at: updateAt, updated_at: updateAt }),
          )
          .execute()
      }
    }
  }

  if (scenario === 'recent/content-rich') {
    const joinedWorkspaceId = `${workspaceId}-recent-joined-workspace`
    const joinedOwnerId = `${joinedWorkspaceId}-owner`
    const joinedProjectId = `${joinedWorkspaceId}-project`
    const joinedFileId = `${joinedProjectId}-file`
    const joinedViewedAt = new Date(Date.parse(now) - 30 * 60_000).toISOString()
    const viewer = await db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('workspaces')
      .values({
        id: joinedWorkspaceId,
        hd: null,
        name: 'Recent joined project workspace',
        created_at: now,
        plan: 'free',
        storage_quota_bytes: 5_000_000_000,
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        ...linkExpiryStartingColumns(),
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet(linkExpiryStartingColumns()),
      )
      .execute()
    await db
      .insertInto('users')
      .values({
        id: joinedOwnerId,
        email: `dev-recent-joined-owner+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Joined project owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: joinedWorkspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: joinedWorkspaceId,
        user_id: joinedOwnerId,
        role: 'owner',
        status: 'active',
        first_contributed_at: null,
        last_contributed_at: null,
        removed_at: null,
        removed_by: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: joinedProjectId,
        workspace_id: joinedWorkspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: joinedOwnerId,
        name: 'Cross-workspace research project',
        description: 'Recent project shared from another workspace.',
        base_visibility: 'private',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: `${joinedProjectId}-default`,
        project_container_id: joinedProjectId,
        email: viewer.email,
        role: 'viewer',
        display_name: 'Recent screen viewer',
        created_by_id: joinedOwnerId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('project_members')
      .values({
        container_id: joinedProjectId,
        user_id: userId,
        joined_at: now,
        last_seen_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: joinedFileId,
        workspace_id: joinedWorkspaceId,
        owner_user_id: joinedOwnerId,
        slug: null,
        name: 'Cross-workspace project file.html',
        derived_title: 'Cross-workspace project file',
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'project',
        current_version_id: null,
        container_id: joinedProjectId,
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        link_expires_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: joinedFileId,
        viewer_user_id: userId,
        first_viewed_at: joinedViewedAt,
        last_viewed_at: joinedViewedAt,
      })
      .onConflict((oc) =>
        oc.columns(['shareable_id', 'viewer_user_id']).doUpdateSet({
          first_viewed_at: joinedViewedAt,
          last_viewed_at: joinedViewedAt,
        }),
      )
      .execute()
    const restrictedOwnerId = `${workspaceId}-recent-restricted-owner`
    const restrictedId = `${workspaceId}-recent-restricted-file`
    await db
      .insertInto('users')
      .values({
        id: restrictedOwnerId,
        email: `dev-restricted-owner+${workspaceId}@artifactshare.local`,
        email_verified: 1,
        name: 'Restricted owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: `${restrictedOwnerId}-container`,
        workspace_id: workspaceId,
        kind: 'inbox',
        owner_user_id: restrictedOwnerId,
        created_by_id: restrictedOwnerId,
        name: INBOX_CONTAINER_NAME,
        description: null,
        base_visibility: 'private',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: restrictedId,
        workspace_id: workspaceId,
        owner_user_id: restrictedOwnerId,
        slug: null,
        name: 'Permission lost.html',
        derived_title: 'Permission lost',
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: `${restrictedOwnerId}-container`,
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        link_expires_at: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: restrictedId,
        viewer_user_id: userId,
        first_viewed_at: now,
        last_viewed_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['shareable_id', 'viewer_user_id']).doNothing(),
      )
      .execute()
  }

  if (scenario === 'settings-activity/with-activity') {
    const auditUser = await db
      .selectFrom('users')
      .select(['name', 'email'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    for (const [index, action] of [
      'plan.change',
      'artifact.delete',
      'artifact.publisher_adopted',
      'admin.grant',
      'bot.destinations.update',
    ].entries()) {
      await db
        .insertInto('audit_events')
        .values({
          id: `${workspaceId}-event-${index + 1}`,
          workspace_id: workspaceId,
          actor_user_id: userId,
          action,
          subject_type:
            action === 'artifact.publisher_adopted'
              ? 'shareable'
              : index === 0
                ? 'workspace'
                : 'user',
          subject_id:
            action === 'bot.destinations.update'
              ? `${workspaceId}-activity-bot`
              : action === 'artifact.publisher_adopted'
                ? 'abc123def4'
                : index === 0
                  ? workspaceId
                  : userId,
          detail:
            action === 'artifact.publisher_adopted'
              ? JSON.stringify({
                  artifact_title: 'Weekly dashboard',
                  previous_publisher_client_id: 'client2',
                  previous_publisher_client_name: 'Previous reports',
                  publisher_client_id: 'client1',
                  publisher_client_name: 'Reports',
                })
              : action === 'bot.destinations.update'
                ? JSON.stringify({
                    name: 'Nightly report bot',
                    project_id: 'reports',
                    project_ids: ['reports', 'management'],
                  })
                : action === 'plan.change'
                  ? JSON.stringify({ from: 'plus', to: 'team' })
                  : action === 'artifact.delete'
                    ? JSON.stringify({
                        name: 'A long representative project handoff file.html',
                      })
                    : JSON.stringify({ fromRole: 'member', toRole: 'admin' }),
          created_at: new Date(
            Date.parse(now) - index * 86_400_000,
          ).toISOString(),
        })
        .onConflict(resetFixtureAuditEvent)
        .execute()
    }
    const requestDetail = {
      access_request_id: 'req_demo_7n4x2k9p',
      artifact_id: `${workspaceId}-audit-artifact`,
      artifact_title:
        'Quarterly product strategy and customer feedback review.html',
      project_id: `${workspaceId}-audit-project`,
      project_name: 'Product planning and customer research',
      requester_id: userId,
      requester_name: 'Avery Tanaka',
      requester_email: 'avery.tanaka@example.com',
      handler_id: userId,
      handler_name: auditUser.name,
      handler_email: auditUser.email,
    }
    await db
      .insertInto('audit_events')
      .values([
        {
          id: `${workspaceId}-access-created`,
          workspace_id: workspaceId,
          actor_user_id: userId,
          action: 'access_request.created',
          subject_type: 'access_request',
          subject_id: requestDetail.access_request_id,
          detail: JSON.stringify({
            ...requestDetail,
            actor_id: userId,
            actor_name: requestDetail.requester_name,
            actor_email: requestDetail.requester_email,
          }),
          created_at: new Date(Date.parse(now) - 180_000).toISOString(),
        },
        {
          id: `${workspaceId}-access-email`,
          workspace_id: workspaceId,
          actor_user_id: null,
          action: 'access_request.email.succeeded',
          subject_type: 'access_request',
          subject_id: requestDetail.access_request_id,
          detail: JSON.stringify({
            ...requestDetail,
            recipient_id: userId,
            recipient_email: auditUser.email,
            notification_channel: 'email',
            delivery_outcome: 'succeeded',
          }),
          created_at: new Date(Date.parse(now) - 120_000).toISOString(),
        },
        {
          id: `${workspaceId}-access-slack`,
          workspace_id: workspaceId,
          actor_user_id: null,
          action: 'access_request.slack.failed',
          subject_type: 'access_request',
          subject_id: requestDetail.access_request_id,
          detail: JSON.stringify({
            ...requestDetail,
            recipient_id: userId,
            recipient_email: auditUser.email,
            notification_channel: 'slack',
            delivery_outcome: 'failed',
          }),
          created_at: new Date(Date.parse(now) - 60_000).toISOString(),
        },
        {
          id: `${workspaceId}-access-approved`,
          workspace_id: workspaceId,
          actor_user_id: userId,
          action: 'access_request.approved',
          subject_type: 'access_request',
          subject_id: requestDetail.access_request_id,
          detail: JSON.stringify({
            ...requestDetail,
            actor_id: userId,
            actor_name: auditUser.name,
            actor_email: auditUser.email,
            resolution_scope: 'project',
            decision_status: 'approved',
          }),
          created_at: now,
        },
      ])
      .onConflict(resetFixtureAuditEvent)
      .execute()
  }

  if (scenario === 'settings/with-bots')
    await seedSettingsBots(
      db,
      await scenarioOwnerActor(db, workspaceId, userId),
      now,
    )

  if (scenario.startsWith('settings-external-access/'))
    await seedExternalAccessFixture(db, scenario, workspaceId, userId, now)
  if (scenario === 'settings-integrations/slack-disconnected') {
    await db
      .deleteFrom('slack_workspaces')
      .where('workspace_id', '=', workspaceId)
      .execute()
  }
  if (
    scenario === 'settings-integrations/slack-connected' ||
    scenario === 'settings-integrations/slack-reauthorization'
  ) {
    const connection = {
      id: `${workspaceId}-slack`,
      team_id: `team-${workspaceId}`,
      team_name: 'Artifact Share Dev',
      bot_user_id: `bot-${workspaceId}`,
      bot_token: 'dev-screen-fixture',
      bot_scopes:
        scenario === 'settings-integrations/slack-connected'
          ? 'chat:write,links:read,links:write,users:read,users:read.email'
          : null,
      installed_by_user_id: userId,
      installed_at: now,
      workspace_id: workspaceId,
    }
    await db
      .insertInto('slack_workspaces')
      .values(connection)
      .onConflict((oc) => oc.column('id').doUpdateSet(connection))
      .execute()
  }

  if (scenario === 'settings-tokens/created-secret')
    await seedCreatedSecretToken(db, userId)

  if (scenario === 'settings-tokens/active-cli')
    await seedActiveCliFixture(db, userId, now)

  if (scenario === 'viewer/access-requests') {
    const requesterId = `${workspaceId}-requester`
    await db
      .insertInto('users')
      .values({
        id: requesterId,
        email: 'yamada@example.com',
        email_verified: 1,
        name: '山田 太郎',
        image: null,
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    const shareableId = devShareableId(`${workspaceId}-file-1`)
    await db
      .insertInto('access_requests')
      .values({
        id: 'dev-screen-access-request',
        shareable_id: shareableId,
        requester_user_id: requesterId,
        handler_user_id: userId,
        status: 'pending',
        resolved_by_user_id: null,
        resolution_scope: null,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  if (scenario === 'viewer/link-suspended') {
    // An operator paused the first link: the anonymous host shows the paused
    // page and the owner sees the banner with the reason and the appeal.
    await db
      .updateTable('shareables')
      .set({
        link_suspended_at: new Date(Date.parse(now) - 3_600_000).toISOString(),
        link_suspended_reason:
          'A visitor reported a sign-in form that imitates another service.',
      })
      .where('id', '=', devShareableId(`${workspaceId}-${userId}-file-1`))
      .execute()
  }

  return { containerId, containerKind: needsProject ? 'project' : 'inbox' }
}

async function seedFeedEvents(
  db: Kysely<DB>,
  {
    workspaceId,
    shareableId,
    ownerUserId,
    index,
    now,
    shareableCreatedAt,
  }: {
    workspaceId: string
    shareableId: string
    ownerUserId: string
    index: number
    now: string
    shareableCreatedAt: string
  },
) {
  const viewerId = `${workspaceId}-viewer`
  await db
    .insertInto('users')
    .values({
      id: viewerId,
      email: `dev-viewer+${workspaceId}@artifactshare.local`,
      email_verified: 1,
      name: '長谷川 未来',
      image: null,
      created_at: now,
      updated_at: now,
      workspace_id: workspaceId,
      locale: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  const at = (minutesAgo: number) =>
    new Date(Date.parse(now) - minutesAgo * 60_000).toISOString()
  const events: {
    id: string
    type:
      | 'artifact_created'
      | 'artifact_viewed'
      | 'comment_posted'
      | 'version_published'
    actorUserId: string | null
    subjectId: string | null
    createdAt: string
  }[] =
    index === 2
      ? []
      : [
          {
            id: `${shareableId}-ev-view-1`,
            type: 'artifact_viewed',
            actorUserId: viewerId,
            subjectId: null,
            createdAt: at(30 + index * 90),
          },
          {
            id: `${shareableId}-ev-view-2`,
            type: 'artifact_viewed',
            actorUserId: null,
            subjectId: null,
            createdAt: at(45 + index * 90),
          },
        ]
  // Remove rows emitted by the earlier fixture shape when upgrading an existing
  // local scenario workspace; stable-anchor reseeds do not rely on this cleanup.
  if (index === 2) {
    const createdVersionId = `${shareableId}-created-version`
    await db
      .insertInto('versions')
      .values({
        id: createdVersionId,
        shareable_id: shareableId,
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: '/index.md',
        r2_key: `dev-screen/${createdVersionId}`,
        size_bytes: 1,
        sha256: createdVersionId,
        created_by_id: ownerUserId,
        created_at: shareableCreatedAt,
        published_at: shareableCreatedAt,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    events.push({
      id: `${shareableId}-ev-created`,
      type: 'artifact_created',
      actorUserId: ownerUserId,
      subjectId: createdVersionId,
      createdAt: shareableCreatedAt,
    })
  }
  if (index === 2) {
    await db
      .deleteFrom('events')
      .where('id', 'in', [
        `${shareableId}-ev-view-1`,
        `${shareableId}-ev-view-2`,
      ])
      .execute()
  } else if (index === 0) {
    await db
      .deleteFrom('events')
      .where('id', '=', `${shareableId}-ev-created`)
      .execute()
    await db
      .deleteFrom('versions')
      .where('id', '=', `${shareableId}-created-version`)
      .execute()
  }
  if (index === 0) {
    await db
      .insertInto('versions')
      .values({
        id: `${shareableId}-v1`,
        shareable_id: shareableId,
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: `dev-screen/${shareableId}`,
        size_bytes: 1,
        sha256: shareableId,
        created_by_id: ownerUserId,
        created_at: at(120),
        published_at: at(120),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('comment_threads')
      .values({
        id: `${shareableId}-thread`,
        shareable_id: shareableId,
        status: 'open',
        created_by_id: viewerId,
        created_at: at(20),
        updated_at: at(20),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    // Three same-day comments by one viewer keep the feed's comment bundle reproducible.
    await db
      .insertInto('comment_messages')
      .values({
        id: `${shareableId}-message`,
        thread_id: `${shareableId}-thread`,
        body: '数字の推移が分かりやすいです。第 3 四半期の見込みも足せますか？',
        agent: null,
        created_by_id: viewerId,
        created_at: at(20),
        updated_at: at(20),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('comment_messages')
      .values([
        {
          id: `${shareableId}-message-2`,
          thread_id: `${shareableId}-thread`,
          body: '前四半期との比較も見やすいです。注釈をもう少し補足できますか？',
          agent: null,
          created_by_id: viewerId,
          created_at: at(15),
          updated_at: at(15),
        },
        {
          id: `${shareableId}-message-3`,
          thread_id: `${shareableId}-thread`,
          body: '第 3 四半期の見込みを追加しました。これで判断しやすくなりそうです。',
          agent: null,
          created_by_id: viewerId,
          created_at: at(10),
          updated_at: at(10),
        },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    events.push(
      {
        id: `${shareableId}-ev-version`,
        type: 'version_published',
        actorUserId: ownerUserId,
        subjectId: `${shareableId}-v1`,
        createdAt: at(120),
      },
      {
        id: `${shareableId}-ev-comment`,
        type: 'comment_posted',
        actorUserId: viewerId,
        subjectId: `${shareableId}-message`,
        createdAt: at(20),
      },
      {
        id: `${shareableId}-ev-comment-2`,
        type: 'comment_posted',
        actorUserId: viewerId,
        subjectId: `${shareableId}-message-2`,
        createdAt: at(15),
      },
      {
        id: `${shareableId}-ev-comment-3`,
        type: 'comment_posted',
        actorUserId: viewerId,
        subjectId: `${shareableId}-message-3`,
        createdAt: at(10),
      },
    )
    await seedViewedVersionRange(db, {
      workspaceId,
      viewerUserId: ownerUserId,
      now,
    })
  }
  await db
    .updateTable('shareables')
    .set({
      view_count: events.filter((e) => e.type === 'artifact_viewed').length,
    })
    .where('id', '=', shareableId)
    .execute()
  await db
    .insertInto('events')
    .values(
      events.map((event) => ({
        id: event.id,
        workspace_id: workspaceId,
        type: event.type,
        shareable_id: shareableId,
        actor_user_id: event.actorUserId,
        subject_id: event.subjectId,
        created_at: event.createdAt,
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}

async function seedViewedVersionRange(
  db: Kysely<DB>,
  {
    workspaceId,
    viewerUserId,
    now,
  }: {
    workspaceId: string
    viewerUserId: string
    now: string
  },
) {
  const ownerId = `${workspaceId}-version-owner`
  const shareableId = devShareableId(`${workspaceId}-viewed-version-range`)
  const at = (minutesAgo: number) =>
    new Date(Date.parse(now) - minutesAgo * 60_000).toISOString()
  await db
    .insertInto('users')
    .values({
      id: ownerId,
      email: `dev-version-owner+${workspaceId}@artifactshare.local`,
      email_verified: 1,
      name: 'Alice',
      image: null,
      created_at: now,
      updated_at: now,
      workspace_id: workspaceId,
      locale: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: `${ownerId}-container`,
      workspace_id: workspaceId,
      kind: 'inbox',
      owner_user_id: ownerId,
      created_by_id: ownerId,
      name: INBOX_CONTAINER_NAME,
      description: null,
      base_visibility: 'workspace',
      archived_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: shareableId,
      workspace_id: workspaceId,
      owner_user_id: ownerId,
      slug: null,
      name: 'Research summary.html',
      derived_title: 'Research summary',
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'workspace',
      current_version_id: null,
      container_id: `${ownerId}-container`,
      created_at: at(180),
      updated_at: at(60),
      last_accessed_at: at(60),
      link_expires_at: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('shareable_viewer_recency')
    .values({
      shareable_id: shareableId,
      viewer_user_id: viewerUserId,
      first_viewed_at: at(150),
      last_viewed_at: at(150),
    })
    .onConflict((oc) =>
      oc.columns(['shareable_id', 'viewer_user_id']).doNothing(),
    )
    .execute()
  await db
    .insertInto('versions')
    .values(
      [90, 60].map((minutesAgo, index) => ({
        id: `${shareableId}-v${index + 1}`,
        shareable_id: shareableId,
        artifact_kind: 'html_page' as const,
        status: 'published' as const,
        entrypoint_path: '/index.html',
        r2_key: `dev-screen/${shareableId}/v${index + 1}`,
        size_bytes: 1,
        sha256: `${shareableId}-v${index + 1}`,
        created_by_id: ownerId,
        created_at: at(minutesAgo),
        published_at: at(minutesAgo),
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .updateTable('shareables')
    .set({ current_version_id: `${shareableId}-v2` })
    .where('id', '=', shareableId)
    .execute()
  await db
    .insertInto('events')
    .values(
      [90, 60].map((minutesAgo, index) => ({
        id: `${shareableId}-ev-v${index + 1}`,
        workspace_id: workspaceId,
        type: 'version_published' as const,
        shareable_id: shareableId,
        actor_user_id: ownerId,
        subject_id: `${shareableId}-v${index + 1}`,
        created_at: at(minutesAgo),
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}
