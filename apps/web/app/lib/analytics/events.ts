// client と Node Admin スクリプトの両方が import する純粋モジュール。window/server を参照しない

export const ANALYTICS_EVENTS = {
  artifactView: 'artifact_view',
  signUpStart: 'sign_up_start',
  signUp: 'sign_up',
  workspaceCreated: 'workspace_created',
  firstArtifactPosted: 'first_artifact_posted',
} as const
export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]
export const ANALYTICS_PARAMS = {
  artifactId: 'artifact_id',
  renderType: 'render_type',
  referrerDomain: 'referrer_domain',
  method: 'method',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmTerm: 'utm_term',
  utmContent: 'utm_content',
  channel: 'channel',
} as const
export type AnalyticsParamKey =
  (typeof ANALYTICS_PARAMS)[keyof typeof ANALYTICS_PARAMS]
export type AnalyticsRenderType = 'html' | 'md' | 'static_site'
export const ANALYTICS_KEY_EVENTS: ReadonlyArray<AnalyticsEventName> = [
  ANALYTICS_EVENTS.signUp,
  ANALYTICS_EVENTS.firstArtifactPosted,
]
// GA4 が web/mobile ストリームで自動 mark する既定キーイベント。逆方向 drift の対象外。
// convert_lead は GA4 に存在しないため入れない。
// Node の .mjs consumer は React source graph に現れないため抑制する。
// react-doctor-disable-next-line deslop/unused-export
export const GA4_DEFAULT_KEY_EVENTS = [
  'purchase',
  'first_open',
  'in_app_purchase',
  'app_store_subscription_convert',
  'app_store_subscription_renew',
  'generate_lead',
  'qualify_lead',
  'disqualify_lead',
  'working_lead',
  'close_convert_lead',
  'close_unconvert_lead',
] as const

// 意図的に custom dimension 化しない ANALYTICS_PARAMS の値 (現状なし)。
// check:analytics-dimensions (Node の .mjs) から import する公開契約。react-doctor
// は .mjs の consumer を辿らないため unused-export を誤検知する → 抑制する。
// react-doctor-disable-next-line deslop/unused-export
export const NON_DIMENSION_PARAMS: readonly string[] = []
export const ANALYTICS_CUSTOM_DIMENSIONS: ReadonlyArray<{
  parameterName: AnalyticsParamKey
  displayName: string
}> = [
  { parameterName: ANALYTICS_PARAMS.artifactId, displayName: 'Artifact ID' },
  { parameterName: ANALYTICS_PARAMS.renderType, displayName: 'Render Type' },
  {
    parameterName: ANALYTICS_PARAMS.referrerDomain,
    displayName: 'Referrer Domain',
  },
  { parameterName: ANALYTICS_PARAMS.method, displayName: 'Method' },
  { parameterName: ANALYTICS_PARAMS.utmSource, displayName: 'UTM Source' },
  { parameterName: ANALYTICS_PARAMS.utmMedium, displayName: 'UTM Medium' },
  { parameterName: ANALYTICS_PARAMS.utmCampaign, displayName: 'UTM Campaign' },
  { parameterName: ANALYTICS_PARAMS.utmTerm, displayName: 'UTM Term' },
  { parameterName: ANALYTICS_PARAMS.utmContent, displayName: 'UTM Content' },
  { parameterName: ANALYTICS_PARAMS.channel, displayName: 'Channel' },
]
// Node の .mjs consumer は React source graph に現れないため抑制する。
// react-doctor-disable-next-line deslop/unused-export
export const ANALYTICS_DATA_RETENTION = {
  eventDataRetention: 'FOURTEEN_MONTHS',
  userDataRetention: 'TWO_MONTHS',
  resetUserDataOnNewActivity: false,
} as const
