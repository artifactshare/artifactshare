import { useState } from 'react'
import { useFetcher } from 'react-router'
import { ConfirmActionDialog } from './confirm-action-dialog'
import { BotBadge } from '~/components/app/user-kind-badge'
import { TeamMuted } from '~/components/form/team-muted'
import { SettingsSection } from '~/components/form/settings-section'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { writeClipboardText } from '~/lib/clipboard'
import type { TKey } from '~/i18n/messages'
import type { WorkspaceBotRow } from '~/services/bot-members.server'

export type BotProjectOption = { id: string; name: string }

type BotActionResponse = {
  ok?: boolean
  botUserId?: string
  email?: string
  token?: string
  error?: { code?: string }
}

const ERROR_KEYS: Record<string, TKey> = {
  'bot-name-invalid': 'team.bots.error.bot-name-invalid',
  'bot-destination-invalid': 'team.bots.error.bot-destination-invalid',
  'bot-limit-reached': 'team.bots.error.bot-limit-reached',
  'bot-conflict': 'team.bots.error.bot-conflict',
  'bot-stopped': 'team.bots.error.bot-stopped',
  'feature-not-available': 'team.bots.error.feature-not-available',
  forbidden: 'team.bots.error.forbidden',
}

export function botStatus(
  bot: Pick<WorkspaceBotRow, 'botStoppedAt' | 'credentialLive'>,
): 'stopped' | 'expired' | 'active' {
  // Single badge, priority: stopped > expired > active.
  if (bot.botStoppedAt !== null) return 'stopped'
  if (!bot.credentialLive) return 'expired'
  return 'active'
}

