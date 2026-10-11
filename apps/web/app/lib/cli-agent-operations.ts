import type { CliAuthority } from '~/services/cli-authority.server'

type Rule = { method: string; pattern: RegExp }

const BOOTSTRAP_RULES: Rule[] = [
  { method: 'GET', pattern: /^\/api\/cli\/whoami$/ },
  { method: 'GET', pattern: /^\/api\/cli\/doctor$/ },
  { method: 'POST', pattern: /^\/api\/cli\/auth\/refresh-credentials$/ },
]

const AGENT_RULES: Rule[] = [
  ...BOOTSTRAP_RULES,
  { method: 'GET', pattern: /^\/api\/cli\/artifacts$/ },
  { method: 'GET', pattern: /^\/api\/cli\/artifacts\/[^/]+$/ },
  {
    method: 'GET',
    pattern: /^\/api\/cli\/artifacts\/[^/]+\/download(?:\/.*)?$/,
  },
  { method: 'GET', pattern: /^\/api\/cli\/artifacts\/[^/]+\/comments$/ },
  { method: 'POST', pattern: /^\/api\/cli\/artifacts\/[^/]+\/comments$/ },
  { method: 'POST', pattern: /^\/api\/cli\/artifacts\/[^/]+\/append$/ },
  { method: 'GET', pattern: /^\/api\/cli\/projects$/ },
  { method: 'POST', pattern: /^\/api\/shareables\/uploads$/ },
  { method: 'POST', pattern: /^\/api\/shareables\/[^/]+\/versions$/ },
]

const PUBLISHER_RULES: Rule[] = [
  { method: 'GET', pattern: /^\/api\/cli\/artifacts\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/cli\/artifacts\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/cli\/shareables\/[^/]+\/edit$/ },
  { method: 'PATCH', pattern: /^\/api\/cli\/shareables\/[^/]+\/edit$/ },
  ...BOOTSTRAP_RULES,
  { method: 'POST', pattern: /^\/api\/shareables\/uploads$/ },
  { method: 'POST', pattern: /^\/api\/shareables\/[^/]+\/versions$/ },
  { method: 'GET', pattern: /^\/api\/cli\/artifacts\/[^/]+\/download$/ },
]

const BRIDGE_RULES: Rule[] = [
  { method: 'GET', pattern: /^\/api\/bridge\/v1\/health$/ },
  { method: 'POST', pattern: /^\/api\/bridge\/v1\/requests$/ },
]

export function allowsCliOperation(
  authority: CliAuthority,
  method: string,
  pathname: string,
) {
  let rules: Rule[]
  switch (authority.kind) {
    case 'unrestricted':
      return true
    case 'bootstrap':
      rules = BOOTSTRAP_RULES
      break
    case 'agent':
      rules = AGENT_RULES
      break
    case 'publisher':
      rules = PUBLISHER_RULES
      break
    case 'bridge':
      rules = BRIDGE_RULES
      break
    default: {
      const unexpected: never = authority
      void unexpected
      return false
    }
  }
  return rules.some(
    (rule) => rule.method === method && rule.pattern.test(pathname),
  )
}

export function cliScopeDeniedResponse() {
  return Response.json(
    {
      error: {
        code: 'scope-denied',
        message: 'This credential cannot perform that operation.',
        why: 'The operation is outside the approved agent scope.',
        hint: 'Use an approved operation or ask a person to perform this action.',
        recovery: { kind: 'ask_human' },
      },
      agent_recoverable: false,
      requires_human: true,
    },
    { status: 403 },
  )
}
