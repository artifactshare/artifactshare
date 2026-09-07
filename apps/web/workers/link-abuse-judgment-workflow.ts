import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import { extractLinkAbuseContentFromHtml } from '../app/services/link-abuse-judgment/extract-rewriter'
import { linkAbuseJudgmentProvider } from '../app/services/link-abuse-judgment/providers'
import { linkOpsUrl, signLinkOpsToken } from '../app/lib/link-ops-token'

type ShareableContext = {
  shareableId: string
  workspaceId: string
  r2Key: string
  ownerCreatedAt: string
  workspacePlan: string
}

type SkipReason =
  | 'shareable_not_found'
  | 'visibility_not_link'
  | 'visibility_changed'
  | 'version_not_published'
  | 'entrypoint_missing'

export type LinkAbuseJudgmentWorkflowResult =
  | {
      kind: 'judged'
      judgmentId: string
      risk: 'low' | 'medium' | 'high'
    }
  | { kind: 'skipped'; reason: SkipReason }

export class LinkAbuseJudgmentWorkflow extends WorkflowEntrypoint<
  Cloudflare.Env,
  LinkAbuseJudgmentWorkflowPayload
> {
  async run(
    event: Readonly<WorkflowEvent<LinkAbuseJudgmentWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<LinkAbuseJudgmentWorkflowResult> {
    const loaded = await step.do('load shareable context', async () => {
      const row = await this.env.DB.prepare(
        `SELECT
           s.id AS shareable_id,
           s.workspace_id,
           v.r2_key,
           u.created_at AS owner_created_at,
           w.plan AS workspace_plan,
           s.visibility,
           v.status AS version_status
         FROM shareables s
         LEFT JOIN versions v ON v.id = s.current_version_id
         JOIN users u ON u.id = s.owner_user_id
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.id = ?`,
      )
        .bind(event.payload.shareableId)
        .first<{
          shareable_id: string
          workspace_id: string
          r2_key: string | null
          owner_created_at: string
          workspace_plan: string
          visibility: string
          version_status: string | null
        }>()
      if (!row) return { skip: 'shareable_not_found' as const }
      if (row.visibility !== 'link') {
        return { skip: 'visibility_not_link' as const }
      }
      if (row.version_status !== 'published' || !row.r2_key) {
        return { skip: 'version_not_published' as const }
      }
      return {
        context: {
          shareableId: row.shareable_id,
          workspaceId: row.workspace_id,
          r2Key: row.r2_key,
          ownerCreatedAt: row.owner_created_at,
          workspacePlan: row.workspace_plan,
        } satisfies ShareableContext,
      }
    })
    if ('skip' in loaded && loaded.skip) {
      return await this.skip(step, event.payload, loaded.skip)
    }
    const context = loaded.context

    const extracted = await step.do('extract entrypoint content', async () => {
      const object = await this.env.BUCKET.get(context.r2Key)
      return object
        ? await extractLinkAbuseContentFromHtml(await object.text())
        : null
    })
    if (!extracted) {
      return await this.skip(step, event.payload, 'entrypoint_missing')
    }

    const visibility = await step.do('re-check link visibility', async () => {
      const row = await this.env.DB.prepare(
        'SELECT visibility FROM shareables WHERE id = ?',
      )
        .bind(context.shareableId)
        .first<{ visibility: string }>()
      return row?.visibility ?? null
    })
    if (visibility !== 'link') {
      return await this.skip(step, event.payload, 'visibility_changed')
    }

    const judgment = await step.do('judge link abuse risk', async () => {
      const ownerCreatedAt = Date.parse(context.ownerCreatedAt)
      const accountAgeDays = Number.isFinite(ownerCreatedAt)
        ? Math.max(
            0,
            Math.floor(
              (event.timestamp.getTime() - ownerCreatedAt) / 86_400_000,
            ),
          )
        : 0
      return await linkAbuseJudgmentProvider(this.env).judge({
        text: extracted.text,
        externalDomains: extracted.externalDomains,
        accountAgeDays,
        workspacePlan: context.workspacePlan,
        trigger: event.payload.trigger,
        detail: event.payload.detail,
      })
    })

    return await step.do('record and announce judgment', async () => {
      const judgmentId = event.instanceId
      const createdAt = event.timestamp.toISOString()
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO link_abuse_judgments (
           id, shareable_id, trigger, risk, reason, impersonated_brand,
           external_targets, provider, model, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          judgmentId,
          context.shareableId,
          event.payload.trigger,
          judgment.risk,
          judgment.reason,
          judgment.impersonatedBrand,
          JSON.stringify(judgment.externalTargets),
          judgment.provider,
          judgment.model,
          createdAt,
        )
        .run()

      // The operator page link is signed so a person can pause or resume
      // from Slack; the judgment itself never changes the link.
      const opsSecret = this.env.LINK_OPS_ACTION_SECRET
      const actionUrl = opsSecret
        ? linkOpsUrl(
            'https://artifactshare.com',
            context.shareableId,
            await signLinkOpsToken(
              { shareableId: context.shareableId, judgmentId },
              opsSecret,
            ),
          )
        : null
      console.warn('artifactshare_link_abuse_judgment', {
        shareableId: context.shareableId,
        workspaceId: context.workspaceId,
        trigger: event.payload.trigger,
        risk: judgment.risk,
        reason: judgment.reason,
        impersonatedBrand: judgment.impersonatedBrand,
        externalTargets: judgment.externalTargets,
        manageUrl: `https://artifactshare.com/a/${context.shareableId}`,
        actionUrl,
      })
      return { kind: 'judged' as const, judgmentId, risk: judgment.risk }
    })
  }

  private async skip(
    step: WorkflowStep,
    payload: LinkAbuseJudgmentWorkflowPayload,
    reason: SkipReason,
  ): Promise<LinkAbuseJudgmentWorkflowResult> {
    if (payload.expiresAt) {
      await step.do('release judgment gate', async () => {
        // Shorten the gate this instance acquired to at most one minute from
        // now; never extend it, and never touch a gate a newer trigger refreshed.
        const releaseAt = new Date(Date.now() + 60_000).toISOString()
        await this.env.DB.prepare(
          `UPDATE link_abuse_judgment_gates
           SET expires_at = MIN(expires_at, ?)
           WHERE shareable_id = ? AND kind = ? AND expires_at = ?`,
        )
          .bind(releaseAt, payload.shareableId, payload.kind, payload.expiresAt)
          .run()
      })
    }
    console.warn('link_abuse_judgment_skipped', {
      shareableId: payload.shareableId,
      reason,
    })
    return { kind: 'skipped', reason }
  }
}
