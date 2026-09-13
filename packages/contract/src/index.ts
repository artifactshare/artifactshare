import { z } from 'zod'

/**
 * The CLI routes are intentionally unversioned in their URLs. This number
 * identifies the wire-contract snapshot exported by this package; it is not a
 * new URL prefix and must not be used to invent another endpoint.
 */
export const CLI_API_CONTRACT_VERSION = 1 as const
export const CLI_API_VERSION = CLI_API_CONTRACT_VERSION
export const CLI_API_BASE_PATH = '/api/cli' as const
export const CLI_DEVICE_CLIENT_ID = 'artifactshare-cli' as const

const stringId = z.string().min(1)
const timestamp = z.string().min(1)
const url = z.string().url()
const nullableTimestamp = timestamp.nullable()

export const ArtifactKindSchema = z.enum([
  'markdown_page',
  'html_page',
  'static_site',
  'spa',
  'workspace_app',
])
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

export const UploadArtifactKindSchema = z.enum([
  'markdown_page',
  'html_page',
  'static_site',
])
export type UploadArtifactKind = z.infer<typeof UploadArtifactKindSchema>

export const VisibilitySchema = z.enum([
  'private',
  'workspace',
  'project',
  'link',
])
export type Visibility = z.infer<typeof VisibilitySchema>

export const ProjectBaseVisibilitySchema = z.enum(['workspace', 'private'])
export type ProjectBaseVisibility = z.infer<typeof ProjectBaseVisibilitySchema>

export const ApiErrorSchema = z.object({
  code: stringId,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  why: z.string().optional(),
  hint: z.string().optional(),
  recovery: z
    .object({
      kind: stringId,
      command: z.string().optional(),
    })
    .optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const ApiErrorResponseSchema = z.object({ error: ApiErrorSchema })
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>

/** OAuth device endpoints use the RFC 8628 string error envelope. */
export const OAuthErrorResponseSchema = z.object({
  error: stringId,
  error_description: z.string().optional(),
})
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>

export const CliScopeDeniedResponseSchema = z.object({
  error: ApiErrorSchema,
  agent_recoverable: z.boolean(),
  requires_human: z.boolean(),
})
export type CliScopeDeniedResponse = z.infer<
  typeof CliScopeDeniedResponseSchema
>

export const ArtifactIdParamsSchema = z.object({ id: stringId })
export type ArtifactIdParams = z.infer<typeof ArtifactIdParamsSchema>

export const DownloadFileParamsSchema = z.object({
  id: stringId,
  '*': stringId,
})
export type DownloadFileParams = z.infer<typeof DownloadFileParamsSchema>

export const ProjectIdParamsSchema = z.object({ id: stringId })
export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>

/* Authentication --------------------------------------------------------- */

export const CliAuthRefreshRequestSchema = z.object({
  refresh_token: z.string().min(1).max(256),
  /** Optional for CLIs released before refresh-credential rotation. */
  rotation_request_id: z.string().min(1).max(128).optional(),
})
export type CliAuthRefreshRequest = z.infer<typeof CliAuthRefreshRequestSchema>

export const LegacyCliAuthRefreshRequestSchema = z.object({
  refresh_token: z.string().min(1).max(256),
})
export type LegacyCliAuthRefreshRequest = z.infer<
  typeof LegacyCliAuthRefreshRequestSchema
>

export const LegacyCliAuthRefreshResponseSchema = z.object({
  access_token: stringId,
  token_type: z.string().min(1),
  expires_at: timestamp,
})
export type LegacyCliAuthRefreshResponse = z.infer<
  typeof LegacyCliAuthRefreshResponseSchema
>

export const RotatingCliAuthRefreshResponseSchema = z.object({
  access_token: stringId,
  token_type: z.string().min(1),
  expires_at: timestamp,
  refresh_token: stringId,
  refresh_token_expires_at: timestamp,
})
export type RotatingCliAuthRefreshResponse = z.infer<
  typeof RotatingCliAuthRefreshResponseSchema
>

/**
 * New servers return rotating credentials. The legacy response remains a
 * valid read shape so a client can talk to a server during a rolling update.
 */
export const CliAuthRefreshResponseSchema = z.union([
  RotatingCliAuthRefreshResponseSchema,
  LegacyCliAuthRefreshResponseSchema,
])
export type CliAuthRefreshResponse = z.infer<
  typeof CliAuthRefreshResponseSchema
>

export const CliAuthRefreshCredentialsRequestSchema = z.object({
  device_name: z.string().max(100).nullable().optional(),
  device_id: z.string().max(100).nullable().optional(),
})
export type CliAuthRefreshCredentialsRequest = z.infer<
  typeof CliAuthRefreshCredentialsRequestSchema
>

export const CliAuthRefreshCredentialsResponseSchema = z.object({
  refresh_token: stringId,
  refresh_token_expires_at: timestamp,
})
export type CliAuthRefreshCredentialsResponse = z.infer<
  typeof CliAuthRefreshCredentialsResponseSchema
>

export const CliAuthRevokeRequestSchema = z.object({
  refresh_token: z.string().min(1).max(256),
})
export type CliAuthRevokeRequest = z.infer<typeof CliAuthRevokeRequestSchema>

export const CliAuthRevokeResponseSchema = z.object({
  revoked: z.literal(true),
})
export type CliAuthRevokeResponse = z.infer<typeof CliAuthRevokeResponseSchema>

export const DeviceAuthorizationPresetSchema = z.enum(['unrestricted', 'agent'])
export type DeviceAuthorizationPreset = z.infer<
  typeof DeviceAuthorizationPresetSchema
>

export const DeviceCodeRequestSchema = z
  .object({
    client_id: stringId,
    // The default Better Auth flow permits the field to be omitted. The CLI
    // always sends it, while older clients may rely on the default flow.
    preset: DeviceAuthorizationPresetSchema.optional(),
    device_name: z.string().max(100).nullable().optional(),
    project_selector: z.string().min(1).max(120).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.preset === 'unrestricted' &&
      value.project_selector !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['project_selector'],
        message: 'project_selector requires the agent preset',
      })
    }
  })
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequestSchema>

