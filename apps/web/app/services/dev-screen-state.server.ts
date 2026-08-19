import scenarioIds from '../../../../scripts/screen-scenarios.json'
import type { Kysely } from 'kysely'
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
import { INBOX_CONTAINER_NAME } from './projects.server'

const SCREEN_SCENARIO_IDS = scenarioIds as readonly string[]
const screenScenarioAllowlist = new Set(SCREEN_SCENARIO_IDS)
// These scenarios require a header because browser navigations cannot attach it.
// Screens whose representative state comes from a display-only fixture keyed by
// the capture header. A browser navigation cannot set it, so /dev/sign-in must
// not offer them: the state would be seeded but never shown.
export const HEADER_DEPENDENT_SCREEN_SCENARIOS: readonly string[] = [
  'settings-tokens/created-secret',
  'settings-billing/subscribed',
  'viewer/revisit-context',
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

/** Stores the deterministic viewer bodies owned by the recent task scenario. */
export async function seedDevScreenArtifactBodies(
  bucket: Pick<R2Bucket, 'put'> | undefined,
  scenario: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!bucket) return
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
  if (scenario !== 'recent/content-rich') return
  const bodies = [
    {
      key: `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-1`)}-${RECENT_CONTENT_RICH_BODIES.quarterlyReport.version}`,
      html: RECENT_CONTENT_RICH_BODIES.quarterlyReport.html,
    },
    ...RECENT_CONTENT_RICH_BODIES.archivedReview21.map(({ version, html }) => ({
      key: `dev-screen/${devShareableId(`${workspaceId}-${userId}-file-21`)}-${version}`,
      html,
    })),
  ]
  await Promise.all(
    bodies.map(({ key, html }) =>
      bucket.put(key, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      }),
    ),
  )
}

/** Creates the isolated workspace anchor used by screen-capture scenarios. */
export async function ensureDevScreenState(
  db: Kysely<DB>,
  scenario: string,
  now: string,
  plan: 'free' | 'plus' | 'team',
): Promise<{ workspaceId: string }> {
  if (!isScreenScenario(scenario))
    throw new Error(`Unknown screen scenario: ${scenario}`)
  const workspaceId = scenarioWorkspaceId(plan, scenario)
  const existing = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  if (!existing) {
    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        hd: null,
        name: `Screen state: ${scenario}`,
        created_at: now,
        plan,
        storage_quota_bytes: plan === 'team' ? 100_000_000_000 : 5_000_000_000,
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        link_expiry_default_days: null,
        link_expiry_max_days: null,
      })
      .execute()
  }
  if (scenario === 'settings-billing/subscribed') {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'team',
        stripe_subscription_id: `${workspaceId}-subscribed`,
        stripe_subscription_status: 'active',
      })
      .where('id', '=', workspaceId)
      .execute()
  }
  if (scenario === 'settings-usage/near-limit') {
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 90_000_000_000 })
      .where('id', '=', workspaceId)
      .execute()
  }
  return { workspaceId }
}

export async function seedDevScreenState(
  db: Kysely<DB>,
  scenario: string,
  workspaceId: string,
  userId: string,
  now: string,
): Promise<{ containerId: string | null; containerKind: 'inbox' | 'project' }> {
  const seedsRepresentativeFeed =
    scenario === 'home/content-rich' ||
    scenario === 'home/updates-menu-open' ||
    scenario === 'project-detail/with-files'
  const needsProject =
    scenario.startsWith('project-detail/') ||
    scenario === 'projects-archived/with-archived-project'
  const containerId = needsProject
    ? `${workspaceId}-container`
    : `${workspaceId}-${userId}-container`
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
      base_visibility: 'private',
      archived_at:
        scenario === 'projects-archived/with-archived-project' ? now : null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
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

  if (scenario === 'home/empty' || scenario === 'home/first-file') {
    await db
      .deleteFrom('shareables')
      .where('workspace_id', '=', workspaceId)
      .execute()
  }

  if (
    scenario === 'home/content-rich' ||
    scenario === 'home/updates-menu-open' ||
    scenario === 'home/first-file' ||
    scenario === 'recent/content-rich' ||
    scenario === 'project-detail/with-files' ||
    scenario === 'project-detail/with-pins'
  ) {
    const representativeNames =
      scenario === 'home/first-file'
        ? ['First file.html']
        : ['Quarterly report.html', 'Design handoff.html', 'Launch notes.md']
    const names =
      scenario === 'recent/content-rich'
        ? [
            ...representativeNames,
            ...Array.from(
              { length: 20 },
              (_, index) => `Archived review ${index + 4}.html`,
            ),
          ]
        : representativeNames
    const firstViewedAt = new Date(
      Date.parse(now) - 2 * 3_600_000,
    ).toISOString()
    const commentAt = new Date(Date.parse(now) - 3_600_000).toISOString()
    await Promise.all(
      names.map(async (name, index) => {
        const shareableId = devShareableId(
          needsProject
            ? `${workspaceId}-file-${index + 1}`
            : `${workspaceId}-${userId}-file-${index + 1}`,
        )
        const minutesAgo = seedsRepresentativeFeed
          ? index === 2
            ? 5
            : index === 0
              ? 180
              : index * 26 * 60
          : index * 26 * 60
        const timestamp = new Date(
          Date.parse(representativeFeedAnchor) - minutesAgo * 60_000,
        ).toISOString()
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
            artifact_kind: name.endsWith('.md') ? 'markdown_page' : 'html_page',
            visibility: needsProject ? 'project' : 'private',
            current_version_id: null,
            container_id: containerId,
            created_at: timestamp,
            updated_at: timestamp,
            last_accessed_at: timestamp,
            link_expires_at: null,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute()
        if (scenario === 'recent/content-rich') {
          const versionNames =
            index === 20
              ? (['v1', 'v2'] as const)
              : index === 0 || index === 19
                ? (['v1'] as const)
                : []
          if (versionNames.length > 0) {
            for (const versionName of versionNames) {
              const versionId = `${shareableId}-${versionName}`
              const isUpdatedVersion = index === 20 && versionName === 'v2'
              const versionTimestamp = isUpdatedVersion
                ? new Date(Date.parse(now) - 30 * 60_000).toISOString()
                : timestamp
              const body = recentContentRichBody(index, versionName)
              const sizeBytes = body
                ? new TextEncoder().encode(body).byteLength
                : 1
              await db
                .insertInto('versions')
                .values({
                  id: versionId,
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
          if (index === 0) {
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
            await db
              .updateTable('shareable_viewer_recency')
              .set({ comment_seen_through_at: latestCommentAt })
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
        if (scenario === 'project-detail/with-pins' && index < 2) {
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
          link_expiry_default_days: null,
          link_expiry_max_days: null,
        })
        .onConflict((oc) => oc.doNothing())
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
        .onConflict((oc) => oc.column('id').doNothing())
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
          updated_at: index <= 2 ? updateAt : openingAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      await db
        .insertInto('comment_messages')
        .values({
          id: `${threadId}-opening`,
          thread_id: threadId,
          body: `確認ポイント ${index}`,
          agent: null,
          created_by_id: userId,
          created_at: openingAt,
          updated_at: openingAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      if (index <= 2) {
        await db
          .insertInto('comment_messages')
          .values({
            id: `${threadId}-reply`,
            thread_id: threadId,
            body: index === 1 ? '反映しました。' : '追加の確認事項があります。',
            agent: null,
            created_by_id: ownerId,
            created_at: updateAt,
            updated_at: updateAt,
          })
          .onConflict((oc) => oc.column('id').doNothing())
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
        link_expiry_default_days: null,
        link_expiry_max_days: null,
      })
      .onConflict((oc) => oc.doNothing())
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
    for (const [index, action] of [
      'plan.change',
      'artifact.delete',
      'admin.grant',
    ].entries()) {
      await db
        .insertInto('audit_events')
        .values({
          id: `${workspaceId}-event-${index + 1}`,
          workspace_id: workspaceId,
          actor_user_id: userId,
          action,
          subject_type: index === 0 ? 'workspace' : 'user',
          subject_id: index === 0 ? workspaceId : userId,
          detail:
            action === 'plan.change'
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
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
  }

  if (scenario === 'settings/with-bots') {
    const projectId = `${workspaceId}-bot-project`
    const projectName = 'Nightly reports'
    await db
      .insertInto('artifact_containers')
      .values({
        id: projectId,
        workspace_id: workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: userId,
        name: projectName,
        description: 'Destination project for bot uploads',
        base_visibility: 'workspace',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    const bots = [
      {
        key: 'active',
        name: 'Nightly report bot',
        stoppedAt: null,
        credentialExpiresAt: '2099-01-01T00:00:00.000Z',
        credentialRevokedAt: null,
        authorityStatus: 'active' as const,
        lastUsedAt: new Date(Date.parse(now) - 30 * 60_000).toISOString(),
      },
      {
        key: 'expired',
        name: 'Metrics sync bot',
        stoppedAt: null,
        credentialExpiresAt: new Date(
          Date.parse(now) - 86_400_000,
        ).toISOString(),
        credentialRevokedAt: null,
        authorityStatus: 'active' as const,
        lastUsedAt: new Date(Date.parse(now) - 10 * 86_400_000).toISOString(),
      },
      {
        key: 'stopped',
        name: 'Retired handoff bot',
        stoppedAt: new Date(Date.parse(now) - 3 * 86_400_000).toISOString(),
        credentialExpiresAt: '2099-01-01T00:00:00.000Z',
        credentialRevokedAt: new Date(
          Date.parse(now) - 3 * 86_400_000,
        ).toISOString(),
        authorityStatus: 'revoked' as const,
        lastUsedAt: new Date(Date.parse(now) - 4 * 86_400_000).toISOString(),
      },
      {
        key: 'unused-stopped',
        name: 'Setup failed bot',
        stoppedAt: new Date(Date.parse(now) - 60 * 60_000).toISOString(),
        credentialExpiresAt: '2099-01-01T00:00:00.000Z',
        credentialRevokedAt: new Date(
          Date.parse(now) - 60 * 60_000,
        ).toISOString(),
        authorityStatus: 'revoked' as const,
        lastUsedAt: null,
      },
    ]
    for (const [index, bot] of bots.entries()) {
      const botUserId = `${workspaceId}-bot-${bot.key}`
      const familyId = `${botUserId}-family`
      const createdAt = new Date(
        Date.parse(now) - (index + 1) * 60_000,
      ).toISOString()
      await db
        .insertInto('users')
        .values({
          id: botUserId,
          email: `bot-${bot.key}-${workspaceId}@bots.artifactshare.invalid`,
          email_verified: 1,
          name: bot.name,
          image: null,
          created_at: createdAt,
          updated_at: createdAt,
          workspace_id: workspaceId,
          locale: null,
          kind: 'bot',
          bot_stopped_at: bot.stoppedAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: workspaceId,
          user_id: botUserId,
          role: 'member',
          status: 'active',
          first_contributed_at: null,
          last_contributed_at: null,
          removed_at: null,
          removed_by: null,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      await db
        .insertInto('agent_profiles')
        .values({
          id: `${botUserId}-profile`,
          user_id: botUserId,
          workspace_id: workspaceId,
          created_at: createdAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      await db
        .insertInto('cli_family_authorities')
        .values({
          family_id: familyId,
          user_id: botUserId,
          preset: 'agent',
          workspace_id: workspaceId,
          project_id: projectId,
          project_name_snapshot: projectName,
          agent_profile_id: `${botUserId}-profile`,
          approved_at: createdAt,
          device_name: null,
          status: bot.authorityStatus,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflict((oc) => oc.column('family_id').doNothing())
        .execute()
      await db
        .insertInto('cli_refresh_credentials')
        .values({
          id: familyId,
          user_id: botUserId,
          token_hash: `${familyId}-hash`,
          expires_at: bot.credentialExpiresAt,
          revoked_at: bot.credentialRevokedAt,
          created_at: createdAt,
          last_used_at: bot.lastUsedAt,
          family_id: familyId,
          replaced_by_id: null,
          rotation_request_hash: null,
          rotation_retry_until: null,
          rotation_session_id: null,
          device_name: null,
          device_id: null,
          revocation_batch_id: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
  }

  if (scenario === 'settings-integrations/slack-connected') {
    await db
      .insertInto('slack_workspaces')
      .values({
        id: `${workspaceId}-slack`,
        team_id: `team-${workspaceId}`,
        team_name: 'Artifact Share Dev',
        bot_user_id: `bot-${workspaceId}`,
        bot_token: 'dev-screen-fixture',
        installed_by_user_id: userId,
        installed_at: now,
        workspace_id: workspaceId,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  if (scenario === 'settings-tokens/created-secret') {
    await db
      .insertInto('api_tokens')
      .values({
        id: `${workspaceId}-${userId}-token`,
        user_id: userId,
        name: 'CLI deploy',
        token_hash: `${workspaceId}-${userId}-token`,
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  if (scenario === 'settings-tokens/active-cli') {
    await db
      .insertInto('cli_refresh_credentials')
      .values({
        id: `${workspaceId}-${userId}-cli-refresh`,
        user_id: userId,
        token_hash: `${workspaceId}-${userId}-cli-refresh-hash`,
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null,
        created_at: now,
        last_used_at: now,
        family_id: `${workspaceId}-${userId}-cli-family`,
        replaced_by_id: null,
        rotation_request_hash: null,
        rotation_retry_until: null,
        rotation_session_id: null,
        device_name: 'Artifact Share CLI on darwin arm64 (default, a1b2c3d4)',
        device_id: 'a1b2c3d4-example-device-id',
        revocation_batch_id: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
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
