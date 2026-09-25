// client と Node Admin スクリプトの両方が import する純粋モジュール。window/server を参照しない

type SameAnalyticsValue<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false
type DuplicateAnalyticsValueKeys<
  Values extends { readonly [Key in string]: string },
> = {
  [Key in keyof Values]: {
    [OtherKey in keyof Values]: OtherKey extends Key
      ? never
      : SameAnalyticsValue<Values[OtherKey], Values[Key]> extends true
        ? OtherKey
        : never
  }[keyof Values]
}[keyof Values]
function defineUniqueAnalyticsValues<
  const Values extends { readonly [Key in string]: string },
>(
  values: Values &
    ([DuplicateAnalyticsValueKeys<Values>] extends [never] ? unknown : never),
): Values {
  return values
}

export const ANALYTICS_EVENTS = defineUniqueAnalyticsValues({
  pageView: 'page_view',
  artifactView: 'artifact_view',
  copyLinkSucceeded: 'copy_link_succeeded',
  copyLinkFailed: 'copy_link_failed',
  signUpStart: 'sign_up_start',
  authCompleted: 'auth_completed',
  artifactReturnedAfterAuth: 'artifact_returned_after_auth',
  signUp: 'sign_up',
  workspaceCreated: 'workspace_created',
  firstArtifactPosted: 'first_artifact_posted',
} as const)
export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]
export type AnalyticsAuthMethod = 'google' | 'microsoft' | 'email'
export const ANALYTICS_PARAMS = defineUniqueAnalyticsValues({
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
  visibility: 'visibility',
  viewerState: 'viewer_state',
  accountState: 'account_state',
} as const)
export type AnalyticsParamKey =
  (typeof ANALYTICS_PARAMS)[keyof typeof ANALYTICS_PARAMS]
export type AnalyticsRenderType = 'html' | 'md' | 'static_site'

export type AnalyticsParamValue = string | number | boolean | undefined
type AnalyticsParamValues = {
  [ANALYTICS_PARAMS.artifactId]: string
  [ANALYTICS_PARAMS.renderType]: AnalyticsRenderType
  [ANALYTICS_PARAMS.referrerDomain]: string
  [ANALYTICS_PARAMS.method]: AnalyticsAuthMethod
  [ANALYTICS_PARAMS.utmSource]: string
  [ANALYTICS_PARAMS.utmMedium]: string
  [ANALYTICS_PARAMS.utmCampaign]: string
  [ANALYTICS_PARAMS.utmTerm]: string
  [ANALYTICS_PARAMS.utmContent]: string
  [ANALYTICS_PARAMS.channel]: 'web' | 'cli' | 'mcp'
  [ANALYTICS_PARAMS.visibility]: 'private' | 'workspace' | 'project' | 'link'
  [ANALYTICS_PARAMS.viewerState]: 'anonymous' | 'authenticated'
  [ANALYTICS_PARAMS.accountState]: 'new' | 'existing'
}
type AnalyticsParamsFor<Keys extends keyof AnalyticsParamValues> = Partial<
  Pick<AnalyticsParamValues, Keys>
>

type AnalyticsArtifactViewParamKey =
  | typeof ANALYTICS_PARAMS.artifactId
  | typeof ANALYTICS_PARAMS.renderType
  | typeof ANALYTICS_PARAMS.referrerDomain
  | typeof ANALYTICS_PARAMS.utmSource
  | typeof ANALYTICS_PARAMS.utmMedium
  | typeof ANALYTICS_PARAMS.utmCampaign
  | typeof ANALYTICS_PARAMS.utmTerm
  | typeof ANALYTICS_PARAMS.utmContent
  | typeof ANALYTICS_PARAMS.visibility
  | typeof ANALYTICS_PARAMS.viewerState

type AnalyticsSignupParamKey =
  | typeof ANALYTICS_PARAMS.method
  | typeof ANALYTICS_PARAMS.artifactId
  | typeof ANALYTICS_PARAMS.referrerDomain
  | typeof ANALYTICS_PARAMS.utmSource
  | typeof ANALYTICS_PARAMS.utmMedium
  | typeof ANALYTICS_PARAMS.utmCampaign
  | typeof ANALYTICS_PARAMS.utmTerm
  | typeof ANALYTICS_PARAMS.utmContent

