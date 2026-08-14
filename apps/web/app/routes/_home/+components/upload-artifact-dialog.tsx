import {
  useCallback,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from 'react'
import { useLocation, useNavigate, useRevalidator } from 'react-router'
import { IconFolderOpen, IconStack2 as Layers } from '@tabler/icons-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { useT } from '~/hooks/use-t'
import {
  isUploadShareableErrorCode,
  UPLOAD_SHAREABLE_ERROR_I18N,
  type UploadShareableErrorCode,
} from '~/lib/api-errors'
import type {
  EditableVisibility,
  ProjectBaseVisibility,
} from '~/lib/shareable-types'
import type { UserInfo } from '~/lib/user'
import { configureDirectoryInput } from '~/lib/directory-input'
import { UploadDropzone } from './upload-dropzone'
import { UploadInitialGrants } from './upload-initial-grants'
import {
  createUploadDialogState,
  resolveGrantEmailsForUpload,
  resolveUploadDialogState,
  uploadDialogReducer,
} from './upload-artifact-dialog-state'
import { UploadVisibilitySelector } from './upload-visibility-selector'
import {
  ACCEPTED_FILE_UPLOAD_TYPES,
  ACCEPTED_SITE_UPLOAD_TYPES,
  appendUploadFiles,
  filterUploadFiles,
  isStaticSiteUpload,
  validateFiles,
} from '~/lib/upload-artifact-validation'
import { uploadReturnTo } from '~/lib/home-upload-query'
import { cn } from '~/lib/utils'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '~/components/ui/field'
import {
  UpgradeRequestPanel,
  type UpgradeRequestView,
} from '~/components/app/upgrade-request-panel'

const uploadDialogContentClassName =
  'max-w-[var(--breakpoint-phone)] sm:max-w-[var(--breakpoint-phone)]'

const uploadDestinationClassName =
  'text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[var(--spacing-2)] border-0 bg-transparent p-0 text-xs'

const uploadDestinationLabelClassName = 'whitespace-nowrap'

const uploadDestinationBadgeClassName =
  'inline-flex min-h-6 max-w-full min-w-0 items-center justify-self-start gap-1.25 overflow-hidden rounded-full border border-border bg-muted px-2 py-0.5 font-semibold text-ellipsis whitespace-nowrap text-foreground'

const uploadDestinationIconClassName = 'shrink-0 text-link'

const uploadDestinationNameClassName = 'min-w-0 overflow-hidden text-ellipsis'

const uploadPickersClassName = 'flex justify-center gap-[var(--spacing-2)]'

const uploadPickerButtonClassName = cn(
  'inline-flex h-8 cursor-pointer items-center gap-[var(--spacing-1_5)] px-3 text-sm font-medium',
  'border-divider bg-card text-foreground rounded-[var(--r-md)] border',
  'hover:border-border-strong hover:bg-muted',
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none',
  'disabled:cursor-progress disabled:opacity-70',
  '[&_svg]:size-4',
)

const uploadProjectDefaultsClassName =
  'flex flex-col gap-[var(--spacing-2)] rounded-[var(--r-md)] border border-divider bg-muted p-3'

const uploadProjectDefaultsHeadClassName =
  'flex items-baseline justify-between gap-3'

const uploadProjectDefaultsTitleClassName = 'text-xs'

const uploadProjectDefaultsMetaClassName = 'text-muted-foreground text-xs'

const uploadProjectDefaultsCopyClassName = 'text-muted-foreground m-0 text-xs'

const uploadProjectDefaultsListClassName =
  'mt-2 flex max-h-30 list-none flex-col gap-[var(--spacing-1)] overflow-y-auto p-0'

const uploadProjectDefaultsEmailClassName =
  'overflow-hidden text-ellipsis whitespace-nowrap'

const uploadProjectDefaultsExternalClassName = 'text-xs font-semibold text-link'

async function readUploadError(res: Response) {
  const body = (await res.json().catch(() => null)) as {
    error?: {
      code?: string
      details?: { upgrade_request?: UpgradeRequestView }
    }
  } | null
  return {
    code: body?.error?.code,
    upgradeRequest: body?.error?.details?.upgrade_request ?? null,
  }
}

export function shouldShowSlackNotification(
  hasSlackChannel: boolean | undefined,
  visibility: EditableVisibility,
  hasExternalPosting: boolean,
) {
  return Boolean(
    hasSlackChannel && (hasExternalPosting || visibility !== 'private'),
  )
}

export function appendSlackNotificationPreference(
  form: FormData,
  slackNotifyDisabled: boolean,
) {
  if (slackNotifyDisabled) form.set('slack_notify', 'false')
}

const TERMINAL_UPLOAD_ERRORS = new Set<UploadShareableErrorCode>([
  'upload-not-allowed',
  'self-upload-disabled',
  'workspace-access-revoked',
  'workspace-unavailable',
  'contributor-limit-exceeded',
  'invalid-grants',
  'quota-exceeded',
  'too-large',
  'unsupported-type',
  'file-too-large',
  'path-too-long',
  'path-too-deep',
  'duplicate-path',
  'missing-entrypoint',
  'invalid-path',
  'too-many-files',
  'missing-file',
])

interface UploadArtifactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultVisibility: EditableVisibility
  workspaceHd?: string | null
  availableVisibilities: ReadonlyArray<EditableVisibility>
  linkSharingAvailable?: boolean
  user: UserInfo
  destination?: {
    containerId: string
    label: string
    baseVisibility?: ProjectBaseVisibility
    hasSlackChannel?: boolean
    slackChannelName?: string | null
    shareDefaults?: ReadonlyArray<ProjectUploadShareDefault>
    externalPosting?: {
      audienceCount: number
      externalCount: number
      workspaceName?: string | null
    } | null
  } | null
}