export const DeviceCodeResponseSchema = z.object({
  device_code: stringId,
  user_code: stringId,
  verification_uri: url,
  /** Older auth responses may omit this convenience URL or return null. */
  verification_uri_complete: url.nullable().optional(),
  expires_in: z.number().int().nonnegative(),
  interval: z.number().int().nonnegative(),
})
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>

export const DeviceTokenRequestSchema = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
  device_code: stringId,
  client_id: stringId,
})
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>

export const DeviceTokenResponseSchema = z.object({
  access_token: stringId,
  token_type: z
    .string()
    .min(1)
    .refine((value) => value.toLowerCase() === 'bearer', {
      message: 'token_type must be Bearer',
    }),
  expires_in: z.number().int().nonnegative().optional(),
})
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>

export const DeviceApproveRequestSchema = z.object({
  userCode: stringId,
  project_id: stringId.optional(),
})
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequestSchema>

export const DeviceApprovalQuerySchema = z.object({ user_code: stringId })
export type DeviceApprovalQuery = z.infer<typeof DeviceApprovalQuerySchema>

export const FixedAgentApprovalProjectSchema = z.object({
  id: stringId,
  name: z.string(),
  baseVisibility: ProjectBaseVisibilitySchema,
  updatedAt: timestamp,
})
export type FixedAgentApprovalProject = z.infer<
  typeof FixedAgentApprovalProjectSchema
>

export const AgentApprovalSchema = z.object({
  preset: z.literal('agent'),
  deviceName: z.string().nullable(),
  projectSelector: z.string().nullable(),
  fixedProject: FixedAgentApprovalProjectSchema.nullable(),
  fixedProjectError: z.boolean(),
})
export type AgentApproval = z.infer<typeof AgentApprovalSchema>

export const DeviceApprovalResponseSchema = z.object({
  agentApproval: AgentApprovalSchema.nullable(),
})
export type DeviceApprovalResponse = z.infer<
  typeof DeviceApprovalResponseSchema
>

/* Shared identity responses --------------------------------------------- */

export const CliUserSchema = z.object({
  id: stringId,
  email: z.string(),
})
export type CliUser = z.infer<typeof CliUserSchema>

export const CliWorkspaceSchema = z.object({
  id: stringId,
  hosted_domain: z.string().nullable(),
})
export type CliWorkspace = z.infer<typeof CliWorkspaceSchema>

export const CliWhoamiResponseSchema = z.object({
  user: CliUserSchema,
  workspace: CliWorkspaceSchema,
  auth: z.object({ kind: z.literal('bearer_or_session') }),
})
export type CliWhoamiResponse = z.infer<typeof CliWhoamiResponseSchema>

export const DoctorAuthoritySchema = z.object({
  preset: DeviceAuthorizationPresetSchema,
  project_id: stringId.nullable(),
})
export type DoctorAuthority = z.infer<typeof DoctorAuthoritySchema>