export function BotSection({
  bots,
  projects,
  canCreate,
}: {
  bots: WorkspaceBotRow[]
  projects: BotProjectOption[]
  canCreate: boolean
}) {
  const { t, locale } = useT()
  const [createOpen, setCreateOpen] = useState(false)
  const [stopTarget, setStopTarget] = useState<WorkspaceBotRow | null>(null)
  const [reissueTarget, setReissueTarget] = useState<WorkspaceBotRow | null>(
    null,
  )
  const stopFetcher = useFetcher<BotActionResponse>()
  const reissueFetcher = useFetcher<BotActionResponse>()
  // Derived, not synced: the token dialog shows whenever the fetcher holds a
  // token the admin has not dismissed yet.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null)
  const reissueToken =
    reissueFetcher.state === 'idle' &&
    reissueFetcher.data?.token &&
    reissueFetcher.data.token !== dismissedToken
      ? reissueFetcher.data.token
      : null

  return (
    <SettingsSection title={t('team.bots')} description={t('team.bots.body')}>
      {canCreate ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            {t('team.bots.add')}
          </Button>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('team.bots.name')}</TableHead>
            <TableHead>{t('team.bots.destination')}</TableHead>
            <TableHead>{t('team.bots.lastAuth')}</TableHead>
            <TableHead>{t('team.members.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bots.length === 0 ? (
            <TableEmptyRow colSpan={4}>{t('team.bots.empty')}</TableEmptyRow>
          ) : (
            bots.map((bot) => {
              const status = botStatus(bot)
              return (
                <TableRow key={bot.id} data-testid="bot-row">
                  <TableCell>
                    <div className="flex flex-col gap-[var(--spacing-1)]">
                      <span className="flex items-center gap-[var(--spacing-2)]">
                        {bot.name}
                        <BotBadge />
                        <BotStatusBadge status={status} />
                      </span>
                      <CopyableEmail email={bot.email} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <BotDestination bot={bot} />
                  </TableCell>
                  <TableCell>
                    <TeamMuted>
                      {bot.lastAuthAt
                        ? formatRelative(bot.lastAuthAt, locale)
                        : '—'}
                    </TeamMuted>
                  </TableCell>
                  <TableCell>
                    {status !== 'stopped' ? (
                      <div className="flex gap-[var(--spacing-2)]">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setReissueTarget(bot)}
                        >
                          {t('team.bots.reissue')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => setStopTarget(bot)}
                        >
                          {t('team.bots.stop')}
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      {canCreate ? (
        <BotCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projects={projects}
        />
      ) : null}

      <ConfirmActionDialog
        open={stopTarget !== null}
        onOpenChange={(open) => {
          if (!open) setStopTarget(null)
        }}
        onConfirm={() => {
          if (!stopTarget) return
          stopFetcher.submit(
            { intent: 'stop', botUserId: stopTarget.id },
            {
              method: 'post',
              action: '/settings/bots',
              encType: 'application/json',
            },
          )
          setStopTarget(null)
        }}
        title={t('team.bots.stopConfirm.title', {
          name: stopTarget?.name ?? '',
        })}
        description={t('team.bots.stopConfirm.body')}
        action={t('team.bots.stopConfirm.action')}
        pending={stopFetcher.state !== 'idle'}
      />

      <ConfirmActionDialog
        open={reissueTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReissueTarget(null)
        }}
        onConfirm={() => {
          if (!reissueTarget) return
          reissueFetcher.submit(
            { intent: 'reissue', botUserId: reissueTarget.id },
            {
              method: 'post',
              action: '/settings/bots',
              encType: 'application/json',
            },
          )
          setReissueTarget(null)
        }}
        title={t('team.bots.reissueConfirm.title', {
          name: reissueTarget?.name ?? '',
        })}
        description={t('team.bots.reissueConfirm.body')}
        action={t('team.bots.reissueConfirm.action')}
        pending={reissueFetcher.state !== 'idle'}
      />

      {reissueToken ? (
        <BotTokenDialog
          token={reissueToken}
          onClose={() => setDismissedToken(reissueToken)}
        />
      ) : null}
      <FetcherError fetcher={stopFetcher} />
      <FetcherError fetcher={reissueFetcher} />
    </SettingsSection>
  )
}

function BotDestination({ bot }: { bot: WorkspaceBotRow }) {
  const { t } = useT()
  // Live project name (follows renames); snapshot + deleted marker after the
  // destination project is gone. The bot row itself stays listed.
  if (bot.projectName) return <span>{bot.projectName}</span>
  if (bot.projectNameSnapshot) {
    return (
      <TeamMuted>
        {t('team.bots.destinationDeleted', { name: bot.projectNameSnapshot })}
      </TeamMuted>
    )
  }
  return <TeamMuted>—</TeamMuted>
}

function BotStatusBadge({
  status,
}: {
  status: 'stopped' | 'expired' | 'active'
}) {
  const { t } = useT()
  if (status === 'stopped') {
    return <Badge variant="muted">{t('team.bots.status.stopped')}</Badge>
  }
  if (status === 'expired') {
    return <Badge variant="warning">{t('team.bots.status.expired')}</Badge>
  }
  return <Badge variant="success">{t('team.bots.status.active')}</Badge>
}

function CopyableEmail({ email }: { email: string }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="text-muted-foreground w-fit text-left text-xs hover:underline"
      title={t('team.bots.copyEmail')}
      onClick={() => {
        void writeClipboardText(email).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? t('team.bots.emailCopied') : email}
    </button>
  )
}

function FetcherError({
  fetcher,
}: {
  fetcher: { state: string; data?: BotActionResponse }
}) {
  const { t } = useT()
  if (fetcher.state !== 'idle') return null
  const code = fetcher.data?.error?.code
  if (!code) return null
  const key = ERROR_KEYS[code] ?? 'team.bots.error.generic'
  return (
    <p role="alert" className="text-destructive text-sm">
      {t(key)}
    </p>
  )
}

function BotCreateDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: BotProjectOption[]
}) {
  const { t } = useT()
  const fetcher = useFetcher<BotActionResponse>()
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState('')
  const [dismissedToken, setDismissedToken] = useState<string | null>(null)
  // Derived: once the action returns a token, the form dialog yields to the
  // one-time token dialog until the admin confirms storage.
  const token =
    fetcher.state === 'idle' &&
    fetcher.data?.token &&
    fetcher.data.token !== dismissedToken
      ? fetcher.data.token
      : null

  const pending = fetcher.state !== 'idle'
  return (
    <>
      <Dialog open={open && !token} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('team.bots.add.title')}</DialogTitle>
            <DialogDescription>
              {t('team.bots.add.destinationHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-[var(--spacing-4)]">
            <Field>
              <FieldLabel htmlFor="bot-name">
                {t('team.bots.add.nameLabel')}
              </FieldLabel>
              <Input
                id="bot-name"
                value={name}
                maxLength={30}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="bot-destination">
                {t('team.bots.add.destinationLabel')}
              </FieldLabel>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="bot-destination">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <FetcherError fetcher={fetcher} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={pending || !name.trim() || !projectId}
              onClick={() =>
                fetcher.submit(
                  { intent: 'create', name, projectId },
                  {
                    method: 'post',
                    action: '/settings/bots',
                    encType: 'application/json',
                  },
                )
              }
            >
              {t('team.bots.add.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {token ? (
        <BotTokenDialog
          token={token}
          onClose={() => {
            setDismissedToken(token)
            setName('')
            setProjectId('')
            onOpenChange(false)
          }}
        />
      ) : null}
    </>
  )
}

export function BotTokenDialog({
  token,
  onClose,
}: {
  token: string
  onClose: () => void
}) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [stored, setStored] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // The copy confirmation gates closing: the token is shown exactly
        // once, so an accidental dismiss must not lose it.
        if (!open && stored) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('team.bots.token.title')}</DialogTitle>
          <DialogDescription>{t('team.bots.token.body')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-[var(--spacing-3)]">
          <code
            data-testid="bot-token"
            className="bg-muted rounded-md p-[var(--spacing-3)] text-xs break-all"
          >
            {token}
          </code>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // A false "Copied" here loses the one-time token for good: the
              // admin ticks the checkbox and closes. Only confirm real writes.
              void writeClipboardText(token).then((ok) => setCopied(ok))
            }}
          >
            {copied ? t('team.bots.token.copied') : t('team.bots.token.copy')}
          </Button>
          <TeamMuted>{t('team.bots.token.boundary')}</TeamMuted>
          <TeamMuted>{t('team.bots.token.expiry')}</TeamMuted>
          <TeamMuted>{t('team.bots.token.stdin')}</TeamMuted>
          <label className="flex items-center gap-[var(--spacing-2)] text-sm">
            <input
              type="checkbox"
              checked={stored}
              onChange={(event) => setStored(event.target.checked)}
            />
            {t('team.bots.token.confirm')}
          </label>
        </div>
        <DialogFooter>
          <Button type="button" disabled={!stored} onClick={onClose}>
            {t('team.bots.token.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