type ProjectUploadShareDefault = {
  id: string
  email: string
  isExternal: boolean
}

// オプトアウトは「今回だけ」の指定。programmatic open では Radix の
// onOpenChange が呼ばれないため、open prop の変化を render 中に検知して戻す。
function useSlackNotifyOptOut(open: boolean) {
  const [disabled, setDisabled] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    setDisabled(false)
  }
  return [disabled, setDisabled] as const
}

export function UploadArtifactDialog({
  open,
  onOpenChange,
  defaultVisibility,
  workspaceHd = null,
  availableVisibilities,
  linkSharingAvailable = true,
  user,
  destination = null,
}: UploadArtifactDialogProps) {
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const [state, dispatch] = useReducer(
    uploadDialogReducer,
    { defaultVisibility, open },
    createUploadDialogState,
  )
  const [slackNotifyDisabled, setSlackNotifyDisabled] =
    useSlackNotifyOptOut(open)
  const [upgradeRequest, setUpgradeRequest] =
    useState<UpgradeRequestView | null>(null)
  const currentState = resolveUploadDialogState(state, {
    defaultVisibility,
    open,
  })
  const homeDestinationLabel = t('project.homeTitle', {
    name: user.name ?? user.email,
  })
  // Keep the opened dialog seeded from the latest props before children render.
  if (currentState !== state) {
    dispatch({ type: 'props-changed', defaultVisibility, open })
  }
  const navigate = useNavigate()
  const location = useLocation()
  const revalidator = useRevalidator()

  const upload = useCallback(
    async (files: File[]) => {
      setUpgradeRequest(null)
      const problem = validateFiles(files, t)
      if (problem) {
        toast.error(problem)
        return
      }
      const staticSite = isStaticSiteUpload(files)
      if (currentState.visibility === 'link' && !linkSharingAvailable) {
        toast.error(t('upload.visibility.link.unavailable'))
        return
      }
      const initialGrantEmails =
        currentState.visibility === 'private'
          ? resolveGrantEmailsForUpload(
              currentState.grantEmails,
              currentState.grantInput,
              user,
            )
          : []

      dispatch({ type: 'uploading-changed', uploading: true })
      const toastId = toast.loading(t('upload.toast.uploading'))
      const form = new FormData()
      appendUploadFiles(form, files)
      form.set('visibility', currentState.visibility)
      for (const email of initialGrantEmails) {
        form.append('grant_email', email)
      }
      if (destination) {
        form.set('container_id', destination.containerId)
      }
      appendSlackNotificationPreference(form, slackNotifyDisabled)

      try {
        const query = destination
          ? `&container_id=${encodeURIComponent(destination.containerId)}`
          : ''
        const uploadUrl = staticSite
          ? `/api/shareables/uploads?artifact_kind=static_site${query}`
          : '/api/shareables/uploads'
        const res = await fetch(uploadUrl, {
          method: 'POST',
          body: form,
        })
        if (res.status === 401) {
          toast.error(t('reauth.body'), { id: toastId })
          return
        }
        if (!res.ok) {
          const failure = await readUploadError(res)
          const code = failure.code
          const key =
            staticSite && code === 'unsupported-type'
              ? 'upload.error.unsupportedBundleType'
              : isUploadShareableErrorCode(code)
                ? UPLOAD_SHAREABLE_ERROR_I18N[code]
                : 'upload.error.generic'
          // Terminal errors get no action; other errors offer a retry.
          const action =
            code === 'self-upload-disabled'
              ? {
                  label: t('upload.selfUploadDisabled.cta'),
                  onClick: () => navigate('/sign-in'),
                }
              : isTerminalUploadError(code)
                ? undefined
                : {
                    label: t('upload.retry'),
                    onClick: () => void upload(files),
                  }
          toast.error(t(key), { id: toastId, ...(action && { action }) })
          setUpgradeRequest(failure.upgradeRequest)
          return
        }

        const data = (await res.json()) as {
          id: string
          shareUrl: string
        }
        toast.success(t('upload.toast.uploaded'), { id: toastId })

        onOpenChange(false)
        dispatch({ type: 'grants-cleared' })
        revalidator.revalidate()
        navigate(`/a/${data.id}`, {
          state: { galleryReturnTo: uploadReturnTo(location) },
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed', {
          id: toastId,
          action: {
            label: t('upload.retry'),
            onClick: () => void upload(files),
          },
        })
      } finally {
        dispatch({ type: 'uploading-changed', uploading: false })
      }
    },
    [
      navigate,
      onOpenChange,
      revalidator,
      currentState.grantEmails,
      currentState.grantInput,
      currentState.visibility,
      destination,
      linkSharingAvailable,
      location,
      t,
      user,
      slackNotifyDisabled,
    ],
  )

  const commitGrantInput = () =>
    dispatch({ type: 'grant-input-committed', user })

  const handleFiles = (files: FileList | File[]) => {
    const list = filterUploadFiles(Array.from(files))
    if (list.length === 0) {
      toast.error(t('upload.error.missingFile'))
      return
    }
    void upload(list)
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) handleFiles(event.currentTarget.files)
    event.currentTarget.value = ''
  }

  const setDirectoryInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      directoryInputRef.current = element
      configureDirectoryInput(element)
    },
    [],
  )

  const projectShareDefaults = destination?.shareDefaults ?? []
  const externalPosting = destination?.externalPosting ?? null
  const showSlackNotification = shouldShowSlackNotification(
    destination?.hasSlackChannel,
    currentState.visibility,
    Boolean(externalPosting),
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={uploadDialogContentClassName}>
        <DialogHeader>
          <DialogTitle>{t('upload.hero.title')}</DialogTitle>
          <DialogDescription>{t('upload.hero.subtitle')}</DialogDescription>
        </DialogHeader>

        <UploadDestination
          destination={destination}
          homeDestinationLabel={homeDestinationLabel}
        />

        <UploadUpgradeRequest request={upgradeRequest} />

        <UploadDropzone
          dragOver={currentState.dragOver}
          disabled={currentState.uploading}
          label={t('upload.drop.label')}
          help={t('upload.drop.help')}
          bundleHelp={t('upload.drop.bundleHelp')}
          onOpenPicker={() => inputRef.current?.click()}
          onDragOverChange={(dragOver) =>
            dispatch({ type: 'drag-over-changed', dragOver })
          }
          onFiles={handleFiles}
          onDropError={() => toast.error(t('upload.error.dropReadFailed'))}
        />

        <UploadFileInputs
          inputRef={inputRef}
          setDirectoryInputRef={setDirectoryInputRef}
          onChange={handleInputChange}
        />

        <div className={uploadPickersClassName}>
          <button
            type="button"
            className={uploadPickerButtonClassName}
            disabled={currentState.uploading}
            onClick={() => directoryInputRef.current?.click()}
          >
            <IconFolderOpen aria-hidden="true" />
            <span>{t('upload.pick.folder')}</span>
          </button>
        </div>

        {!externalPosting ? (
          <UploadVisibilitySelector
            label={t('upload.visibility.label')}
            visibility={currentState.visibility}
            workspaceHd={workspaceHd}
            availableVisibilities={availableVisibilities}
            t={t}
            onSelect={(visibility) =>
              dispatch({ type: 'visibility-selected', visibility })
            }
          />
        ) : null}
        {showSlackNotification ? (
          <SlackNotificationPreference
            disabled={slackNotifyDisabled}
            channelName={destination?.slackChannelName ?? ''}
            onDisabledChange={setSlackNotifyDisabled}
          />
        ) : null}
        {currentState.visibility === 'link' && !linkSharingAvailable ? (
          <p className="text-warning text-sm">
            {t('upload.visibility.link.unavailable')}
          </p>
        ) : null}
        {destination && externalPosting ? (
          <ExternalUploadNote
            audienceCount={externalPosting.audienceCount}
            externalCount={externalPosting.externalCount}
            workspaceName={externalPosting.workspaceName}
            baseVisibility={destination.baseVisibility ?? 'workspace'}
          />
        ) : destination &&
          currentState.visibility === 'project' &&
          projectShareDefaults.length > 0 ? (
          <UploadProjectAudience
            defaults={projectShareDefaults}
            baseVisibility={destination.baseVisibility ?? 'workspace'}
          />
        ) : null}
        {currentState.visibility === 'private' && !externalPosting ? (
          <UploadInitialGrants
            grantInput={currentState.grantInput}
            grantEmails={currentState.grantEmails}
            uploading={currentState.uploading}
            user={user}
            t={t}
            onGrantInputChange={(value) =>
              dispatch({ type: 'grant-input-changed', value })
            }
            onCommitGrantInput={commitGrantInput}
            onRemoveGrantEmail={(email) =>
              dispatch({ type: 'grant-email-removed', email })
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function UploadFileInputs({
  inputRef,
  setDirectoryInputRef,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  setDirectoryInputRef: (element: HTMLInputElement | null) => void
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  const { t } = useT()
  return (
    <>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        aria-label={t('picker.title')}
        accept={ACCEPTED_FILE_UPLOAD_TYPES}
        onChange={onChange}
      />
      <input
        ref={setDirectoryInputRef}
        className="hidden"
        type="file"
        aria-label={t('upload.pick.folder')}
        multiple
        accept={ACCEPTED_SITE_UPLOAD_TYPES}
        onChange={onChange}
      />
    </>
  )
}

function UploadUpgradeRequest({
  request,
}: {
  request: UpgradeRequestView | null
}) {
  const { t } = useT()
  return request ? (
    <UpgradeRequestPanel
      request={request}
      existingErrorLine={t('upload.error.quotaExceeded')}
    />
  ) : null
}

function SlackNotificationPreference({
  disabled,
  channelName,
  onDisabledChange,
}: {
  disabled: boolean
  channelName: string
  onDisabledChange: (disabled: boolean) => void
}) {
  const { t } = useT()

  return (
    <Field orientation="horizontal">
      <FieldLabel>
        <input
          type="checkbox"
          aria-label={t('upload.slackNotify.optOut')}
          checked={disabled}
          onChange={(event) => onDisabledChange(event.target.checked)}
        />
        <FieldContent>
          <span className="text-sm font-medium">
            {t('upload.slackNotify.optOut')}
          </span>
          <FieldDescription>
            {t('upload.slackNotify.description', { channel: channelName })}
          </FieldDescription>
        </FieldContent>
      </FieldLabel>
    </Field>
  )
}

function UploadDestination({
  destination,
  homeDestinationLabel,
}: {
  destination: UploadArtifactDialogProps['destination']
  homeDestinationLabel: string
}) {
  const { t } = useT()

  return (
    <div className={uploadDestinationClassName}>
      <span className={uploadDestinationLabelClassName}>
        {destination
          ? t('upload.destination.project')
          : t('upload.destination.home')}
      </span>
      <strong className={uploadDestinationBadgeClassName}>
        {destination ? (
          <Layers
            className={uploadDestinationIconClassName}
            size={16}
            aria-hidden="true"
          />
        ) : null}
        <span className={uploadDestinationNameClassName}>
          {destination?.label ?? homeDestinationLabel}
        </span>
      </strong>
    </div>
  )
}

function ExternalUploadNote({
  audienceCount,
  externalCount,
  workspaceName = null,
  baseVisibility,
}: {
  audienceCount: number
  externalCount: number
  workspaceName?: string | null
  baseVisibility: ProjectBaseVisibility
}) {
  const { t } = useT()

  return (
    <section className={uploadProjectDefaultsClassName}>
      <p className={uploadProjectDefaultsCopyClassName}>
        {t('upload.external.savedNote')}
      </p>
      {baseVisibility === 'workspace' && workspaceName ? (
        <p className={uploadProjectDefaultsCopyClassName}>
          {t('upload.external.workspaceNote', { workspace: workspaceName })}
        </p>
      ) : null}
      <p className={uploadProjectDefaultsCopyClassName}>
        {externalCount > 0
          ? t('upload.external.audienceWithExternal', {
              count: audienceCount,
              external: externalCount,
            })
          : t('upload.external.audience', { count: audienceCount })}
      </p>
      <p className={uploadProjectDefaultsCopyClassName}>
        {t('upload.external.selfNote')}
      </p>
    </section>
  )
}

function UploadProjectAudience({
  defaults,
  baseVisibility,
}: {
  defaults: ReadonlyArray<ProjectUploadShareDefault>
  baseVisibility: ProjectBaseVisibility
}) {
  const { t } = useT()
  const externalCount = defaults.filter((entry) => entry.isExternal).length
  // 社内全員のプロジェクトは社内全員＋関係者、関係者のみは関係者だけが閲覧できる。
  const description =
    baseVisibility === 'workspace'
      ? t('projectShareDefaults.uploadDescriptionWorkspace')
      : t('projectShareDefaults.uploadDescription')

  return (
    <section className={uploadProjectDefaultsClassName}>
      <div className={uploadProjectDefaultsHeadClassName}>
        <strong className={uploadProjectDefaultsTitleClassName}>
          {t('projectShareDefaults.uploadTitle')}
        </strong>
        <span className={uploadProjectDefaultsMetaClassName}>
          {t('projectShareDefaults.uploadCount', { count: defaults.length })}
        </span>
      </div>
      <p className={uploadProjectDefaultsCopyClassName}>{description}</p>
      {externalCount > 0 ? (
        <p className={uploadProjectDefaultsCopyClassName}>
          {t('projectShareDefaults.uploadExternal', { count: externalCount })}
        </p>
      ) : null}
      <ul className={uploadProjectDefaultsListClassName}>
        {defaults.map((entry) => (
          <li key={entry.id}>
            <span className={uploadProjectDefaultsEmailClassName}>
              {entry.email}
            </span>
            {entry.isExternal ? (
              <small className={uploadProjectDefaultsExternalClassName}>
                {t('projectShareDefaults.external')}
              </small>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function isTerminalUploadError(code: string | undefined): boolean {
  return isUploadShareableErrorCode(code) && TERMINAL_UPLOAD_ERRORS.has(code)
}
