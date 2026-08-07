import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { useRouteLoaderData, useSearchParams } from 'react-router'
import {
  AuthAlert,
  AuthCard,
  AuthDivider,
  AuthFootnote,
  AuthFormStack,
  AuthHint,
  AuthLinksRow,
  AuthMaintenanceNotice,
  AuthProviders,
} from '~/components/app/auth-card'
import { LastUsedBadge } from '~/components/app/last-used-badge'
import { SignInOptions } from '~/components/app/sign-in-options'
import { Button } from '~/components/ui/button'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { useT } from '~/hooks/use-t'
import { sendSignInOtp, signInWithOtp } from '~/lib/auth-client'
import { oauthAuthorizePath } from '~/lib/mcp-metadata'
import { safeInternalNext } from '~/lib/safe-next'
import {
  buildSignInErrorCallback,
  signInIntent,
  signInMethod,
} from '~/lib/sign-in-context'
import { PublicFooter } from '~/components/app/public-footer'
import { ANALYTICS_EVENTS, ANALYTICS_PARAMS } from '~/lib/analytics/events'
import { trackEvent } from '~/lib/analytics/track.client'

type Step = 'email' | 'code'

// The page is a tiny two-step wizard (enter email → enter code). The five
// pieces of state move together, so a reducer keeps the transitions in one
// place instead of fanning out across separate setState calls.
type FormState = {
  step: Step
  email: string
  code: string
  error: string | null
  submitting: boolean
}

type FormAction =
  | { type: 'setEmail'; email: string }
  | { type: 'setCode'; code: string }
  | { type: 'submitStart' }
  | { type: 'resendStart' }
  | { type: 'submitFailed'; error: string }
  | { type: 'codeSent' }
  | { type: 'resendDone' }
  | { type: 'changeEmail' }

const INITIAL_STATE: FormState = {
  step: 'email',
  email: '',
  code: '',
  error: null,
  submitting: false,
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setEmail':
      return { ...state, email: action.email }
    case 'setCode':
      return { ...state, code: action.code }
    case 'submitStart':
      return { ...state, submitting: true, error: null }
    case 'resendStart':
      return { ...state, submitting: true, error: null, code: '' }
    case 'submitFailed':
      return { ...state, submitting: false, error: action.error }
    case 'codeSent':
      return { ...state, submitting: false, step: 'code', error: null }
    case 'resendDone':
      return { ...state, submitting: false }
    case 'changeEmail':
      return { ...state, step: 'email', code: '', error: null }
  }
}

