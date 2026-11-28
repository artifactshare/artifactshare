import { data } from 'react-router'

export function settingsFailure(intent: string, code: string) {
  const status = [
    'forbidden',
    'self-forbidden',
    'not-team',
    'bot-revoke-not-supported',
  ].includes(code)
    ? 403
    : ['not-found', 'restore-unavailable'].includes(code)
      ? 404
      : [
            'already-subscribed',
            'checkout-in-progress',
            'no-subscription',
            'external-failed',
            'billing-unavailable',
          ].includes(code)
        ? 409
        : 400
  return data({ ok: false as const, code, intent }, { status })
}
