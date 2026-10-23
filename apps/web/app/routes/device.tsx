import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'react-router'
import { PublicFooter } from '~/components/app/public-footer'
import {
  ConsentActions,
  ConsentErrorAlert,
  ConsentStatusText,
} from '~/components/app/consent-panel'
import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import {
  landingDeviceCodeCardSurfaceClassName,
  landingDeviceCodeClassName,
  landingDeviceCodeLabelClassName,
  landingDeviceStepActiveClassName,
  landingDeviceStepNumActiveClassName,
  landingDeviceStepNumClassName,
  landingDeviceStepsClassName,
  landingDeviceStepSurfaceClassName,
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'
import { Button } from '~/components/ui/button'
import { Field, FieldLabel } from '~/components/ui/field'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { Input } from '~/components/ui/input'
import {
  ProjectCandidatePicker,
  type ProjectCandidateOption,
} from '~/components/app/project-candidate-picker'
import { useT } from '~/hooks/use-t'
import {
  deviceApprove,
  deviceDeny,
  deviceVerify,
  loadDeviceAgentApproval,
  signInToCurrentPage,
} from '~/lib/auth-client'
import { userContext } from '~/middleware/context'
import { cn } from '~/lib/utils'
import type { TKey } from '~/i18n/messages'
import type { Route } from './+types/device'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'device',
  route: {
    en: '/device',
  },
  auth: 'anonymous',
  loop: 'create',
  metric: 'CLIとブラウザの接続完了率を高める',
  role: 'デバイス認証を完了する',
  primaryAction: '認証を完了する',
  states: [
    {
      id: 'unrestricted',
      description: 'Unrestricted approval, confirmation unchecked',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/unrestricted',
        query: '?user_code=FAE50B19',
        ready: {
          selector: '#device-code-confirmation',
          description: 'Code verified and approval context loaded',
        },
      },
    },
    {
      id: 'unrestricted-confirmed',
      description: 'Unrestricted approval, confirmation checked',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/unrestricted-confirmed',
        query: '?user_code=EA818F55',
        ready: {
          selector: '#device-code-confirmation',
          description: 'Code verified and approval context loaded',
        },
        interactions: [
          { action: 'click', selector: '#device-code-confirmation' },
        ],
      },
    },

    {
      id: 'publisher-new',
      description: 'publisher-new approval',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/publisher-new',
        query: '?user_code=323ECBD2',
      },
    },
    {
      id: 'publisher-continue',
      description: 'Existing publisher client picker',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/publisher-continue',
        query: '?user_code=12242955',
        interactions: [{ action: 'click', selector: '#publisher-continue' }],
        ready: {
          selector: '#publisher-continue',
          description: 'Client choices loaded',
        },
      },
    },
    {
      id: 'publisher-invalid',
      description: 'Duplicate publisher name blocks new-client approval',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/publisher-invalid',
        query: '?user_code=5D39F577',
        interactions: [{ action: 'click', selector: '#publisher-new' }],
        ready: {
          selector: '#publisher-new',
          description: 'Client choices loaded',
        },
      },
    },
    {
      id: 'publisher-long-name',
      description: 'Long requested name and existing client picker',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/publisher-long-name',
        query: '?user_code=BFD3DBFE',
        interactions: [{ action: 'click', selector: '#publisher-continue' }],
        ready: {
          selector: '#publisher-continue',
          description: 'Client choices loaded',
        },
      },
    },
    {
      id: 'default',
      description: '通常のデバイス認証',
      setup: {},
    },
    {
      id: 'with-code',
      description: '照合対象のデバイスコードが表示された状態',
      setup: {
        query: '?user_code=ABCD1234',
      },
    },
    {
      id: 'fixed-project',
      description: 'CLIで事前指定した投稿先を確認する状態',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/fixed-project',
        query: '?user_code=ABCD1234',
      },
    },
    {
      id: 'fixed-project-unavailable',
      description: '事前指定した投稿先を承認できない状態',
      setup: {
        auth: 'team-owner',
        seedAuth: 'team-owner',
        scenario: 'device/fixed-project-unavailable',
        query: '?user_code=EFGH5678',
      },
    },
  ],
} satisfies ScreenSpec

