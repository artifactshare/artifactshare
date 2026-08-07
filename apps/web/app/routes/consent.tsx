import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { useSearchParams } from 'react-router'
import {
  ConsentActions,
  ConsentDetailList,
  ConsentDetailTerm,
  ConsentDetailValue,
  ConsentErrorAlert,
  ConsentScopeList,
} from '~/components/app/consent-panel'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import {
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import type { TKey } from '~/i18n/messages'
import { oauthClientInfo, oauthConsent } from '~/lib/auth-client'

// Known scopes get a human label; anything else falls back to its raw name.
const SCOPE_LABEL: Record<string, TKey> = {
  openid: 'oa.scope.openid',
  profile: 'oa.scope.profile',
  email: 'oa.scope.email',
  offline_access: 'oa.scope.offline_access',
}

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

// OAuth consent page (`consentPage`). Reached after login when the client has
// no prior consent; the pending request is tracked server-side, so accepting is
// a single call that redirects back to the client with the authorization code.
export default function Consent() {
  const { t } = useT()
  const [params] = useSearchParams()
  const clientId = params.get('client_id') ?? ''
  const requestedScopesParam = params.get('scope') ?? ''
  const requestedScopes = useMemo(
    () => requestedScopesParam.split(' ').filter(Boolean),
    [requestedScopesParam],
  )
  const requestKey = canonicalQueryIdentity(params)
  const activeRequestKey = useRef(requestKey)
  const [state, dispatch] = useReducer(consentReducer, {
    key: requestKey,
    info: clientId ? { kind: 'loading' } : { kind: 'unavailable' },
    busy: false,
    failed: false,
  })
  const clientInfo =
    state.key === requestKey
      ? state.info
      : ({ kind: 'loading' } satisfies ConsentInfoState)

  useIsomorphicLayoutEffect(() => {
    activeRequestKey.current = requestKey
  }, [requestKey])

  useEffect(() => {
    dispatch({
      type: 'request-changed',
      key: requestKey,
      info: clientId ? { kind: 'loading' } : { kind: 'unavailable' },
    })
    if (!clientId) {
      return
    }
    let cancelled = false
    oauthClientInfo(clientId)
      .then((res) => {
        if (!cancelled) {
          const info = consentInfoFrom(res, requestedScopes)
          dispatch({ type: 'client-info', key: requestKey, info })
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({
            type: 'client-info',
            key: requestKey,
            info: { kind: 'unavailable' },
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [clientId, requestKey, requestedScopes])

  const available = clientInfo.kind === 'ready'

  const decide = async (accept: boolean) => {
    if (state.busy || (accept && !available)) return
    const decisionRequestKey = requestKey
    dispatch({ type: 'busy-changed', key: decisionRequestKey, busy: true })
    dispatch({ type: 'failed-changed', key: decisionRequestKey, failed: false })
    try {
      const res = await oauthConsent(accept)
      const url = redirectUrlOf(res)
      if (url && activeRequestKey.current === decisionRequestKey) {
        window.location.href = url
        return
      }
    } catch {
      // fall through to the error state below
    }
    dispatch({
      type: 'busy-changed',
      key: decisionRequestKey,
      busy: false,
    })
    dispatch({
      type: 'failed-changed',
      key: decisionRequestKey,
      failed: true,
    })
  }

  return (
    <LandingShell>
      <LandingHero>
        <FocusedFlowBrand />
        <h1 className={landingTitleClassName}>{t('oa.consent.title')}</h1>
        <p className={landingSubClassName}>{t('oa.consent.sub')}</p>

        {available ? (
          <ConsentDetailList>
            <ConsentDetailTerm>{t('oa.consent.app')}</ConsentDetailTerm>
            <ConsentDetailValue>{clientInfo.name}</ConsentDetailValue>
            <ConsentDetailTerm>{t('oa.consent.scopes')}</ConsentDetailTerm>
            <ConsentDetailValue>
              <ConsentScopeList>
                {clientInfo.scopes.map((scope) => (
                  <li key={scope}>
                    {scope in SCOPE_LABEL ? t(SCOPE_LABEL[scope]) : scope}
                  </li>
                ))}
              </ConsentScopeList>
            </ConsentDetailValue>
          </ConsentDetailList>
        ) : null}

        {clientInfo.kind === 'loading' ? (
          <p role="status">{t('oa.consent.loading')}</p>
        ) : null}

        {clientInfo.kind === 'unavailable' ? (
          <>
            <ConsentErrorAlert>
              <strong>{t('oa.consent.unavailable.title')}</strong>
              <br />
              {t('oa.consent.unavailable.body')}
            </ConsentErrorAlert>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={() => decide(false)}
            >
              {t('oa.consent.close')}
            </Button>
          </>
        ) : null}

        {state.failed ? (
          <ConsentErrorAlert>{t('oa.consent.error')}</ConsentErrorAlert>
        ) : null}

        {available ? (
          <ConsentActions>
            <Button
              type="button"
              disabled={state.busy}
              onClick={() => decide(true)}
            >
              {state.busy ? t('oa.consent.working') : t('oa.consent.allow')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={() => decide(false)}
            >
              {t('oa.consent.deny')}
            </Button>
          </ConsentActions>
        ) : null}
      </LandingHero>
    </LandingShell>
  )
}

type ConsentState = {
  key: string
  info: ConsentInfoState
  busy: boolean
  failed: boolean
}

type ConsentAction =
  | { type: 'request-changed'; key: string; info: ConsentInfoState }
  | { type: 'client-info'; key: string; info: ConsentInfoState }
  | { type: 'busy-changed'; key: string; busy: boolean }
  | { type: 'failed-changed'; key: string; failed: boolean }

function consentReducer(
  state: ConsentState,
  action: ConsentAction,
): ConsentState {
  switch (action.type) {
    case 'request-changed':
      return { key: action.key, info: action.info, busy: false, failed: false }
    case 'client-info':
      return state.key === action.key ? { ...state, info: action.info } : state
    case 'busy-changed':
      return state.key === action.key ? { ...state, busy: action.busy } : state
    case 'failed-changed':
      return state.key === action.key
        ? { ...state, failed: action.failed }
        : state
  }
}

type ConsentInfoState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; name: string; scopes: string[] }

export function consentInfoFrom(
  res: unknown,
  requestedScopes: string[],
): ConsentInfoState {
  const data = (res as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'unavailable' }
  }
  const record = data as Record<string, unknown>
  const name = record.client_name
  if (name !== undefined && typeof name !== 'string') {
    return { kind: 'unavailable' }
  }
  const clientId = record.client_id
  if (clientId !== undefined && typeof clientId !== 'string') {
    return { kind: 'unavailable' }
  }
  const clientUri = record.client_uri
  const scopes = requestedScopes.filter(Boolean)
  const displayName =
    typeof name === 'string' && name.trim().length > 0
      ? name.trim()
      : typeof clientUri === 'string'
        ? (hostOf(clientUri) ?? clientId?.trim() ?? '')
        : (clientId?.trim() ?? '')
  return displayName.length > 0 && scopes.length > 0
    ? { kind: 'ready', name: displayName, scopes }
    : { kind: 'unavailable' }
}

function hostOf(uri: string | null): string | null {
  if (!uri) return null
  try {
    const host = new URL(uri).host
    return host || null
  } catch {
    return null
  }
}

function redirectUrlOf(res: unknown): string | null {
  const data = (res as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return null
  for (const key of ['url', 'redirectURI', 'redirectUri', 'redirect_uri']) {
    const value = (data as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function canonicalQueryIdentity(params: URLSearchParams): string {
  const canonical = new URLSearchParams(params)
  canonical.sort()
  return canonical.toString()
}
