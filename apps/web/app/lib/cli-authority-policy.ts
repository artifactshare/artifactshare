import type { DB } from '~/types/db'
import type { CliAuthority } from '~/services/cli-authority.server'

/** Existing local read policy; middleware separately limits reachable routes. */
export function cliReadAuthority(authority: CliAuthority | null | undefined) {
  if (!authority) return null
  switch (authority.kind) {
    case 'publisher':
      return 'denied'
    case 'agent':
      return authority
    case 'unrestricted':
    case 'bootstrap':
    case 'bridge':
      return null
    default: {
      const unexpected: never = authority
      void unexpected
      return 'denied'
    }
  }
}

/** Browser users and the historical bootstrap lookup use human write rules. */
export function cliWriteAuthority(authority: CliAuthority | null | undefined) {
  if (!authority) return null
  switch (authority.kind) {
    case 'agent':
      return authority
    case 'unrestricted':
    case 'bootstrap':
      return null
    case 'bridge':
    case 'publisher':
      return 'denied'
    default: {
      const unexpected: never = authority
      void unexpected
      return 'denied'
    }
  }
}

export function allowsHumanCliMutation(
  authority: CliAuthority | null | undefined,
  allowBootstrap = false,
) {
  if (!authority) return true
  switch (authority.kind) {
    case 'unrestricted':
      return true
    case 'bootstrap':
      return allowBootstrap
    case 'agent':
    case 'bridge':
    case 'publisher':
      return false
    default: {
      const unexpected: never = authority
      void unexpected
      return false
    }
  }
}

export function bridgeCliAuthority(authority: CliAuthority | null | undefined) {
  if (!authority) return null
  switch (authority.kind) {
    case 'bridge':
      return authority
    case 'unrestricted':
    case 'bootstrap':
    case 'agent':
    case 'publisher':
      return null
    default: {
      const unexpected: never = authority
      void unexpected
      return null
    }
  }
}

export function isRecognizedCliPreset(
  preset: DB['cli_family_authorities']['preset'] | null,
) {
  if (preset === null) return false
  switch (preset) {
    case 'unrestricted':
    case 'agent':
    case 'publisher':
      return true
    default: {
      const unexpected: never = preset
      void unexpected
      return false
    }
  }
}

export function isRecognizedCliSessionKind(
  kind: DB['cli_session_authorities']['kind'] | null,
) {
  if (kind === null) return false
  switch (kind) {
    case 'bootstrap':
    case 'family':
      return true
    default: {
      const unexpected: never = kind
      void unexpected
      return false
    }
  }
}
