export type LinkAbuseRisk = 'low' | 'medium' | 'high'
export type LinkAbuseTrigger =
  | 'view_spike'
  | 'ad_click'
  | 'publish_burst'
  | 'manual'

export interface LinkAbuseJudgmentInput {
  text: string
  externalDomains: string[]
  accountAgeDays: number
  workspacePlan: string
  trigger: LinkAbuseTrigger
  detail: string
}

export interface LinkAbuseJudgment {
  risk: LinkAbuseRisk
  reason: string
  impersonatedBrand: string | null
  externalTargets: string[]
}

export interface LinkAbuseJudgmentResult extends LinkAbuseJudgment {
  provider: 'workers-ai' | 'anthropic'
  model: string
}

export interface LinkAbuseJudgmentProvider {
  judge(input: LinkAbuseJudgmentInput): Promise<LinkAbuseJudgmentResult>
}
