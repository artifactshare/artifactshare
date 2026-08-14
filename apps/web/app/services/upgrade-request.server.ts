import type { Kysely } from 'kysely'

import { isValidGrantEmail } from '~/lib/grant-emails'
import type { DB } from '~/types/db'

import { requireWorkspaceBillingOwner } from './team-management.server'

export type UpgradeLimitType = 'storage' | 'projects'
export type UpgradePlan = 'free' | 'plus' | 'team'
export type UpgradeLocale = 'en' | 'ja'

type UpgradeRequestBase = {
  limit_type: UpgradeLimitType
  current_plan: 'free' | 'plus'
  recommended_plan: 'plus' | 'team'
}

export type UpgradeRequest = UpgradeRequestBase &
  (
    | {
        kind: 'contact'
        upgrade_url: string
        owner: { name: string | null; email: string }
        request_message: string
      }
    | {
        kind: 'billing'
        upgrade_url: string
        action_message: string
      }
    | { kind: 'support'; support_url: string }
  )

type BuildUpgradeRequestInput = {
  db: Kysely<DB>
  actor: { id: string; workspaceId: string; kind: 'human' | 'bot' }
  billingWorkspaceId: string
  limitType: UpgradeLimitType
  observedPlan: UpgradePlan
  locale: UpgradeLocale
  appBaseUrl: string
}

const SUPPORT_SUBJECTS: Record<UpgradeLimitType, string> = {
  storage: 'Artifact Share upgrade help: storage',
  projects: 'Artifact Share upgrade help: projects',
}

function recommendation(
  limitType: UpgradeLimitType,
  currentPlan: UpgradePlan,
): { current: 'free' | 'plus'; recommended: 'plus' | 'team' } | null {
  if (limitType === 'storage' && currentPlan === 'free') {
    return { current: 'free', recommended: 'plus' }
  }
  if (limitType === 'projects' && currentPlan === 'free') {
    return { current: 'free', recommended: 'plus' }
  }
  if (limitType === 'projects' && currentPlan === 'plus') {
    return { current: 'plus', recommended: 'team' }
  }
  return null
}

function billingUrl(
  appBaseUrl: string,
  limitType: UpgradeLimitType,
  recommendedPlan: 'plus' | 'team',
): string | null {
  try {
    const base = new URL(appBaseUrl)
    if (base.protocol !== 'https:' && base.hostname !== 'localhost') return null
    const url = new URL('/settings/billing', base.origin)
    url.searchParams.set('plan', recommendedPlan)
    if (limitType === 'projects') {
      url.searchParams.set('reason', 'project_limit')
    }
    return url.toString()
  } catch {
    return null
  }
}

function supportUrl(limitType: UpgradeLimitType): string {
  return `mailto:support@artifactshare.com?subject=${encodeURIComponent(SUPPORT_SUBJECTS[limitType])}`
}

function planName(plan: UpgradePlan): string {
  return plan[0]!.toUpperCase() + plan.slice(1)
}

function limitName(locale: UpgradeLocale, limitType: UpgradeLimitType): string {
  if (locale === 'ja') {
    return limitType === 'storage' ? '保存容量' : 'アクティブプロジェクト数'
  }
  return limitType === 'storage' ? 'storage capacity' : 'active project count'
}

function remedy(locale: UpgradeLocale, limitType: UpgradeLimitType): string {
  if (locale === 'ja') {
    return limitType === 'storage'
      ? '不要なファイルを削除するか、アップロードを小さくする'
      : '既存のプロジェクトをアーカイブする'
  }
  return limitType === 'storage'
    ? 'free storage or reduce the upload size'
    : 'archive an existing project'
}