export default function SignIn() {
  const { t, locale } = useT()
  const [params] = useSearchParams()
  const rootData = useRouteLoaderData('root') as
    | { maintenance?: boolean }
    | undefined
  const maintenance = rootData?.maintenance === true

  // OAuth authorize flow (an MCP host is connecting) carries a signed request;
  // only then do we frame the page as "sign in to connect".
  const isOAuth = params.has('client_id') && params.has('sig')

  const [state, dispatch] = useReducer(formReducer, INITIAL_STATE)
  const { step, email, code, error: formError, submitting } = state

  // Focus the code field when the code step appears (the UX `autoFocus` would
  // give, without the static attribute that disorients users on page load).
  const codeInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus()
  }, [step])

  const callbackURL = isOAuth
    ? `${oauthAuthorizePath}?${params.toString()}`
    : safeInternalNext(params.get('next'))

  const providerError = params.get('error')
  const intent = signInIntent(params)
  const method = signInMethod(params, providerError)
  const [emailOpen, setEmailOpen] = useState(method === 'email')
  const emailInputRef = useRef<HTMLInputElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  // better-auth redirects the unlinkable-account case as ?error=account_not_linked
  // (lowercase, from "account not linked".split(" ").join("_")), so match
  // case-insensitively; the AADSTS token is always uppercase from Microsoft.
  const providerErrorLower = providerError?.toLowerCase() ?? ''
  const getProviderErrorMessage = () => {
    if (!providerError) return null
    if (
      providerError.includes('AADSTS65001') ||
      providerErrorLower.includes('consent_required')
    ) {
      return t('signin.error.admin_consent')
    }
    if (providerErrorLower.includes('account_not_linked')) {
      return t('signin.error.account_not_linked')
    }
    return t('signin.error.generic')
  }
  const providerErrorMessage = getProviderErrorMessage()

  const handleSendCode = async (e: FormEvent) => {
    e.preventDefault()
    dispatch({ type: 'submitStart' })
    try {
      const result = await sendSignInOtp(email)
      if (result.error) {
        dispatch({ type: 'submitFailed', error: t('signin.error.generic') })
      } else {
        dispatch({ type: 'codeSent' })
      }
    } catch {
      dispatch({ type: 'submitFailed', error: t('signin.error.generic') })
    }
  }

  const handleVerifyCode = async (e: FormEvent) => {
    e.preventDefault()
    dispatch({ type: 'submitStart' })
    try {
      const name = email.split('@')[0] ?? email
      const result = await signInWithOtp(email, code.trim(), name)
      if (result.error) {
        dispatch({ type: 'submitFailed', error: t('signin.otp.invalid') })
      } else {
        // The OTP endpoint returns JSON (no redirect), so navigate ourselves.
        window.location.href = callbackURL
      }
    } catch {
      dispatch({ type: 'submitFailed', error: t('signin.error.generic') })
    }
  }

  const handleResend = async () => {
    dispatch({ type: 'resendStart' })
    try {
      const result = await sendSignInOtp(email)
      if (result.error) {
        dispatch({ type: 'submitFailed', error: t('signin.error.generic') })
      } else {
        dispatch({ type: 'resendDone' })
      }
    } catch {
      dispatch({ type: 'submitFailed', error: t('signin.error.generic') })
    }
  }

  const title = isOAuth
    ? t('oa.signin.title')
    : intent === 'upload'
      ? t('signin.upload.title')
      : t('signin.title')
  const sub = isOAuth
    ? t('oa.signin.sub')
    : intent === 'upload'
      ? t('signin.upload.sub')
      : t('signin.sub')
  const providers = (
    <SignInOptions
      callbackURL={callbackURL}
      errorCallbackURL={
        !isOAuth && intent === 'upload'
          ? buildSignInErrorCallback(params)
          : undefined
      }
      disabled={maintenance}
    />
  )

  return (
    <AuthCard
      mark
      title={title}
      sub={sub}
      footer={<PublicFooter variant="minimal" />}
    >
      {providerErrorMessage ? (
        <AuthAlert>{providerErrorMessage}</AuthAlert>
      ) : null}

      {step === 'email' && (
        <>
          {formError ? <AuthAlert>{formError}</AuthAlert> : null}
          {emailOpen && (
            <form onSubmit={handleSendCode} noValidate>
              <AuthFormStack>
                <Field>
                  <FieldLabel htmlFor="signin-email" className="sr-only">
                    {t('signin.email.placeholder')}
                  </FieldLabel>
                  <Input
                    ref={emailInputRef}
                    id="signin-email"
                    type="email"
                    placeholder={t('signin.email.placeholder')}
                    value={email}
                    onChange={(e) =>
                      dispatch({ type: 'setEmail', email: e.target.value })
                    }
                    required
                    autoComplete="email"
                  />
                </Field>
                <Button type="submit" disabled={maintenance || submitting}>
                  {t('signin.otp.send')}
                  <LastUsedBadge method="email" />
                </Button>
              </AuthFormStack>
            </form>
          )}

          {!emailOpen && (
            <>
              <AuthProviders>{providers}</AuthProviders>
              <AuthDivider>{t('signin.or')}</AuthDivider>
            </>
          )}
          <AuthFootnote>
            <AuthHint>{t('signin.otp.viewerOnly')}</AuthHint>
            <Button
              ref={toggleRef}
              type="button"
              variant="link"
              onClick={() => {
                if (emailOpen) {
                  setEmailOpen(false)
                  requestAnimationFrame(() => toggleRef.current?.focus())
                } else {
                  trackEvent(ANALYTICS_EVENTS.signUpStart, {
                    [ANALYTICS_PARAMS.method]: 'email',
                  })
                  setEmailOpen(true)
                  requestAnimationFrame(() => emailInputRef.current?.focus())
                }
              }}
            >
              {emailOpen
                ? t('signin.email.collapse')
                : t('signin.email.expand')}
            </Button>
          </AuthFootnote>
        </>
      )}

      {step === 'code' && (
        <form onSubmit={handleVerifyCode} noValidate>
          <AuthFormStack>
            <AuthHint>{t('signin.otp.sentTo', { email })}</AuthHint>
            <Field data-invalid={formError ? true : undefined}>
              <FieldLabel htmlFor="signin-code" className="sr-only">
                {t('signin.otp.placeholder')}
              </FieldLabel>
              <Input
                ref={codeInputRef}
                id="signin-code"
                type="text"
                className="tracking-otp text-center indent-[var(--tracking-otp)] text-lg tabular-nums"
                placeholder={t('signin.otp.placeholder')}
                value={code}
                onChange={(e) =>
                  dispatch({
                    type: 'setCode',
                    code: e.target.value.replace(/\D/g, '').slice(0, 6),
                  })
                }
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                aria-invalid={formError ? true : undefined}
                aria-describedby={formError ? 'signin-code-error' : undefined}
              />
              <FieldError id="signin-code-error">{formError}</FieldError>
            </Field>
            <Button
              type="submit"
              disabled={maintenance || submitting || code.length < 6}
            >
              {t('signin.otp.verify')}
            </Button>
            <AuthLinksRow>
              <Button
                type="button"
                variant="link"
                onClick={handleResend}
                disabled={submitting}
              >
                {t('signin.otp.resend')}
              </Button>
              <Button
                type="button"
                variant="link"
                onClick={() => dispatch({ type: 'changeEmail' })}
              >
                {t('signin.otp.changeEmail')}
              </Button>
            </AuthLinksRow>
          </AuthFormStack>
        </form>
      )}

      {maintenance && (
        <AuthMaintenanceNotice>{t('lp.maintenanceAuth')}</AuthMaintenanceNotice>
      )}
    </AuthCard>
  )
}
