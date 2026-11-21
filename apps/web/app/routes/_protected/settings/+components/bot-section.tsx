import { useEffect, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import { SettingsBanner } from './settings-banner'
import { ConfirmActionDialog } from './confirm-action-dialog'
import { BotBadge } from '~/components/app/user-kind-badge'
import { TeamMuted, TeamMutedParagraph } from '~/components/form/team-muted'
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
  ProjectCandidatePicker,
  type ProjectCandidateOption,
} from '~/components/app/project-candidate-picker'
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

type BotActionResponse = {
  ok?: boolean
  botUserId?: string
  email?: string
  token?: string
  error?: { code?: string }
}

const REISSUE_ERROR_OVERRIDES: Record<string, TKey> = {
  'bot-destination-invalid': 'team.bots.error.reissue-destination-gone',
  'bot-conflict': 'team.bots.error.reissue-conflict',
}

const ERROR_KEYS: Record<string, TKey> = {
  'bot-name-invalid': 'team.bots.error.bot-name-invalid',
  'bot-destination-invalid': 'team.bots.error.bot-destination-invalid',
  'bot-limit-reached': 'team.bots.error.bot-limit-reached',
  'bot-conflict': 'team.bots.error.bot-conflict',
  'bot-stopped': 'team.bots.error.bot-stopped',
  'bot-used': 'team.bots.error.bot-used',
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
  canCreate,
}: {
  bots: WorkspaceBotRow[]
  canCreate: boolean
}) {
  const { t, locale } = useT()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<WorkspaceBotRow | null>(null)
  const [stopTarget, setStopTarget] = useState<WorkspaceBotRow | null>(null)
  const [cancelTarget, setCancelTarget] = useState<WorkspaceBotRow | null>(null)
  const [reissueTarget, setReissueTarget] = useState<WorkspaceBotRow | null>(
    null,
  )

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
        <TableHeader className="hidden md:table-header-group">
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
                <TableRow
                  key={bot.id}
                  data-testid="bot-row"
                  className="flex min-w-0 flex-col md:table-row"
                >
                  <TableCell className="min-w-0 max-md:w-full max-md:whitespace-normal">
                    <div className="flex flex-col gap-[var(--spacing-1)]">
                      <span className="flex flex-wrap items-center gap-[var(--spacing-2)]">
                        <span className="min-w-0 max-md:max-w-full max-md:[overflow-wrap:anywhere]">
                          {bot.name}
                        </span>
                        <BotBadge />
                        <BotStatusBadge status={status} />
                      </span>
                      <CopyableEmail email={bot.email} />
                      <div className="whitespace-normal md:hidden">
                        <BotDestinations bot={bot} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <BotDestinations bot={bot} />
                  </TableCell>
                  <TableCell className="min-w-0 max-md:w-full max-md:whitespace-normal">
                    <TeamMuted>
                      <span className="md:hidden">
                        {t('team.bots.lastAuth')}:{' '}
                      </span>
                      {bot.lastAuthAt
                        ? formatRelative(bot.lastAuthAt, locale)
                        : '—'}
                    </TeamMuted>
                  </TableCell>
                  <TableCell className="min-w-0 max-md:w-full max-md:whitespace-normal">
                    {status !== 'stopped' || bot.cancelable ? (
                      <div className="flex flex-wrap gap-[var(--spacing-2)]">
                        {status !== 'stopped' ? (
                          <>
                            {bot.destinationsEditable !== false ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                id={`bot-destinations-${bot.id}`}
                                onClick={() => setEditTarget(bot)}
                              >
                                {t('team.bots.editDestinations')}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              id={`bot-reissue-${bot.id}`}
                              onClick={() => setReissueTarget(bot)}
                            >
                              {t('team.bots.reissue')}
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              id={`bot-stop-${bot.id}`}
                              onClick={() => setStopTarget(bot)}
                            >
                              {t('team.bots.stop')}
                            </Button>
                          </>
                        ) : null}
                        {bot.cancelable ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            id={`bot-cancel-${bot.id}`}
                            onClick={() => setCancelTarget(bot)}
                          >
                            {t('team.bots.cancel')}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      {editTarget ? (
        <BotDestinationDialog
          key={editTarget.id}
          bot={editTarget}
          onClose={() => setEditTarget(null)}
        />
      ) : null}
      {canCreate ? (
        <BotCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}

      {cancelTarget ? (
        <BotActionDialog
          key={cancelTarget.id}
          bot={cancelTarget}
          intent="cancel"
          onClose={() => setCancelTarget(null)}
        />
      ) : null}
      {stopTarget ? (
        <BotActionDialog
          key={stopTarget.id}
          bot={stopTarget}
          intent="stop"
          onClose={() => setStopTarget(null)}
        />
      ) : null}
      {reissueTarget ? (
        <BotActionDialog
          key={reissueTarget.id}
          bot={reissueTarget}
          intent="reissue"
          onClose={() => setReissueTarget(null)}
        />
      ) : null}
    </SettingsSection>
  )
}

function BotActionDialog({
  bot,
  intent,
  onClose,
}: {
  bot: WorkspaceBotRow
  intent: 'stop' | 'cancel' | 'reissue'
  onClose: () => void
}) {
  const { t } = useT()
  const fetcher = useFetcher<BotActionResponse>()
  const pending = fetcher.state !== 'idle'
  const complete = !pending && fetcher.data?.ok
  const token = complete ? fetcher.data?.token : undefined
  useEffect(() => {
    if (complete && !token) onClose()
  }, [complete, token, onClose])
  if (token) return <BotTokenDialog token={token} onClose={onClose} />
  return (
    <ConfirmActionDialog
      open
      returnFocusId={`bot-${intent}-${bot.id}`}
      awaitResult
      destructive={intent !== 'reissue'}
      dismissLabel={intent === 'cancel' ? t('team.bots.keep') : undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onConfirm={() => {
        void fetcher.submit(
          { intent, botUserId: bot.id },
          {
            method: 'post',
            action: '/settings/bots',
            encType: 'application/json',
          },
        )
      }}
      title={t(`team.bots.${intent}Confirm.title`, { name: bot.name ?? '' })}
      description={t(`team.bots.${intent}Confirm.body`)}
      action={t(`team.bots.${intent}Confirm.action`)}
      pending={pending}
      pendingLabel={t(`team.bots.${intent}Confirm.pending`)}
      result={
        <FetcherError
          fetcher={fetcher}
          variant={intent === 'reissue' ? 'reissue' : 'create'}
        />
      }
    />
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
      className="text-muted-foreground w-fit max-w-full text-left text-xs [overflow-wrap:anywhere] whitespace-normal hover:underline"
      title={t('team.bots.copyEmail')}
      onClick={() => {
        void writeClipboardText(email)
          .then((ok) => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => undefined)
      }}
    >
      {copied ? t('team.bots.emailCopied') : email}
    </button>
  )
}

function FetcherError({
  fetcher,
  variant = 'create',
  overrides = {},
}: {
  fetcher: { state: string; data?: BotActionResponse }
  // Reissue shares codes with create but needs different copy: the create
  // hints (pick another project / rename) are impossible advice in a dialog
  // with no inputs.
  variant?: 'create' | 'reissue'
  overrides?: Record<string, TKey>
}) {
  const { t } = useT()
  if (fetcher.state !== 'idle') return null
  const code = fetcher.data?.error?.code
  if (!code) return null
  const key =
    overrides[code] ??
    (variant === 'reissue' ? REISSUE_ERROR_OVERRIDES[code] : undefined) ??
    ERROR_KEYS[code] ??
    'team.bots.error.generic'
  return <SettingsBanner kind="error">{t(key)}</SettingsBanner>
}

type SelectedDestination = { id: string; name: string; unavailable?: boolean }

function BotDestinationSelection({
  projects,
  primary,
  onProjectsChange,
  onPrimaryChange,
  pending,
}: {
  projects: SelectedDestination[]
  primary: string
  onProjectsChange: (projects: SelectedDestination[]) => void
  onPrimaryChange: (id: string) => void
  pending: boolean
}) {
  const { t } = useT()
  const [candidate, setCandidate] = useState<ProjectCandidateOption | null>(
    null,
  )
  return (
    <fieldset
      disabled={pending}
      className="flex min-w-0 flex-col gap-[var(--spacing-3)]"
    >
      <legend className="text-sm font-medium">
        {t('team.bots.destination')}
      </legend>
      {projects.length === 0 ? (
        <TeamMutedParagraph>
          {t('team.bots.emptyDestinations')}
        </TeamMutedParagraph>
      ) : null}
      {projects.map((project) => (
        <div
          key={project.id}
          className="flex items-center justify-between gap-[var(--spacing-2)]"
        >
          <label className="flex items-center gap-[var(--spacing-2)]">
            <input
              type="radio"
              name="bot-primary"
              value={project.id}
              checked={primary === project.id}
              disabled={project.unavailable && primary !== project.id}
              onChange={() => onPrimaryChange(project.id)}
            />
            {project.name}{' '}
            {primary === project.id ? `(${t('team.bots.primary')})` : ''}
            {project.unavailable ? ` · ${t('team.bots.unavailable')}` : ''}
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('team.bots.removeDestinationLabel', {
              name: project.name,
            })}
            disabled={projects.length === 1 || primary === project.id}
            onClick={() =>
              onProjectsChange(projects.filter((p) => p.id !== project.id))
            }
          >
            {t('team.bots.removeDestination')}
          </Button>
        </div>
      ))}
      <Field>
        <FieldLabel id="bot-add-destination-label">
          {t('team.bots.add.destinationLabel')}
        </FieldLabel>
        <ProjectCandidatePicker
          id="bot-add-destination"
          ariaLabelledBy="bot-add-destination-label"
          purpose="bot-destination"
          excludedProjectIds={projects.map((project) => project.id)}
          value={candidate}
          onChange={setCandidate}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!candidate || projects.some((p) => p.id === candidate.id)}
          onClick={() => {
            if (!candidate) return
            onProjectsChange([...projects, candidate])
            if (!primary) onPrimaryChange(candidate.id)
            setCandidate(null)
          }}
        >
          {t('team.bots.addDestination')}
        </Button>
      </Field>
      {projects.length > 0 ? (
        <TeamMutedParagraph>{t('team.bots.primaryHint')}</TeamMutedParagraph>
      ) : null}
    </fieldset>
  )
}

function BotDestinations({ bot }: { bot: WorkspaceBotRow }) {
  const { t } = useT()
  return (
    <>
      {bot.approvedProjects?.length ? (
        bot.approvedProjects.map((project) => (
          <div key={project.id}>
            {project.name}
            {project.id === bot.projectId ? ` · ${t('team.bots.primary')}` : ''}
            {project.unavailable ? ` · ${t('team.bots.unavailable')}` : ''}
          </div>
        ))
      ) : (
        <BotDestination bot={bot} />
      )}
    </>
  )
}

function BotDestinationDialog({
  bot,
  onClose,
}: {
  bot: WorkspaceBotRow
  onClose: () => void
}) {
  const { t } = useT()
  const { revalidate } = useRevalidator()
  const fetcher = useFetcher<BotActionResponse>()
  const [projects, setProjects] = useState<SelectedDestination[]>(
    bot.approvedProjects ?? [],
  )
  const [primary, setPrimary] = useState(bot.projectId ?? '')
  const pending = fetcher.state !== 'idle'
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.state === 'idle') onClose()
  }, [fetcher.data, fetcher.state, onClose])
  useEffect(() => {
    if (fetcher.data?.error?.code === 'bot-conflict') void revalidate()
  }, [fetcher.data, revalidate])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent
        className="max-h-dvh overflow-y-auto"
        onCloseAutoFocus={() =>
          document.getElementById(`bot-destinations-${bot.id}`)?.focus()
        }
      >
        <DialogHeader>
          <DialogTitle>{t('team.bots.editDestinations')}</DialogTitle>
          <DialogDescription>
            {bot.name} · {t('team.bots.add.destinationHint')}
          </DialogDescription>
        </DialogHeader>
        <BotDestinationSelection
          projects={projects}
          primary={primary}
          onProjectsChange={setProjects}
          onPrimaryChange={setPrimary}
          pending={pending}
        />
        <FetcherError
          fetcher={fetcher}
          overrides={{
            'bot-conflict': 'team.bots.error.destinations-conflict',
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            {t('team.bots.close')}
          </Button>
          <Button
            type="button"
            disabled={
              pending ||
              !primary ||
              !projects.length ||
              Boolean(fetcher.data?.ok)
            }
            onClick={() =>
              fetcher.submit(
                {
                  intent: 'destinations',
                  botUserId: bot.id,
                  projectId: primary,
                  projectIds: projects.map((p) => p.id),
                  revision: bot.destinationRevision ?? '',
                },
                {
                  method: 'post',
                  action: '/settings/bots',
                  encType: 'application/json',
                },
              )
            }
          >
            {t('team.bots.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BotCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useT()
  const fetcher = useFetcher<BotActionResponse>()
  const [name, setName] = useState('')
  const [projects, setProjects] = useState<SelectedDestination[]>([])
  const [primary, setPrimary] = useState('')
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
        <DialogContent className="max-h-dvh overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('team.bots.add.title')}</DialogTitle>
            <DialogDescription>
              {t('team.bots.add.destinationHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-[var(--spacing-4)]">
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
            <BotDestinationSelection
              projects={projects}
              primary={primary}
              onProjectsChange={setProjects}
              onPrimaryChange={setPrimary}
              pending={pending}
            />
            <FetcherError fetcher={fetcher} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={pending || !name.trim() || !primary}
              onClick={() =>
                fetcher.submit(
                  {
                    intent: 'create',
                    name,
                    projectId: primary,
                    projectIds: projects.map((p) => p.id),
                  },
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
            setProjects([])
            setPrimary('')
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
          <TeamMutedParagraph>
            {t('team.bots.token.boundary')}
          </TeamMutedParagraph>
          <TeamMutedParagraph>{t('team.bots.token.expiry')}</TeamMutedParagraph>
          <TeamMutedParagraph>
            {t('team.bots.token.stdin')}
            <code className="block break-words">
              {`printf '%s' "$TOKEN" | artifactshare profiles import-token --profile bot`}
            </code>
          </TeamMutedParagraph>
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