export const DoctorUploadSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: stringId,
    message: z.string(),
  }),
])
export type DoctorUpload = z.infer<typeof DoctorUploadSchema>

export const CliDoctorResponseSchema = z.object({
  user: CliUserSchema,
  workspace: CliWorkspaceSchema,
  auth: z.object({
    kind: z.literal('bearer_or_session'),
    ok: z.literal(true),
    authority: DoctorAuthoritySchema,
  }),
  upload: DoctorUploadSchema,
})
export type CliDoctorResponse = z.infer<typeof CliDoctorResponseSchema>

/* Upload and version update --------------------------------------------- */

/** Query parameters used by the multipart upload endpoint. */
export const ArtifactUploadQuerySchema = z.object({
  publish_key: z.string().optional(),
  expected_version: z.string().optional(),
  artifact_kind: z.literal('static_site').optional(),
  container_id: z.string().optional(),
})
export type ArtifactUploadQuery = z.infer<typeof ArtifactUploadQuerySchema>

/** Query parameters used by the multipart replacement endpoint. */
export const ArtifactVersionUpdateQuerySchema = z.object({
  expected_version: z.string().optional(),
  artifact_kind: z.literal('static_site').optional(),
})
export type ArtifactVersionUpdateQuery = z.infer<
  typeof ArtifactVersionUpdateQuerySchema
>

/**
 * Metadata fields in the multipart upload form. `link_expires_at` and
 * `slack_notify` retain their wire strings because FormData does not carry
 * JSON booleans/nulls; `link_expires_at: "null"` means no expiry.
 */
export const ArtifactUploadFormSchema = z.object({
  visibility: VisibilitySchema.optional(),
  grant_email: z.array(z.string()).optional(),
  container_id: z.string().optional(),
  link_expires_at: z.string().optional(),
  slack_notify: z.string().optional(),
})
export type ArtifactUploadForm = z.infer<typeof ArtifactUploadFormSchema>

export const UploadWarningSchema = z.object({
  code: z.literal('slack_reauthorization_required'),
  message: z.string(),
})
export type UploadWarning = z.infer<typeof UploadWarningSchema>

export const ArtifactUploadResponseSchema = z.object({
  id: stringId,
  versionId: stringId,
  artifactKind: UploadArtifactKindSchema,
  // The legacy single-file response always includes these fields. The
  // static-site helper can omit them when only the artifact identity is
  // available, so the shared response contract keeps both variants readable.
  visibility: VisibilitySchema.optional(),
  link_expires_at: nullableTimestamp.optional(),
  // The legacy single-file endpoint returns this field; the static-site
  // helper omits it because its destination is carried in the query string.
  containerId: stringId.nullable().optional(),
  shareUrl: url,
  /** Present only for publish-key requests. */
  created: z.boolean().optional(),
  warnings: z.array(UploadWarningSchema).optional(),
})
export type ArtifactUploadResponse = z.infer<
  typeof ArtifactUploadResponseSchema
>

export const ArtifactVersionUpdateResponseSchema = z.object({
  id: stringId,
  versionId: stringId,
  shareUrl: url,
  /** Static-site replacement responses include this field. */
  artifactKind: UploadArtifactKindSchema.optional(),
})
export type ArtifactVersionUpdateResponse = z.infer<
  typeof ArtifactVersionUpdateResponseSchema
>

export const ArtifactVersionLookupResponseSchema = z.object({
  id: stringId,
  currentVersionId: stringId.nullable(),
})
export type ArtifactVersionLookupResponse = z.infer<
  typeof ArtifactVersionLookupResponseSchema
>

/* Artifacts -------------------------------------------------------------- */

export const ArtifactsListQuerySchema = z.object({
  /** Empty string selects the unfiled home list. */
  project_id: z.string().optional(),
  query: z.string().optional(),
  cursor: z.string().optional(),
})
export type ArtifactsListQuery = z.infer<typeof ArtifactsListQuerySchema>

export const ArtifactIncludeSchema = z.enum(['versions', 'comments'])
export type ArtifactInclude = z.infer<typeof ArtifactIncludeSchema>

/** Parsed query values after URLSearchParams handling. */
export const ArtifactReadQuerySchema = z.object({
  offset: z.number().int().nonnegative().optional(),
  include: z.array(ArtifactIncludeSchema).optional(),
})
export type ArtifactReadQuery = z.infer<typeof ArtifactReadQuerySchema>

