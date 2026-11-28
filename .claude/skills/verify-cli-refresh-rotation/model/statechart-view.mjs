// View for the pstack /statechart skill: labels CliRefreshRotation states and
// steps in the words of someone who uses the CLI and the settings page.
const values = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}))

const liveTokens = (v) => values(v.cred).filter((c) => c.ex && !c.revoked).length
const sessions = (v, link) => values(v.sess).filter((s) => s.ex && s.link === link).length

export const title = 'CLI refresh token rotation and sign-out'

export const state = (v) => {
  const tokens = liveTokens(v)
  const family =
    tokens === 0 ? 'No working refresh token' : tokens === 1 ? 'One working refresh token' : 'Two working refresh tokens'
  const linked = sessions(v, 'family') > 0 ? 'CLI session live' : 'No CLI session'
  const unlinked = sessions(v, 'none') > 0 ? ', device-login session live' : ''
  return {
    Family: `${family}, ${linked}${unlinked}`,
    'You': v.signOut === 'done' ? 'Signed out every CLI' : v.logout === 'done' ? 'Logged out' : 'Signed in',
  }
}

export const group = (v) => (v.signOut === 'done' || v.logout === 'done' ? 'signed out' : 'signed in')

export const colors = { 'signed in': 'blue', 'signed out': 'tan' }

const LABELS = {
  RotateRead: 'a CLI reads its refresh token',
  RotateBatch: 'the rotation commits',
  RotateReplay: 'the CLI gets its refresh result',
  LegacyRead: 'an old CLI reads its refresh token',
  LegacyBatch: 'the old CLI gets a new session',
  LegacyCheck: 'the old CLI gets its refresh result',
  LogoutPrecheck: 'you log out of the CLI',
  LogoutBatch: 'the logout commits',
  SignOutAllBatch: 'you sign out every CLI',
  DeviceLogin: 'a device login makes a CLI session',
}

export const step = (action) => LABELS[action] ?? null