function requestMessage(args: {
  locale: UpgradeLocale
  limitType: UpgradeLimitType
  currentPlan: 'free' | 'plus'
  recommendedPlan: 'plus' | 'team'
  url: string
  owner: { name: string | null; email: string }
}): string {
  const current = planName(args.currentPlan)
  const recommended = planName(args.recommendedPlan)
  const limit = limitName(args.locale, args.limitType)
  const freeRemedy = remedy(args.locale, args.limitType)
  if (args.locale === 'ja') {
    const owner = args.owner.name
      ? `${args.owner.name} さん (${args.owner.email})`
      : args.owner.email
    return `${owner}、${current} で ${limit} の制限に達しました。${recommended} への変更、または${freeRemedy}対応をお願いします: ${args.url}`
  }
  const owner = args.owner.name
    ? `${args.owner.name} (${args.owner.email})`
    : args.owner.email
  return `${owner}, we reached the ${limit} limit on ${current}. Please move the workspace to ${recommended}, or ${freeRemedy}. Open: ${args.url}`
}

function actionMessage(args: {
  locale: UpgradeLocale
  limitType: UpgradeLimitType
  currentPlan: 'free' | 'plus'
  recommendedPlan: 'plus' | 'team'
  url: string
}): string {
  const current = planName(args.currentPlan)
  const recommended = planName(args.recommendedPlan)
  const limit = limitName(args.locale, args.limitType)
  const freeRemedy = remedy(args.locale, args.limitType)
  if (args.locale === 'ja') {
    return `${current} で ${limit} の制限に達しました。${recommended} へ変更するか、${freeRemedy}対応をしてください: ${args.url}`
  }
  return `You reached the ${limit} limit on ${current}. Move the workspace to ${recommended}, or ${freeRemedy}. Open: ${args.url}`
}

async function loadOwnerContact(db: Kysely<DB>, workspaceId: string) {
  const owner = await db
    .selectFrom('workspace_members')
    .leftJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'users.name as name',
      'users.email as email',
      'users.kind as kind',
    ])
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.role', '=', 'owner')
    .where('workspace_members.status', '=', 'active')
    .executeTakeFirst()
  if (owner?.kind !== 'human') return null
  const email = owner.email?.trim() ?? ''
  if (!isValidGrantEmail(email)) return null
  const name = owner.name?.trim() || null
  return { name, email }
}

export async function buildUpgradeRequest(
  input: BuildUpgradeRequestInput,
): Promise<UpgradeRequest | null> {
  try {
    if (input.actor.workspaceId !== input.billingWorkspaceId) return null
    const membership = await input.db
      .selectFrom('workspace_members')
      .select('status')
      .where('workspace_id', '=', input.billingWorkspaceId)
      .where('user_id', '=', input.actor.id)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!membership) return null

    const mapped = recommendation(input.limitType, input.observedPlan)
    if (!mapped) return null
    const base: UpgradeRequestBase = {
      limit_type: input.limitType,
      current_plan: mapped.current,
      recommended_plan: mapped.recommended,
    }

    if (input.actor.kind === 'human') {
      const owner = await requireWorkspaceBillingOwner(input.db, input.actor)
      if (owner.kind === 'ok') {
        const url = billingUrl(
          input.appBaseUrl,
          input.limitType,
          mapped.recommended,
        )
        if (!url) {
          return {
            ...base,
            kind: 'support',
            support_url: supportUrl(input.limitType),
          }
        }
        return {
          ...base,
          kind: 'billing',
          upgrade_url: url,
          action_message: actionMessage({
            locale: input.locale,
            limitType: input.limitType,
            currentPlan: mapped.current,
            recommendedPlan: mapped.recommended,
            url,
          }),
        }
      }
    }

    const owner = await loadOwnerContact(input.db, input.billingWorkspaceId)
    if (!owner) {
      return {
        ...base,
        kind: 'support',
        support_url: supportUrl(input.limitType),
      }
    }
    const url = billingUrl(
      input.appBaseUrl,
      input.limitType,
      mapped.recommended,
    )
    if (!url) {
      return {
        ...base,
        kind: 'support',
        support_url: supportUrl(input.limitType),
      }
    }
    return {
      ...base,
      kind: 'contact',
      upgrade_url: url,
      owner,
      request_message: requestMessage({
        locale: input.locale,
        limitType: input.limitType,
        currentPlan: mapped.current,
        recommendedPlan: mapped.recommended,
        url,
        owner,
      }),
    }
  } catch (error) {
    console.error('upgrade_request_enrichment_failed', {
      workspaceId: input.billingWorkspaceId,
      cause: error instanceof Error ? error.message : 'unknown',
    })
    return null
  }
}