/** Raw query values before converting the decimal offset. */
export const ArtifactReadQueryParamsSchema = z.object({
  offset: z.string().regex(/^\d+$/).optional(),
  // URLSearchParams.getAll('include') retains comma-separated values from
  // requests such as include=versions,comments, so validate the raw values
  // without changing the wire representation.
  include: z
    .array(z.string())
    .optional()
    .superRefine((values, context) => {
      if (!values) return
      for (const [index, value] of values.entries()) {
        for (const item of value.split(',')) {
          const candidate = item.trim()
          if (!candidate) continue
          if (!ArtifactIncludeSchema.safeParse(candidate).success) {
            context.addIssue({
              code: 'custom',
              path: [index],
              message: 'include must be versions or comments',
            })
          }
        }
      }
    }),
})
export type ArtifactReadQueryParams = z.infer<
  typeof ArtifactReadQueryParamsSchema
>

export const ArtifactVersionSchema = z.object({
  version_id: stringId,
  status: z.string(),
  size_bytes: z.number().nonnegative(),
  created_at: timestamp,
  published_at: nullableTimestamp,
  is_current: z.boolean(),
  creator: z
    .object({
      kind: z.enum(['human', 'agent']),
      name: z.string(),
      email: z.string().nullable(),
      agent_profile_id: stringId.nullable(),
    })
    .nullable(),
})
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>

export const ArtifactReadResponseSchema = z.object({
  id: stringId,
  share_url: url,
  version_id: stringId,
  format: z.enum(['html', 'markdown']),
  content: z.string(),
  size_bytes: z.number().nonnegative(),
  truncated: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
  link_expires_at: nullableTimestamp,
  project_id: stringId.nullable(),
  versions: z.array(ArtifactVersionSchema).optional(),
  versions_has_more: z.boolean().optional(),
  comments: z.array(z.lazy(() => CommentThreadSchema)).optional(),
  comments_has_more: z.boolean().optional(),
})
export type ArtifactReadResponse = z.infer<typeof ArtifactReadResponseSchema>

export const ArtifactDeleteResponseSchema = z.object({
  id: stringId,
  deleted: z.literal(true),
})
export type ArtifactDeleteResponse = z.infer<
  typeof ArtifactDeleteResponseSchema
>

export const ArtifactAppendRequestSchema = z.object({
  content: z.string().min(1),
})
export type ArtifactAppendRequest = z.infer<typeof ArtifactAppendRequestSchema>

export const ArtifactAppendResponseSchema = z.object({
  id: stringId,
  versionId: stringId,
  shareUrl: url,
  artifactKind: UploadArtifactKindSchema,
})
export type ArtifactAppendResponse = z.infer<
  typeof ArtifactAppendResponseSchema
>

export const DownloadManifestFileSchema = z.object({
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  content_type: z.string().min(1),
  sha256: stringId,
})
export type DownloadManifestFile = z.infer<typeof DownloadManifestFileSchema>

export const DownloadManifestResponseSchema = z.object({
  id: stringId,
  share_url: url,
  version_id: stringId,
  artifact_kind: UploadArtifactKindSchema,
  files: z.array(DownloadManifestFileSchema),
  total_size_bytes: z.number().int().nonnegative(),
  project_id: stringId.nullable(),
})
export type DownloadManifestResponse = z.infer<
  typeof DownloadManifestResponseSchema
>

export const ArtifactsListEntrySchema = z.object({
  id: stringId,
  title: z.string(),
  share_url: url,
  visibility: VisibilitySchema,
  link_expires_at: nullableTimestamp,
  updated_at: timestamp,
  project_id: stringId.nullable(),
  owner_email: z.string().optional(),
  artifact_kind: ArtifactKindSchema,
})
export type ArtifactsListEntry = z.infer<typeof ArtifactsListEntrySchema>

export const ArtifactsListResponseSchema = z.object({
  artifacts: z.array(ArtifactsListEntrySchema),
  limit: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
})
export type ArtifactsListResponse = z.infer<typeof ArtifactsListResponseSchema>

/* Comments --------------------------------------------------------------- */

export const CommentAnchorSchema = z.union([
  z.object({
    kind: z.literal('artifact'),
    quoted_text: z.null(),
    state: z.null(),
  }),
  z.object({
    kind: z.literal('text'),
    quoted_text: z.string(),
    state: z.enum(['attached', 'orphaned']),
  }),
])
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>

export const CommentMessageSchema = z.object({
  message_id: stringId,
  author_name: z.string().nullable(),
  author_email: z.string(),
  agent: z.string().nullable(),
  body: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
})
export type CommentMessage = z.infer<typeof CommentMessageSchema>

