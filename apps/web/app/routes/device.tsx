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
import { loadAgentApprovalContext } from '~/services/cli-device-authority.server'
import { cn } from '~/lib/utils'
import type { TKey } from '~/i18n/messages'
import type { Route } from './+types/device'

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

export default function Device({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT()
  const [params] = useSearchParams()
  const initialCode = params.get('user_code') ?? ''
  const [codeInput, setCodeInput] = useState(() => ({
    sourceQuery: initialCode,
    editedValue: formatUserCode(initialCode),
  }))
  const userCode =
    codeInput.sourceQuery === initialCode
      ? codeInput.editedValue
      : formatUserCode(initialCode)
  const [state, dispatch] = useReducer(verifyReducer, { kind: 'idle' })
  const [verifiedAgentApproval, setVerifiedAgentApproval] = useState<{
    code: string
    approval: Awaited<ReturnType<typeof loadDeviceAgentApproval>>
  } | null>(null)
  const initialCleanCode = cleanUserCode(initialCode)
  const agentApproval =
    verifiedAgentApproval?.code === cleanUserCode(userCode)
      ? verifiedAgentApproval.approval
      : cleanUserCode(userCode) === initialCleanCode
        ? loaderData.agentApproval
        : null
  const [selectedProject, setSelectedProject] =
    useState<ProjectCandidateOption | null>(null)
  const effectiveProjectId = selectedProject?.id ?? ''
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
          const approval = await loadDeviceAgentApproval(verificationCode)
          if (!cancelled && currentCleanCode.current === verificationCode) {
            setVerifiedAgentApproval({ code: verificationCode, approval })
            setSelectedProject(null)
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

  const decide = async (decision: 'approved' | 'denied') => {
    if (!complete || state.kind !== 'ready') return
    const decisionCode = cleanCode
    if (state.code !== decisionCode) return
    if (currentCleanCode.current !== decisionCode) return
    dispatch({ kind: 'checking', code: decisionCode })
    try {
      const res =
        decision === 'approved'
          ? await deviceApprove(
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

  return (
    <LandingShell>
      <LandingHero>
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
            onChange={(event) =>
              setCodeInput({
                sourceQuery: initialCode,
                editedValue: formatUserCode(event.target.value),
              })
            }
            className="h-14 text-center font-mono text-2xl"
            aria-invalid={state.kind === 'invalid' ? true : undefined}
            aria-describedby={
              state.kind === 'invalid' ? 'device-code-error' : undefined
            }
          />
        </Field>

        {stateIsForCurrentCode && state.kind === 'checking' ? (
          <ConsentStatusText>{t('device.checking')}</ConsentStatusText>
        ) : null}
        {stateIsForCurrentCode && deviceErrorMessageKeys(state.kind) ? (
          <ConsentErrorAlert id="device-code-error">
            <strong>{t(deviceErrorMessageKeys(state.kind)!.title)}</strong>
            <br />
            {t(deviceErrorMessageKeys(state.kind)!.body)}
          </ConsentErrorAlert>
        ) : null}
        {stateIsForCurrentCode && state.kind === 'already' ? (
          <ConsentErrorAlert>
            <strong>{t('device.already_handled.title')}</strong>
            <br />
            {t('device.already_handled.body')}
          </ConsentErrorAlert>
        ) : null}
        {stateIsForCurrentCode && state.kind === 'done' ? (
          <ConsentStatusText>
            {state.decision === 'approved'
              ? t('device.approved')
              : t('device.denied')}
          </ConsentStatusText>
        ) : null}

        {stateIsForCurrentCode && state.kind === 'ready' ? (
          <>
            {agentApproval ? (
              <Field className="mt-4 max-w-80">
                <FieldLabel htmlFor="agent-project">
                  {t('device.agent_project')}
                </FieldLabel>
                <ProjectCandidatePicker
                  id="agent-project"
                  purpose="agent-approval"
                  userCode={cleanCode}
                  value={selectedProject}
                  onChange={setSelectedProject}
                />
              </Field>
            ) : null}
            {state.notice ? (
              <ConsentErrorAlert>{t('device.retry')}</ConsentErrorAlert>
            ) : null}
            <ConsentActions>
              <Button
                type="button"
                disabled={Boolean(agentApproval) && !effectiveProjectId}
                onClick={() => decide('approved')}
              >
                {t('device.approve')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => decide('denied')}
              >
                {t('device.deny')}
              </Button>
            </ConsentActions>
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
