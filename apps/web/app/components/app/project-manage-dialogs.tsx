import { useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import {
  UpgradeRequestPanel,
  type UpgradeRequestView,
} from './upgrade-request-panel'

type ProjectAction = 'archive' | 'unarchive' | 'delete'

async function postProjectAction(
  projectId: string,
  action: ProjectAction,
): Promise<
  | { ok: true }
  | {
      ok: false
      status: number
      code?: string
      limit?: number
      holderName?: string
      upgradeRequest?: UpgradeRequestView
    }
> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: {
          code?: string
          message?: string
          details?: {
            holder_name?: string | null
            upgrade_request?: UpgradeRequestView
          }
        }
      } | null
      const code = body?.error?.code
      const limitMatch = body?.error?.message?.match(/\((\d+) projects?\)/)
      const holderName = body?.error?.details?.holder_name
      return {
        ok: false,
        status: res.status,
        code,
        limit: limitMatch ? Number(limitMatch[1]) : undefined,
        holderName: typeof holderName === 'string' ? holderName : undefined,
        upgradeRequest: body?.error?.details?.upgrade_request,
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, status: 0 }
  }
}

interface UnarchiveProjectButtonProps {
  projectId: string
  projectName: string
  onSuccess: () => void
  children: React.ReactNode
}

// Restoring is reversible, so it acts immediately without a confirm step.
export function UnarchiveProjectButton({
  projectId,
  projectName,
  onSuccess,
  children,
}: UnarchiveProjectButtonProps) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [upgradeRequest, setUpgradeRequest] =
    useState<UpgradeRequestView | null>(null)
  const [upgradeLimit, setUpgradeLimit] = useState<number | null>(null)

  const run = async () => {
    setBusy(true)
    setUpgradeRequest(null)
    setUpgradeLimit(null)
    const result = await postProjectAction(projectId, 'unarchive')
    setBusy(false)
    if (result.ok) {
      toast.success(t('toast.projectRestored', { name: projectName }))
      onSuccess()
    } else if (result.code === 'project-limit-reached' && result.limit) {
      if (result.upgradeRequest) {
        setUpgradeRequest(result.upgradeRequest)
        setUpgradeLimit(result.limit)
      } else {
        toast.error(t('toast.projectLimitReached', { limit: result.limit }))
      }
    } else {
      toast.error(t('toast.projectActionFailed'))
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void run()}
      >
        {children}
      </Button>
      {upgradeRequest && upgradeLimit ? (
        <UpgradeRequestPanel
          request={upgradeRequest}
          existingErrorLine={t('toast.projectLimitReached', {
            limit: upgradeLimit,
          })}
        />
      ) : null}
    </div>
  )
}

interface ArchiveProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
  // Refresh the view after success (navigate away, or revalidate the list).
  onSuccess: () => void
}

export function ArchiveProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onSuccess,
}: ArchiveProjectDialogProps) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)

  // preventDefault keeps the dialog open while the request is in flight, so the
  // busy state guards against a double submit and the parent's onSuccess (which
  // navigates or revalidates) is what tears the dialog down on success.
  const confirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setBusy(true)
    const result = await postProjectAction(projectId, 'archive')
    setBusy(false)
    if (result.ok) {
      toast.success(t('toast.projectArchived', { name: projectName }))
      onSuccess()
    } else {
      toast.error(t('toast.projectActionFailed'))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('projectArchive.confirmTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('projectArchive.confirmBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t('projectArchive.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => void confirm(event)}
            disabled={busy}
          >
            {t('projectArchive.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface DeleteProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
  // Whether the viewer sees the project as empty. The server still re-checks
  // every file regardless of visibility before deleting.
  isEmpty: boolean
  onSuccess: () => void
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  isEmpty,
  onSuccess,
}: DeleteProjectDialogProps) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)

  if (!isEmpty) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projectArchive.notEmptyTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projectArchive.notEmptyBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('projectArchive.close')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  // preventDefault keeps the dialog open during the request (see ArchiveProjectDialog).
  const confirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setBusy(true)
    const result = await postProjectAction(projectId, 'delete')
    setBusy(false)
    if (result.ok) {
      toast.success(t('toast.projectDeleted', { name: projectName }))
      onSuccess()
    } else if (result.code === 'project-has-agent-credentials') {
      // A live agent CLI credential still targets this project; its holder
      // must revoke or stop it before the project can be deleted.
      toast.error(
        result.holderName
          ? t('toast.projectHasAgentCredentials', { holder: result.holderName })
          : t('toast.projectHasAgentCredentialsUnknownHolder'),
      )
    } else if (result.status === 409) {
      // A file slipped in (or was hidden from this viewer): not actually empty.
      toast.error(t('toast.projectNotEmpty'))
    } else {
      toast.error(t('toast.projectActionFailed'))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('projectArchive.deleteTitle', { name: projectName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('projectArchive.deleteBody', { name: projectName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={busy}>
            {t('projectArchive.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => void confirm(event)}
            disabled={busy}
            className="bg-destructive hover:bg-destructive/90 text-white"
          >
            {t('projectArchive.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