export const CommentThreadSchema = z.object({
  id: stringId,
  status: z.enum(['open', 'resolved']),
  resolved_at: nullableTimestamp,
  created_at: timestamp,
  updated_at: timestamp,
  anchor: CommentAnchorSchema,
  messages: z.array(CommentMessageSchema),
})
export type CommentThread = z.infer<typeof CommentThreadSchema>

export const CommentPostRequestSchema = z
  .object({
    body: z.string().min(1).max(4000),
    reply_to: z.string().min(1).max(128).optional(),
    quote: z.string().min(1).max(1000).optional(),
    quote_before: z.string().min(1).max(200).optional(),
    quote_after: z.string().min(1).max(200).optional(),
    agent: z.string().min(1).max(30).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.quote === undefined &&
      (value.quote_before !== undefined || value.quote_after !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quote'],
        message: 'quote_before and quote_after require quote',
      })
    }
  })
export type CommentPostRequest = z.infer<typeof CommentPostRequestSchema>

export const CommentEditRequestSchema = z.object({
  action: z.literal('edit'),
  message_id: stringId.max(128),
  body: z.string().min(1).max(4000),
})
export type CommentEditRequest = z.infer<typeof CommentEditRequestSchema>

export const CommentResolveRequestSchema = z.object({
  action: z.literal('resolve'),
  thread_id: stringId.max(128),
})
export type CommentResolveRequest = z.infer<typeof CommentResolveRequestSchema>

export const CommentReopenRequestSchema = z.object({
  action: z.literal('reopen'),
  thread_id: stringId.max(128),
})
export type CommentReopenRequest = z.infer<typeof CommentReopenRequestSchema>

export const CommentDeleteRequestSchema = z.object({
  action: z.literal('delete'),
  thread_id: stringId.max(128),
  message_id: stringId.max(128).optional(),
})
export type CommentDeleteRequest = z.infer<typeof CommentDeleteRequestSchema>

export const CommentActionRequestSchema = z.union([
  CommentEditRequestSchema,
  CommentResolveRequestSchema,
  CommentReopenRequestSchema,
  CommentDeleteRequestSchema,
])
export type CommentActionRequest = z.infer<typeof CommentActionRequestSchema>

export const CommentRequestSchema = z.union([
  CommentPostRequestSchema,
  CommentActionRequestSchema,
])
export type CommentRequest = z.infer<typeof CommentRequestSchema>

export const CommentsListResponseSchema = z.object({
  artifact_id: stringId,
  share_url: url,
  comments: z.array(CommentThreadSchema),
  has_more: z.boolean(),
})
export type CommentsListResponse = z.infer<typeof CommentsListResponseSchema>

export const CommentPostResponseSchema = z.object({
  artifact_id: stringId,
  share_url: url,
  thread_id: stringId,
  reply: z.boolean(),
  thread: CommentThreadSchema,
})
export type CommentPostResponse = z.infer<typeof CommentPostResponseSchema>

export const CommentActionResponseSchema = z.object({
  artifact_id: stringId,
  share_url: url,
  thread_id: stringId,
  thread: CommentThreadSchema,
})
export type CommentActionResponse = z.infer<typeof CommentActionResponseSchema>

export const CommentDeleteResponseSchema = z.object({
  artifact_id: stringId,
  share_url: url,
  thread_id: stringId,
  deleted: z.literal(true),
  thread_deleted: z.boolean(),
  thread: CommentThreadSchema.optional(),
})
export type CommentDeleteResponse = z.infer<typeof CommentDeleteResponseSchema>

/* Projects --------------------------------------------------------------- */

export const ProjectListEntrySchema = z.object({
  id: stringId,
  name: z.string(),
  description: z.string().nullable(),
  // Agent-scoped listings deliberately use the public value "restricted".
  base_visibility: z.string().min(1),
  file_count: z.number().int().nonnegative().nullable(),
  updated_at: timestamp.nullable(),
})
export type ProjectListEntry = z.infer<typeof ProjectListEntrySchema>

export const ProjectsListResponseSchema = z.object({
  projects: z.array(ProjectListEntrySchema),
})
export type ProjectsListResponse = z.infer<typeof ProjectsListResponseSchema>

export const ProjectCreateRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  base_visibility: ProjectBaseVisibilitySchema.nullable().optional(),
})
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>

