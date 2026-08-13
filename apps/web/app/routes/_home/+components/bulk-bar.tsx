import { useEffect, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import { toast } from 'sonner'
import { IconCheck, IconHome, IconStack2 as Layers } from '@tabler/icons-react'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { dialogNoteWarnClassName } from '../../a.$id/+components/dialog-note-styles'
import {
  INBOX_VALUE,
  isMoveDestinations,
} from '../../a.$id/+components/move-shareable-dialog-state'
import {
  BULK_ACTION_LIMIT,
  type BulkResult,
  type useBulkActions,
} from '../+hooks/use-bulk-actions'
import type { FileRowData } from './file-data'

type Bulk = ReturnType<typeof useBulkActions>

// 一括操作バー: 1 件以上の選択で画面下に出る。実行は 1 件ずつ順次 API を呼び、
// 401/403 で残件を中止する (use-bulk-actions)。UI は `max-wide` で出さない
// (hover 前提のため。⋯ の単発操作で代替)。
interface BulkBarProps {
  bulk: Bulk
  files: FileRowData[]
  homeOwnerName: string
}

// 選択 0 件では hook ごと動かさない (useRevalidator は data router 必須のため、
// 静的レンダのテストでも安全になる)。
export function BulkBar(props: BulkBarProps) {
  if (props.bulk.selected.length === 0) return null
  return <BulkBarContent {...props} />
}

function BulkBarContent({ bulk, files, homeOwnerName }: BulkBarProps) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const [dialog, setDialog] = useState<'move' | 'remove' | null>(null)
  const overLimit = bulk.selected.length > BULK_ACTION_LIMIT
  const titleOf = (id: string) => {
    const file = files.find((f) => f.id === id)
    return file?.titleOverride ?? file?.derivedTitle ?? file?.fileName ?? id
  }
  const reportResult = (
    key: 'bulk.movedResult' | 'bulk.removedResult',
    result: BulkResult,
  ) => {
    const total = result.succeeded.length + result.failed.length
    const message = t(key, {
      total: String(total),
      ok: String(result.succeeded.length),
    })
    if (result.failed.length === 0) {
      toast.success(message)
    } else {
      toast.error(
        `${message} ${t('bulk.failedFiles', {
          names: result.failed.slice(0, 3).map(titleOf).join(', '),
        })}`,
      )
    }
    revalidator.revalidate()
  }
  return (
    <>
      <div className="max-wide:hidden bg-popover text-popover-foreground ring-foreground/10 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-2 text-sm shadow-md ring-1">
        <span className="font-medium">
          {t('bulk.selected', { n: String(bulk.selected.length) })}
        </span>
        {overLimit ? (
          <span className="text-destructive">{t('bulk.limit')}</span>
        ) : null}
        <span className="bg-border h-4 w-px" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={bulk.busy || overLimit}
          onClick={() => setDialog('move')}
        >
          {t('vw.move')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={bulk.busy || overLimit}
          onClick={() => setDialog('remove')}
        >
          {t('menu.remove')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={bulk.busy}
          onClick={bulk.clear}
        >
          {t('confirm.cancel')}
        </Button>
      </div>
      {dialog === 'move' ? (
        <BulkMoveDialog
          bulk={bulk}
          files={files}
          homeOwnerName={homeOwnerName}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onDone={(result) => {
            setDialog(null)
            reportResult('bulk.movedResult', result)
          }}
        />
      ) : null}
      {dialog === 'remove' ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('bulk.removeTitle', { n: String(bulk.selected.length) })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('bulk.removeBody')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('confirm.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive hover:bg-destructive/90 text-white"
                onClick={() => {
                  setDialog(null)
                  void bulk
                    .run(
                      bulk.selected,
                      (id) =>
                        fetch(`/api/artifacts/${id}`, { method: 'DELETE' }),
                      // 既に無いファイルの削除は目的を達しているので成功扱い
                      { notFoundIsSuccess: true },
                    )
                    .then((result) =>
                      reportResult('bulk.removedResult', result),
                    )
                }}
              >
                {t('confirm.remove.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  )
}

// 一括移動ピッカー: 既存 move dialog と同じ destinations API (先頭の選択 id で
// 取得) を使ったホーム + プロジェクトのラジオ選択。移動先は 1 つなので社外警告も
// 集約 1 行にする。
function BulkMoveDialog({
  bulk,
  files,
  homeOwnerName,
  onOpenChange,
  onDone,
}: {
  bulk: Bulk
  files: FileRowData[]
  homeOwnerName: string
  onOpenChange: (open: boolean) => void
  onDone: (result: BulkResult) => void
}) {
  const { t } = useT()
  const destinationsFetcher = useFetcher()
  const load = destinationsFetcher.load
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // 移動先候補は先頭の選択 id の destinations API から取る。オーナー行のみ選択できる
  // ため候補は同一だが、行ごとの現在地 (isCurrent) が違っても実行はサーバが検証する
  const firstId = bulk.selected[0]
  useEffect(() => {
    void load(`/api/shareables/${encodeURIComponent(firstId)}/move`)
  }, [firstId, load])
  const destinations = isMoveDestinations(destinationsFetcher.data)
    ? destinationsFetcher.data
    : null
  const homeLabel = homeOwnerName
    ? t('project.homeTitle', { name: homeOwnerName })
    : t('move.inbox')
  // 選択が全件同じ場所にあるときだけ、その場所を移動先から外す (全件 no-op を
  // 「移動しました」と報告しない)。場所が混在するときは部分 no-op を許容する
  const containerKeys = new Set(
    bulk.selected.map((id) => {
      const file = files.find((f) => f.id === id)
      return file?.projectId ?? INBOX_VALUE
    }),
  )
  const uniformContainer = containerKeys.size === 1
  const selectedProject = destinations?.projects.find(
    (project) => project.containerId === selected,
  )
  const externalCount = selectedProject?.externalCount ?? 0
  const submit = async () => {
    if (!selected) return
    setSubmitting(true)
    try {
      const result = await bulk.run(bulk.selected, (id) =>
        fetch(`/api/shareables/${encodeURIComponent(id)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination: selected }),
        }),
      )
      onDone(result)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('move.title')}</DialogTitle>
        </DialogHeader>
        {destinations ? (
          <div
            role="radiogroup"
            aria-label={t('move.title')}
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
          >
            {destinations.inbox !== null ? (
              <BulkMoveOption
                icon={<IconHome size={16} aria-hidden="true" />}
                label={homeLabel}
                selected={selected === INBOX_VALUE}
                disabled={uniformContainer && destinations.inbox.isCurrent}
                onSelect={() => setSelected(INBOX_VALUE)}
              />
            ) : null}
            {destinations.projects.map((project) => (
              <BulkMoveOption
                key={project.containerId}
                icon={
                  <Layers size={16} className="text-link" aria-hidden="true" />
                }
                label={project.name}
                selected={selected === project.containerId}
                disabled={uniformContainer && project.isCurrent}
                onSelect={() => setSelected(project.containerId)}
              />
            ))}
          </div>
        ) : null}
        {externalCount > 0 ? (
          <p className={dialogNoteWarnClassName}>
            {t('bulk.audienceWarn', {
              n: String(bulk.selected.length),
              external: String(externalCount),
            })}
          </p>
        ) : null}
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
            disabled={!selected || submitting || bulk.busy}
            onClick={() => void submit()}
          >
            {t('move.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkMoveOption({
  icon,
  label,
  selected,
  disabled = false,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'hover:bg-accent flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] border-0 bg-transparent px-2 py-1.5 text-left text-sm',
        selected && 'bg-accent',
        disabled &&
          'text-muted-foreground cursor-default opacity-60 hover:bg-transparent',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <IconCheck size={16} aria-hidden="true" /> : null}
    </button>
  )
}