// better-auth の device-authorization 既定コード長。この長さに達する前に verify を
// 叩くと、入力途中で invalid エラーが表示される。
const USER_CODE_LENGTH = 8

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking'; code: string }
  | { kind: 'ready'; code: string; notice: boolean }
  | { kind: 'done'; code: string; decision: 'approved' | 'denied' }
  | { kind: 'already'; code: string }
  | { kind: 'invalid' | 'expired' | 'not_found'; code: string }
  | { kind: 'missing' }

type DeviceMessageKeys = { title: TKey; body: TKey }

function DevicePreAuth({ initialCode }: { initialCode: string }) {
  const { t } = useT()
  const displayCode = formatUserCode(initialCode) || null

  return (
    <LandingShell>
      <LandingHero>
        <FocusedFlowBrand />
        <h1 className={landingTitleClassName}>{t('device.preauth.title')}</h1>
        <p className={landingSubClassName}>{t('device.preauth.sub')}</p>

        {displayCode && (
          <Stack
            gap="2"
            align="center"
            className={landingDeviceCodeCardSurfaceClassName}
          >
            <span className={landingDeviceCodeLabelClassName}>
              {t('device.preauth.codeLabel')}
            </span>
            <span className={landingDeviceCodeClassName}>{displayCode}</span>
          </Stack>
        )}

        <Inline gap="0" align="center" asChild>
          <ol className={landingDeviceStepsClassName}>
            <Inline gap="1.5" align="center" asChild>
              <li
                className={cn(
                  landingDeviceStepSurfaceClassName,
                  landingDeviceStepActiveClassName,
                )}
              >
                <span
                  className={cn(
                    landingDeviceStepNumClassName,
                    landingDeviceStepNumActiveClassName,
                  )}
                >
                  1
                </span>
                {t('device.preauth.step1')}
              </li>
            </Inline>
            <Inline gap="1.5" align="center" asChild>
              <li className={landingDeviceStepSurfaceClassName}>
                <span className={landingDeviceStepNumClassName}>2</span>
                {t('device.preauth.step2')}
              </li>
            </Inline>
            <Inline gap="1.5" align="center" asChild>
              <li className={landingDeviceStepSurfaceClassName}>
                <span className={landingDeviceStepNumClassName}>3</span>
                {t('device.preauth.step3')}
              </li>
            </Inline>
          </ol>
        </Inline>

        <Button type="button" onClick={signInToCurrentPage}>
          {t('signin.cta')}
        </Button>
      </LandingHero>
      <PublicFooter variant="minimal" />
    </LandingShell>
  )
}

function verifyReducer(_: VerifyState, next: VerifyState): VerifyState {
  return next
}

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext)
  return {
    signedIn: Boolean(user),
    agentApproval: null,
  }
}

function DeviceVerificationStatus({ state }: { state: VerifyState }) {
  const { t } = useT()
  return (
    <>
      {state.kind === 'checking' ? (
        <ConsentStatusText>{t('device.checking')}</ConsentStatusText>
      ) : null}
      {deviceErrorMessageKeys(state.kind) ? (
        <ConsentErrorAlert id="device-code-error">
          <strong>{t(deviceErrorMessageKeys(state.kind)!.title)}</strong>
          <br />
          {t(deviceErrorMessageKeys(state.kind)!.body)}
        </ConsentErrorAlert>
      ) : null}
      {state.kind === 'already' ? (
        <ConsentErrorAlert>
          <strong>{t('device.already_handled.title')}</strong>
          <br />
          {t('device.already_handled.body')}
        </ConsentErrorAlert>
      ) : null}
      {state.kind === 'done' ? (
        <ConsentStatusText>
          {state.decision === 'approved'
            ? t('device.approved')
            : t('device.denied')}
        </ConsentStatusText>
      ) : null}
    </>
  )
}