export const ProjectCreateResponseSchema = z.object({
  project: z.object({
    id: stringId,
    name: z.string(),
    description: z.string().nullable(),
    base_visibility: ProjectBaseVisibilitySchema,
  }),
})
export type ProjectCreateResponse = z.infer<typeof ProjectCreateResponseSchema>

export const ProjectEditRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    base_visibility: ProjectBaseVisibilitySchema.nullable().optional(),
    add_emails: z.array(z.string()).optional(),
    remove_emails: z.array(z.string()).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one project edit field is required',
  })
export type ProjectEditRequest = z.infer<typeof ProjectEditRequestSchema>

export const ProjectEditResponseSchema = z.object({
  project: z.object({
    id: stringId,
    name: z.string(),
    description: z.string().nullable(),
    base_visibility: ProjectBaseVisibilitySchema,
    file_count: z.number().int().nonnegative().nullable(),
    archived: z.boolean(),
  }),
  audience: z.array(z.string()),
})
export type ProjectEditResponse = z.infer<typeof ProjectEditResponseSchema>

/* Artifact settings ------------------------------------------------------ */

export const CliEditableVisibilitySchema = z.enum([
  'private',
  'workspace',
  'link',
])
export type CliEditableVisibility = z.infer<typeof CliEditableVisibilitySchema>

export const CliDestinationSchema = z.union([
  z.literal('home'),
  z.object({ project_id: stringId }),
])
export type CliDestination = z.infer<typeof CliDestinationSchema>

const CliEditDestinationSchema = z.union([
  z.literal('home'),
  z.object({ project_id: z.string().trim().min(1) }),
])

export const CliEditRequestSchema = z
  .object({
    title: z.string().optional(),
    visibility: CliEditableVisibilitySchema.optional(),
    link_expires_at: z.string().nullable().optional(),
    add_emails: z.array(z.string()).optional(),
    remove_emails: z.array(z.string()).optional(),
    destination: CliEditDestinationSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one edit field is required',
  })
export type CliEditRequest = z.infer<typeof CliEditRequestSchema>

export const CliArtifactReferenceSchema = z.object({
  id: stringId,
  url: url,
})
export type CliArtifactReference = z.infer<typeof CliArtifactReferenceSchema>

export const CliArtifactDestinationSchema = z.union([
  z.object({ type: z.literal('home'), project_id: z.null() }),
  z.object({ type: z.literal('project'), project_id: stringId }),
])
export type CliArtifactDestination = z.infer<
  typeof CliArtifactDestinationSchema
>

export const CliEditResponseSchema = z.object({
  artifact: CliArtifactReferenceSchema,
  title: z.string(),
  destination: CliArtifactDestinationSchema,
  share: z.object({
    visibility: VisibilitySchema,
    link_expires_at: nullableTimestamp,
  }),
})
export type CliEditResponse = z.infer<typeof CliEditResponseSchema>

export const CliMoveRequestSchema = z.object({
  destination: CliDestinationSchema,
})
export type CliMoveRequest = z.infer<typeof CliMoveRequestSchema>

export const CliMoveResponseSchema = z.object({
  artifact: CliArtifactReferenceSchema,
  destination: CliArtifactDestinationSchema,
  share: z.object({
    visibility: VisibilitySchema,
    project_audience_may_change: z.boolean(),
  }),
})
export type CliMoveResponse = z.infer<typeof CliMoveResponseSchema>

/* Resolve --------------------------------------------------------------- */

export const ResolveQuerySchema = z.object({ q: z.string().trim().min(1) })
export type ResolveQuery = z.infer<typeof ResolveQuerySchema>

export const ResolveMatchSchema = z.object({
  kind: z.enum(['url', 'id', 'title', 'project_name']),
  confidence: z.enum(['exact', 'candidate']),
})
export type ResolveMatch = z.infer<typeof ResolveMatchSchema>

export const ArtifactResolveCandidateSchema = z.object({
  kind: z.literal('artifact'),
  id: stringId,
  title: z.string(),
  artifact_kind: ArtifactKindSchema,
  visibility: VisibilitySchema,
  project: z.object({ id: stringId, name: z.string() }).nullable(),
  owner: z.object({ id: stringId, email: z.string() }),
  updated_at: timestamp,
  match: ResolveMatchSchema,
})
export type ArtifactResolveCandidate = z.infer<
  typeof ArtifactResolveCandidateSchema
>

export const VersionResolveCandidateSchema = z.object({
  kind: z.literal('version'),
  id: stringId,
  artifact_id: stringId,
  version_id: stringId,
  ordinal: z.number().int().nonnegative(),
  is_current: z.boolean(),
  published_at: nullableTimestamp,
  size_bytes: z.number().nonnegative(),
  match: ResolveMatchSchema,
})
export type VersionResolveCandidate = z.infer<
  typeof VersionResolveCandidateSchema