type AnalyticsAuthParamKey =
  | typeof ANALYTICS_PARAMS.method
  | typeof ANALYTICS_PARAMS.accountState

export type AnalyticsEventParams = {
  [ANALYTICS_EVENTS.pageView]: {
    page_title: string
    page_location: string
  }
  [ANALYTICS_EVENTS.artifactView]: AnalyticsParamsFor<AnalyticsArtifactViewParamKey>
  [ANALYTICS_EVENTS.copyLinkSucceeded]: undefined
  [ANALYTICS_EVENTS.copyLinkFailed]: undefined
  [ANALYTICS_EVENTS.signUpStart]: AnalyticsParamsFor<
    typeof ANALYTICS_PARAMS.method
  >
  [ANALYTICS_EVENTS.authCompleted]: AnalyticsParamsFor<AnalyticsAuthParamKey>
  [ANALYTICS_EVENTS.artifactReturnedAfterAuth]: AnalyticsParamsFor<AnalyticsAuthParamKey>
  [ANALYTICS_EVENTS.signUp]: AnalyticsParamsFor<AnalyticsSignupParamKey>
  [ANALYTICS_EVENTS.workspaceCreated]: AnalyticsParamsFor<AnalyticsSignupParamKey>
  [ANALYTICS_EVENTS.firstArtifactPosted]: {
    [ANALYTICS_PARAMS.channel]: AnalyticsParamValues[typeof ANALYTICS_PARAMS.channel]
    engagement_time_msec: number
  }
}

export type AnalyticsEventPayload = {
  [EventName in AnalyticsEventName]: {
    name: EventName
    params: AnalyticsEventParams[EventName]
  }
}[AnalyticsEventName]

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

// Public compatibility export for consumers that enumerate dimension exclusions.
// react-doctor-disable-next-line deslop/unused-export
export const NON_DIMENSION_PARAMS: readonly string[] = []

type AnalyticsDimension = {
  parameterName: AnalyticsParamKey
  displayName: string
}
type AnalyticsDimensionValues<
  Dimensions extends readonly AnalyticsDimension[],
  Key extends keyof AnalyticsDimension,
> = {
  [Index in keyof Dimensions]: Dimensions[Index][Key]
}
type HasDuplicateValues<
  Values extends readonly unknown[],
  Seen = never,
> = Values extends readonly [infer Head, ...infer Tail]
  ? Head extends Seen
    ? true
    : HasDuplicateValues<Tail, Seen | Head>
  : false
type ValidAnalyticsDimensions<
  Dimensions extends readonly AnalyticsDimension[],
> =
  HasDuplicateValues<
    AnalyticsDimensionValues<Dimensions, 'parameterName'>
  > extends true
    ? never
    : HasDuplicateValues<
          AnalyticsDimensionValues<Dimensions, 'displayName'>
        > extends true
      ? never
      : Exclude<
            AnalyticsParamKey,
            Dimensions[number]['parameterName']
          > extends never
        ? Dimensions
        : never
function defineAnalyticsDimensions<
  const Dimensions extends readonly AnalyticsDimension[],
>(dimensions: Dimensions & ValidAnalyticsDimensions<Dimensions>): Dimensions {
  return dimensions
}

export const ANALYTICS_CUSTOM_DIMENSIONS = defineAnalyticsDimensions([
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
  { parameterName: ANALYTICS_PARAMS.visibility, displayName: 'Visibility' },
  { parameterName: ANALYTICS_PARAMS.viewerState, displayName: 'Viewer State' },
  {
    parameterName: ANALYTICS_PARAMS.accountState,
    displayName: 'Account State',
  },
] as const)
// Node の .mjs consumer は React source graph に現れないため抑制する。
// react-doctor-disable-next-line deslop/unused-export
export const ANALYTICS_DATA_RETENTION = {
  eventDataRetention: 'FOURTEEN_MONTHS',
  userDataRetention: 'TWO_MONTHS',
  resetUserDataOnNewActivity: false,
} as const