function PublisherApprovalFields({
  publisherApproval,
  publisherMode,
  setPublisherMode,
  publisherClientId,
  setPublisherClientId,
  publisherDuplicate,
}: {
  publisherApproval: Extract<
    Awaited<ReturnType<typeof loadDeviceAgentApproval>>,
    { preset: 'publisher' }
  >
  publisherMode: string
  setPublisherMode: (mode: string) => void
  publisherClientId: string
  setPublisherClientId: (id: string) => void
  publisherDuplicate: boolean
}) {
  const { t } = useT()
  return (
    <div className="mt-4 w-full max-w-80 text-left">
      <Stack gap="3">
        <Stack gap="1.5">
          <p id="publisher-name-label" className="text-sm font-medium">
            {t('device.publisher.requestedName')}
          </p>
          <blockquote
            aria-labelledby="publisher-name-label"
            className="border-border bg-muted/30 rounded-md border px-3 py-2 text-sm break-words"
          >
            {publisherApproval.requestedName}
          </blockquote>
          <p className="text-muted-foreground text-sm">
            {t('device.publisher.nameSource')}
          </p>
        </Stack>
        <p id="publisher-capability" className="text-muted-foreground text-sm">
          {t('device.publisher.capability')}
        </p>
        <Field>
          <FieldLabel id="publisher-choice-label">
            {t('device.publisher.choice')}
          </FieldLabel>
          <RadioGroup
            aria-labelledby="publisher-choice-label"
            value={publisherMode}
            onValueChange={setPublisherMode}
          >
            <Inline gap="2">
              <RadioGroupItem id="publisher-new" value="create-new" />
              <FieldLabel htmlFor="publisher-new">
                {t('device.publisher.new')}
              </FieldLabel>
            </Inline>
            <Inline gap="2">
              <RadioGroupItem
                id="publisher-continue"
                value="continue-existing"
                disabled={publisherApproval.clients.length === 0}
              />
              <FieldLabel htmlFor="publisher-continue">
                {t('device.publisher.continue')}
                {publisherApproval.clients.length === 0
                  ? ` ${t('device.publisher.noneYet')}`
                  : null}
              </FieldLabel>
            </Inline>
          </RadioGroup>
        </Field>
        {publisherMode === 'continue-existing' ? (
          <Field>
            <FieldLabel id="publisher-client-label" htmlFor="publisher-client">
              {t('device.publisher.client')}
            </FieldLabel>
            <select
              id="publisher-client"
              aria-labelledby="publisher-client-label"
              value={publisherClientId}
              onChange={(event) => setPublisherClientId(event.target.value)}
              className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            >
              <option value="">{t('device.publisher.select')}</option>
              {publisherApproval.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {publisherMode === 'create-new' && publisherDuplicate ? (
          <ConsentErrorAlert>
            {t('device.publisher.duplicate')}
          </ConsentErrorAlert>
        ) : null}
        {publisherApproval.clients.length > 0 &&
        !(publisherMode === 'create-new' && publisherDuplicate) ? (
          <p className="text-muted-foreground text-sm">
            {t('device.publisher.nameHelp')}
          </p>
        ) : null}
      </Stack>
    </div>
  )
}

function DeviceApprovalActions({
  unrestricted,
  requiresConfirmation,
  confirmed,
  onConfirm,
  blocked,
  hasProjectConsequence,
  onDecision,
}: {
  unrestricted: boolean
  requiresConfirmation: boolean
  confirmed: boolean
  onConfirm: (confirmed: boolean) => void
  blocked: boolean
  hasProjectConsequence: boolean
  onDecision: (decision: 'approved' | 'denied') => Promise<void>
}) {
  const { t } = useT()
  return (
    <>
      <DeviceApprovalSafety
        unrestricted={unrestricted}
        requiresConfirmation={requiresConfirmation}
        confirmed={confirmed}
        onConfirm={onConfirm}
      />
      <ConsentActions>
        <Button
          type="button"
          disabled={blocked}
          aria-describedby={[
            'device-approval-warning',
            unrestricted ? 'device-unrestricted-disclosure' : null,
            hasProjectConsequence ? 'agent-project-consequence' : null,
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onDecision('approved')}
        >
          {t('device.approve')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onDecision('denied')}
        >
          {t('device.deny')}
        </Button>
      </ConsentActions>
    </>
  )
}

function DeviceApprovalSafety({
  unrestricted,
  requiresConfirmation,
  confirmed,
  onConfirm,
}: {
  unrestricted: boolean
  requiresConfirmation: boolean
  confirmed: boolean
  onConfirm: (confirmed: boolean) => void
}) {
  const { t } = useT()
  return (
    <div className="mt-4 w-full max-w-80 text-left text-sm">
      <Stack gap="3">
        <p id="device-approval-warning" role="note" className="font-medium">
          {t('device.approval_warning')}
        </p>
        {unrestricted ? (
          <p id="device-unrestricted-disclosure">
            {t('device.unrestricted_disclosure')}
          </p>
        ) : null}
        {requiresConfirmation ? (
          <label
            htmlFor="device-code-confirmation"
            className="flex min-h-11 cursor-pointer items-start gap-2 py-2"
          >
            <input
              id="device-code-confirmation"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirm(event.target.checked)}
              className="accent-primary focus-visible:ring-ring mt-1 size-4 shrink-0 focus-visible:ring-2 focus-visible:ring-offset-2"
            />
            <span>{t('device.code_confirmation')}</span>
          </label>
        ) : null}
      </Stack>
    </div>
  )
}

function useDeviceCodeInput(initialCode: string) {
  const [codeInput, setCodeInput] = useState(() => ({
    sourceQuery: initialCode,
    editedValue: formatUserCode(initialCode),
    confirmed: false,
  }))
  if (codeInput.sourceQuery !== initialCode) {
    setCodeInput({
      sourceQuery: initialCode,
      editedValue: formatUserCode(initialCode),
      confirmed: false,
    })
  }
  const userCode =
    codeInput.sourceQuery === initialCode
      ? codeInput.editedValue
      : formatUserCode(initialCode)
  const initialCleanCode = cleanUserCode(initialCode).slice(0, USER_CODE_LENGTH)
  // Completing a partial prefill or changing its formatting is not manual entry.
  const requiresConfirmation =
    initialCleanCode.length > 0 &&
    cleanUserCode(userCode).startsWith(initialCleanCode)
  const codeConfirmed =
    codeInput.sourceQuery === initialCode && codeInput.confirmed
  const confirmationMissing = requiresConfirmation && !codeConfirmed
  return {
    userCode,
    requiresConfirmation,
    codeConfirmed,
    confirmationMissing,
    confirmCode: (confirmed: boolean) =>
      setCodeInput({ ...codeInput, confirmed }),
    editCode: (value: string) =>
      setCodeInput({
        sourceQuery: initialCode,
        editedValue: formatUserCode(value),
        confirmed: false,
      }),
  }
}

export default function Device({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT()
  const [params] = useSearchParams()
  const initialCode = params.get('user_code') ?? ''
  const {
    userCode,
    requiresConfirmation,
    codeConfirmed,
    confirmationMissing,
    confirmCode,
    editCode,
  } = useDeviceCodeInput(initialCode)
  const [state, dispatch] = useReducer(verifyReducer, { kind: 'idle' })
  const [verifiedAgentApproval, setVerifiedAgentApproval] = useState<{
    code: string
    approval: Awaited<ReturnType<typeof loadDeviceAgentApproval>>
  } | null>(null)
  const initialCleanCode = cleanUserCode(initialCode)
  const approval =
    verifiedAgentApproval?.code === cleanUserCode(userCode)
      ? verifiedAgentApproval.approval
      : cleanUserCode(userCode) === initialCleanCode
        ? loaderData.agentApproval
        : null
  const agentApproval = approval?.preset === 'agent' ? approval : null
  const publisherApproval = approval?.preset === 'publisher' ? approval : null
  const [publisherMode, setPublisherMode] = useState('')
  const [publisherClientId, setPublisherClientId] = useState('')
  const publisherDuplicate =
    publisherApproval?.clients.some(
      (client) => client.name === publisherApproval.requestedName,
    ) ?? false
  const publisherChoiceValid =
    publisherMode === 'create-new'
      ? !publisherDuplicate
      : publisherMode === 'continue-existing' &&
        Boolean(
          publisherApproval?.clients.some(
            (client) => client.id === publisherClientId,
          ),
        )
  const [selectedProject, setSelectedProject] =
    useState<ProjectCandidateOption | null>(null)
  const fixedProject = agentApproval?.fixedProject ?? null
  const effectiveProject = agentApproval?.projectSelector
    ? fixedProject
    : selectedProject
  const effectiveProjectId = effectiveProject?.id ?? ''
  const cleanCode = useMemo(() => cleanUserCode(userCode), [userCode])
  const currentCleanCode = useRef(cleanCode)
  const complete = cleanCode.length === USER_CODE_LENGTH
  const hasInitialCode = cleanUserCode(initialCode).length === USER_CODE_LENGTH

  useIsomorphicLayoutEffect(() => {
    currentCleanCode.current = cleanCode
  }, [cleanCode])

  useEffect(() => {
    if (!loaderData.signedIn) {
      dispatch({ kind: 'idle' })
      return
    }
    if (!complete) {
      dispatch({
        kind: hasInitialCode || cleanCode.length > 0 ? 'idle' : 'missing',
      })
      return
    }
    const verificationCode = cleanCode
    let cancelled = false
    const dispatchIfCurrent = (next: VerifyState) => {
      if (cancelled || currentCleanCode.current !== verificationCode) return
      dispatch(next)
    }
    dispatchIfCurrent({ kind: 'checking', code: verificationCode })
    deviceVerify(verificationCode)
      .then(async (res) => {
        const next = verifyStateFrom(res, verificationCode)
        if (next.kind === 'ready') {
          const verifiedApproval =
            await loadDeviceAgentApproval(verificationCode)
          if (!cancelled && currentCleanCode.current === verificationCode) {
            setVerifiedAgentApproval({
              code: verificationCode,
              approval: verifiedApproval,
            })
            setSelectedProject(null)
            setPublisherMode(
              verifiedApproval?.preset === 'publisher' &&
                verifiedApproval.clients.length === 0
                ? 'create-new'
                : '',
            )
            setPublisherClientId('')
          }
        }
        dispatchIfCurrent(next)
      })
      .catch(() => {
        dispatchIfCurrent({ kind: 'invalid', code: verificationCode })
      })
    return () => {
      cancelled = true
    }
  }, [loaderData.signedIn, cleanCode, complete, hasInitialCode])

  const approvalBlocked =
    confirmationMissing ||
    (Boolean(agentApproval) && !effectiveProjectId) ||
    (Boolean(publisherApproval) && !publisherChoiceValid)

  const decide = async (decision: 'approved' | 'denied') => {
    if (!complete || state.kind !== 'ready') return
    if (decision === 'approved' && approvalBlocked) return
    const decisionCode = cleanCode
    if (state.code !== decisionCode) return
    if (currentCleanCode.current !== decisionCode) return
    dispatch({ kind: 'checking', code: decisionCode })
    try {
      const res =
        decision === 'approved'
          ? publisherApproval
            ? await deviceApprove(
                decisionCode,
                undefined,
                publisherMode === 'create-new'
                  ? { mode: 'create-new' }
                  : { mode: 'continue-existing', client_id: publisherClientId },
              )
            : await deviceApprove(
                decisionCode,
                agentApproval?.preset === 'agent'
                  ? effectiveProjectId
                  : undefined,
              )
          : await deviceDeny(decisionCode)
      if (currentCleanCode.current === decisionCode) {
        const status = errorStatusOf(res)
        if (status === null) {
          dispatch({ kind: 'done', code: decisionCode, decision })
        } else if (status === 401) {
          signInToCurrentPage()
        } else if (publisherApproval && status === 400) {
          const refreshed = await loadDeviceAgentApproval(decisionCode)
          if (currentCleanCode.current !== decisionCode) return
          if (refreshed?.preset !== 'publisher') {
            dispatch({ kind: 'expired', code: decisionCode })
            return
          }
          setVerifiedAgentApproval({ code: decisionCode, approval: refreshed })
          setPublisherMode(refreshed.clients.length === 0 ? 'create-new' : '')
          setPublisherClientId('')
          dispatch({ kind: 'ready', code: decisionCode, notice: true })
        } else if (status === 400 || status === 403) {
          dispatch({ kind: 'already', code: decisionCode })
        } else {
          dispatch({ kind: 'ready', code: decisionCode, notice: true })
        }
      }
    } catch {
      if (currentCleanCode.current === decisionCode) {
        dispatch({ kind: 'ready', code: decisionCode, notice: true })
      }
    }
  }

  const stateCode = 'code' in state ? state.code : null
  const stateIsForCurrentCode = stateCode === null || stateCode === cleanCode

  if (!loaderData.signedIn) {
    return <DevicePreAuth initialCode={initialCode} />
  }

  return (
    <LandingShell>
      <LandingHero className="pb-6">
        <FocusedFlowBrand />
        <h1 className={landingTitleClassName}>{t('device.title')}</h1>
        <p className={landingSubClassName}>{t('device.sub')}</p>

        <Field className="max-w-80">
          <FieldLabel htmlFor="device-code">
            {t('device.code_label')}
          </FieldLabel>
          <Input
            id="device-code"
            value={userCode}
            inputMode="text"
            autoComplete="one-time-code"
            onChange={(event) => editCode(event.target.value)}
            className="h-14 text-center font-mono text-2xl md:text-2xl"
            aria-invalid={state.kind === 'invalid' ? true : undefined}
            aria-describedby={
              state.kind === 'invalid' ? 'device-code-error' : undefined
            }
          />
        </Field>

        {stateIsForCurrentCode ? (
          <DeviceVerificationStatus state={state} />
        ) : null}

        {stateIsForCurrentCode && state.kind === 'ready' ? (
          <>
            {publisherApproval ? (
              <PublisherApprovalFields
                publisherApproval={publisherApproval}
                publisherMode={publisherMode}
                setPublisherMode={setPublisherMode}
                publisherClientId={publisherClientId}
                setPublisherClientId={setPublisherClientId}
                publisherDuplicate={publisherDuplicate}
              />
            ) : null}
            {agentApproval ? (
              <Field className="mt-4 max-w-80">
                <FieldLabel
                  id="agent-project-label"
                  onClick={() =>
                    document.getElementById('agent-project')?.focus()
                  }
                >
                  {t('device.agent_project')}
                </FieldLabel>
                {agentApproval.projectSelector ? (
                  fixedProject ? (
                    <div
                      id="agent-project"
                      aria-labelledby="agent-project-label"
                      className="border-border bg-muted/30 rounded-md border px-3 py-2 text-sm"
                    >
                      {fixedProject.name}
                    </div>
                  ) : (
                    <ConsentErrorAlert id="agent-project">
                      {t('device.agent_project_unavailable')}
                    </ConsentErrorAlert>
                  )
                ) : (
                  <ProjectCandidatePicker
                    id="agent-project"
                    ariaLabelledBy="agent-project-label"
                    purpose="agent-approval"
                    userCode={cleanCode}
                    value={selectedProject}
                    onChange={setSelectedProject}
                  />
                )}
                {effectiveProject ? (
                  <p
                    id="agent-project-consequence"
                    className="text-muted-foreground text-sm"
                  >
                    {t('device.agent_project_consequence', {
                      project: effectiveProject.name,
                    })}
                  </p>
                ) : null}
              </Field>
            ) : null}
            {state.notice ? (
              <ConsentErrorAlert>{t('device.retry')}</ConsentErrorAlert>
            ) : null}
            <DeviceApprovalActions
              unrestricted={!agentApproval && !publisherApproval}
              requiresConfirmation={
                requiresConfirmation &&
                !(agentApproval?.projectSelector && !fixedProject)
              }
              confirmed={codeConfirmed}
              onConfirm={confirmCode}
              blocked={approvalBlocked}
              hasProjectConsequence={Boolean(agentApproval && effectiveProject)}
              onDecision={decide}
            />
          </>
        ) : null}
      </LandingHero>
      <PublicFooter variant="minimal" />
    </LandingShell>
  )
}

export function verifyStateFrom(
  res: unknown,
  verificationCode: string,
): VerifyState {
  const statusCode = errorStatusOf(res)
  if (statusCode === 410) return { kind: 'expired', code: verificationCode }
  if (statusCode === 404) return { kind: 'not_found', code: verificationCode }
  if (statusCode !== null) return { kind: 'invalid', code: verificationCode }
  const data = (res as { data?: unknown } | null)?.data
  const status =
    data && typeof data === 'object' && 'status' in data
      ? String((data as Record<string, unknown>).status)
      : 'pending'
  if (status === 'approved')
    return { kind: 'done', code: verificationCode, decision: 'approved' }
  if (status === 'denied')
    return { kind: 'done', code: verificationCode, decision: 'denied' }
  if (status === 'expired') return { kind: 'expired', code: verificationCode }
  if (status === 'used' || status === 'already_handled')
    return { kind: 'already', code: verificationCode }
  return { kind: 'ready', code: verificationCode, notice: false }
}

export function deviceErrorMessageKeys(
  kind: VerifyState['kind'],
): DeviceMessageKeys | null {
  switch (kind) {
    case 'invalid':
      return { title: 'device.invalid.title', body: 'device.invalid.body' }
    case 'missing':
      return { title: 'device.missing.title', body: 'device.missing.body' }
    case 'expired':
      return { title: 'device.expired.title', body: 'device.expired.body' }
    case 'not_found':
      return { title: 'device.not_found.title', body: 'device.not_found.body' }
    default:
      return null
  }
}

function errorStatusOf(res: unknown): number | null {
  const error = (res as { error?: unknown } | null)?.error
  if (!error || typeof error !== 'object') return null
  const status = (error as Record<string, unknown>).status
  return typeof status === 'number' ? status : 0
}

function cleanUserCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function formatUserCode(value: string): string {
  const clean = cleanUserCode(value).slice(0, USER_CODE_LENGTH)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}