>

export const ProjectResolveCandidateSchema = z.object({
  kind: z.literal('project'),
  id: stringId,
  name: z.string(),
  description: z.string().nullable(),
  base_visibility: z.string().min(1),
  file_count: z.number().int().nonnegative(),
  updated_at: timestamp,
  match: ResolveMatchSchema,
})
export type ProjectResolveCandidate = z.infer<
  typeof ProjectResolveCandidateSchema
>

export const ResolveCandidateSchema = z.union([
  ArtifactResolveCandidateSchema,
  VersionResolveCandidateSchema,
  ProjectResolveCandidateSchema,
])
export type ResolveCandidate = z.infer<typeof ResolveCandidateSchema>

export const ResolveResponseSchema = z.object({
  query: z.string(),
  candidates: z.array(ResolveCandidateSchema),
  has_more: z.boolean(),
})
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>

/* HTTP method/status metadata ------------------------------------------- */

export const CLI_API_STATUS_CODES = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  requestEntityTooLarge: 413,
  unsupportedMediaType: 415,
  tooManyRequests: 429,
  badGateway: 502,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const

export type CliApiAuth = 'public' | 'bearer' | 'bearer_or_session'

/**
 * Status metadata documents existing behavior; consumers should still use
 * the response schemas for body validation. Upload and version-update entries
 * are included because the CLI calls those existing non-/api/cli paths.
 */
export const CLI_API_ENDPOINTS = {
  authRefresh: {
    path: '/api/cli/auth/refresh',
    method: 'POST',
    auth: 'public' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 405] as const,
  },
  authRefreshCredentials: {
    path: '/api/cli/auth/refresh-credentials',
    method: 'POST',
    auth: 'bearer' as const,
    successStatus: 200,
    errorStatuses: [401, 403, 405] as const,
  },
  authRevoke: {
    path: '/api/cli/auth/revoke',
    method: 'POST',
    auth: 'public' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 405, 503] as const,
  },
  deviceApproval: {
    path: '/api/cli/device-approval',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401] as const,
  },
  artifactsList: {
    path: '/api/cli/artifacts',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401] as const,
  },
  artifactRead: {
    path: '/api/cli/artifacts/:id',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 404, 409] as const,
  },
  artifactDelete: {
    path: '/api/cli/artifacts/:id',
    method: 'DELETE',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401, 404, 405, 502] as const,
  },
  artifactAppend: {
    path: '/api/cli/artifacts/:id/append',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 403, 405, 409, 413, 502] as const,
  },
  artifactDownloadManifest: {
    path: '/api/cli/artifacts/:id/download',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401, 404, 409] as const,
  },
  artifactDownloadFile: {
    path: '/api/cli/artifacts/:id/download/*',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401, 404, 409] as const,
  },
  commentsList: {
    path: '/api/cli/artifacts/:id/comments',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401, 404] as const,
  },
  commentsPostOrAction: {
    path: '/api/cli/artifacts/:id/comments',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 403, 404, 409, 502] as const,
  },
  projectsList: {
    path: '/api/cli/projects',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401] as const,
  },
  projectsCreate: {
    path: '/api/cli/projects',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 402, 403, 409] as const,
  },
  projectEdit: {
    path: '/api/cli/projects/:id',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 403, 404, 409] as const,
  },
  artifactEdit: {
    path: '/api/cli/shareables/:id/edit',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 402, 403, 404, 409, 429, 502] as const,
  },
  artifactMove: {
    path: '/api/cli/shareables/:id/move',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 404] as const,
  },
  resolve: {
    path: '/api/cli/resolve',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401] as const,
  },
  whoami: {
    path: '/api/cli/whoami',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401] as const,
  },
  doctor: {
    path: '/api/cli/doctor',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401] as const,
  },
  artifactUpload: {
    path: '/api/shareables/uploads',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 402, 403, 409, 413, 415, 429, 502] as const,
  },
  artifactVersionLookup: {
    path: '/api/shareables/:id/versions',
    method: 'GET',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [401, 404] as const,
  },
  artifactVersionUpdate: {
    path: '/api/shareables/:id/versions',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 403, 409, 413, 415, 502] as const,
  },
  deviceCode: {
    path: '/api/auth/device/code',
    method: 'POST',
    auth: 'public' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 429, 500] as const,
  },
  deviceToken: {
    path: '/api/auth/device/token',
    method: 'POST',
    auth: 'public' as const,
    successStatus: 200,
    errorStatuses: [400, 401, 429, 500] as const,
  },
  deviceApprove: {
    path: '/api/auth/device/approve',
    method: 'POST',
    auth: 'bearer_or_session' as const,
    successStatus: 200,
    errorStatuses: [400, 401] as const,
  },
} as const

