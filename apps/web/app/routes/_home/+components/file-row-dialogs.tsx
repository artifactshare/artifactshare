import { useEffect, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useT } from '~/hooks/use-t'
import { displayTitle } from '~/lib/display-title'
import type {
  EditableVisibility,
  ProjectBaseVisibility,
  Visibility,
} from '~/lib/shareable-types'
import type { GrantEntry } from '~/services/shareables.server'
import { MoveShareableDialog } from '../../a.$id/+components/move-shareable-dialog'
import { RemoveConfirmDialog } from '../../a.$id/+components/remove-confirm-dialog'
import { VisibilityDialog } from '../../a.$id/+components/visibility-dialog'
import type { FileRowData } from './file-data'

export type FileRowAction = 'rename' | 'move' | 'visibility' | 'remove'

export interface ActiveFileAction {
  action: FileRowAction
  file: FileRowData
}

export function useFileRowActions() {
  const [active, setActive] = useState<ActiveFileAction | null>(null)
  return {
    active,
    open: (action: FileRowAction, file: FileRowData) =>
      setActive({ action, file }),
    close: () => setActive(null),
  }
}

interface SharingContext {
  visibility: Visibility
  availableVisibilities: EditableVisibility[]
  grants: GrantEntry[]
  workspaceHd: string | null
  projectBaseVisibility: ProjectBaseVisibility | null
  linkSharingAvailable: boolean
  linkExpiresAt: string | null
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
  linkExpired: boolean
}

// 一覧行の ⋯ メニューから開く 4 ダイアログ。viewer の既存ダイアログを再利用し、
// 実行 API も viewer と同じ経路 (PATCH /api/shareables/:id、DELETE /api/artifacts/:id、
// /api/shareables/:id/move) を使う。成功後は revalidate で一覧を更新する。
export function FileRowDialogs({
  active,
  onClose,
}: {
  active: ActiveFileAction | null
  onClose: () => void
}) {
  if (!active) return null
  const { action, file } = active
  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }
  if (action === 'rename') {
    return <RenameDialog file={file} onOpenChange={handleOpenChange} />
  }
  if (action === 'move') {
    return <ListMoveDialog file={file} onOpenChange={handleOpenChange} />
  }
  if (action === 'visibility') {
    return (
      <ListVisibilityDialog
        key={file.id}
        file={file}
        onOpenChange={handleOpenChange}
      />
    )
  }
  return <ListRemoveDialog file={file} onOpenChange={handleOpenChange} />
}

function RenameDialog({
  file,
  onOpenChange,
}: {
  file: FileRowData
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const [value, setValue] = useState(
    file.titleOverride ?? file.derivedTitle ?? '',
  )
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    setSubmitting(true)
    try {
      const trimmed = value.trim()
      const response = await fetch(`/api/shareables/${file.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titleOverride: trimmed === '' ? null : trimmed,
        }),
      })
      if (!response.ok) {
        toast.error(t('toast.renameFailed'))
        return
      }
      revalidator.revalidate()
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('menu.rename')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t('vw.titleEditPlaceholder')}
            aria-label={t('vw.editTitleInputLabel')}
          />
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('confirm.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {t('visibilityDialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ListMoveDialog({
  file,
  onOpenChange,
}: {
  file: FileRowData
  onOpenChange: (open: boolean) => void
}) {
  const revalidator = useRevalidator()
  return (
    <MoveShareableDialog
      open
      onOpenChange={onOpenChange}
      shareableId={file.id}
      shareableTitle={displayTitle({
        name: file.fileName,
        derivedTitle: file.derivedTitle,
        titleOverride: file.titleOverride,
      })}
      homeOwnerName={file.ownerName ?? file.ownerEmail ?? ''}
      isProjectAudience={file.visibility === 'project'}
      onMoved={() => revalidator.revalidate()}
    />
  )
}

function ListVisibilityDialog({
  file,
  onOpenChange,
}: {
  file: FileRowData
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useT()
  // 共有範囲ダイアログの値は一覧 loader に積まず、開いたとき owner 限定の
  // resource route から遅延取得する (grants を非オーナーに配らない)。
  const contextFetcher = useFetcher<SharingContext>()
  const load = contextFetcher.load
  const fetcherState = contextFetcher.state
  const fetcherData = contextFetcher.data
  const endpoint = `/api/artifacts/${encodeURIComponent(file.id)}/sharing-context`
  const [started, setStarted] = useState(false)
  useEffect(() => {
    void load(endpoint)
  }, [endpoint, load])
  // 「load が実際に走ったか」を render 中の遷移検知で記録する (loading を見る前に
  // idle を失敗と誤認しない)
  if (fetcherState === 'loading' && !started) setStarted(true)
  // 読込失敗で null を返し続けると action が選択されたまま固まるため、
  // 失敗を検知したらエラーダイアログに切り替える (閉じる / 再試行)
  const failed = started && fetcherState === 'idle' && fetcherData == null
  if (failed) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-modal="true" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('vw.changeVisibility')}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            {t('toast.sharingContextFailed')}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('confirm.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setStarted(false)
                void load(endpoint)
              }}
            >
              {t('dialog.retry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  const context = fetcherData ?? null
  if (!context) return null
  return (
    <VisibilityDialog
      open
      onOpenChange={onOpenChange}
      shareableId={file.id}
      currentVisibility={context.visibility}
      availableVisibilities={context.availableVisibilities}
      workspaceHd={context.workspaceHd}
      projectBaseVisibility={context.projectBaseVisibility}
      owner={{
        id: file.ownerId,
        email: file.ownerEmail,
        name: file.ownerName,
        image: file.ownerImage,
        initial: file.ownerInitial,
      }}
      grants={context.grants}
      linkSharingAvailable={context.linkSharingAvailable}
      linkExpiresAt={context.linkExpiresAt}
      linkExpiryDefaultDays={context.linkExpiryDefaultDays}
      linkExpiryMaxDays={context.linkExpiryMaxDays}
      linkExpired={context.linkExpired}
    />
  )
}

function ListRemoveDialog({
  file,
  onOpenChange,
}: {
  file: FileRowData
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useT()
  const revalidator = useRevalidator()
  return (
    <RemoveConfirmDialog
      open
      onOpenChange={onOpenChange}
      onConfirm={() => {
        void (async () => {
          const response = await fetch(`/api/artifacts/${file.id}`, {
            method: 'DELETE',
          })
          if (!response.ok) {
            toast.error(t('toast.removeFailed'))
            return
          }
          toast(t('toast.removed'))
          revalidator.revalidate()
        })()
        onOpenChange(false)
      }}
    />
  )
}