export type CliApiEndpoint =
  (typeof CLI_API_ENDPOINTS)[keyof typeof CLI_API_ENDPOINTS]

/* Uppercase aliases follow the schema naming convention used by the MCP
 * surface while the PascalCase names remain pleasant for TypeScript imports. */
export const API_ERROR_SCHEMA = ApiErrorSchema
export const API_ERROR_RESPONSE_SCHEMA = ApiErrorResponseSchema
export const CLI_AUTH_REFRESH_REQUEST_SCHEMA = CliAuthRefreshRequestSchema
export const LEGACY_CLI_AUTH_REFRESH_RESPONSE_SCHEMA =
  LegacyCliAuthRefreshResponseSchema
export const CLI_AUTH_REFRESH_RESPONSE_SCHEMA = CliAuthRefreshResponseSchema
export const CLI_AUTH_REFRESH_CREDENTIALS_REQUEST_SCHEMA =
  CliAuthRefreshCredentialsRequestSchema
export const CLI_AUTH_REFRESH_CREDENTIALS_RESPONSE_SCHEMA =
  CliAuthRefreshCredentialsResponseSchema
export const CLI_AUTH_REVOKE_REQUEST_SCHEMA = CliAuthRevokeRequestSchema
export const CLI_AUTH_REVOKE_RESPONSE_SCHEMA = CliAuthRevokeResponseSchema
export const DEVICE_CODE_REQUEST_SCHEMA = DeviceCodeRequestSchema
export const DEVICE_CODE_RESPONSE_SCHEMA = DeviceCodeResponseSchema
export const DEVICE_TOKEN_REQUEST_SCHEMA = DeviceTokenRequestSchema
export const DEVICE_TOKEN_RESPONSE_SCHEMA = DeviceTokenResponseSchema
export const CLI_WHOAMI_RESPONSE_SCHEMA = CliWhoamiResponseSchema
export const CLI_DOCTOR_RESPONSE_SCHEMA = CliDoctorResponseSchema
export const ARTIFACT_UPLOAD_RESPONSE_SCHEMA = ArtifactUploadResponseSchema
export const ARTIFACT_VERSION_UPDATE_RESPONSE_SCHEMA =
  ArtifactVersionUpdateResponseSchema
export const ARTIFACT_READ_RESPONSE_SCHEMA = ArtifactReadResponseSchema
export const ARTIFACT_DELETE_RESPONSE_SCHEMA = ArtifactDeleteResponseSchema
export const ARTIFACT_APPEND_REQUEST_SCHEMA = ArtifactAppendRequestSchema
export const ARTIFACT_APPEND_RESPONSE_SCHEMA = ArtifactAppendResponseSchema
export const ARTIFACTS_LIST_RESPONSE_SCHEMA = ArtifactsListResponseSchema
export const DOWNLOAD_MANIFEST_RESPONSE_SCHEMA = DownloadManifestResponseSchema
export const COMMENT_REQUEST_SCHEMA = CommentRequestSchema
export const COMMENTS_LIST_RESPONSE_SCHEMA = CommentsListResponseSchema
export const COMMENT_POST_RESPONSE_SCHEMA = CommentPostResponseSchema
export const COMMENT_ACTION_RESPONSE_SCHEMA = CommentActionResponseSchema
export const COMMENT_DELETE_RESPONSE_SCHEMA = CommentDeleteResponseSchema
export const PROJECTS_LIST_RESPONSE_SCHEMA = ProjectsListResponseSchema
export const PROJECT_CREATE_RESPONSE_SCHEMA = ProjectCreateResponseSchema
export const PROJECT_EDIT_RESPONSE_SCHEMA = ProjectEditResponseSchema
export const CLI_EDIT_REQUEST_SCHEMA = CliEditRequestSchema
export const CLI_EDIT_RESPONSE_SCHEMA = CliEditResponseSchema
export const CLI_MOVE_REQUEST_SCHEMA = CliMoveRequestSchema
export const CLI_MOVE_RESPONSE_SCHEMA = CliMoveResponseSchema
export const RESOLVE_RESPONSE_SCHEMA = ResolveResponseSchema
