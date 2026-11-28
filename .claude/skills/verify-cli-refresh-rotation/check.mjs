#!/usr/bin/env node
// Model-checks the CLI refresh-credential rotation and revocation model with TLC.
// Usage: node .claude/skills/verify-cli-refresh-rotation/check.mjs [--keep]
// The runner is scripts/lib/tlc-check.mjs; this file records what to expect.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runModelChecks } from '../../../scripts/lib/tlc-check.mjs'

export const COVERS = [
  'apps/web/app/services/cli-refresh-credentials.server.ts',
  'apps/web/app/services/auth.server.ts',
  'apps/web/app/lib/d1-batch.server.ts',
]

// Invariants the current code is known to break. Each entry is a reported
// finding, not a pass. Remove the entry when the code is fixed.
const KNOWN_FINDINGS = {
  SignOutAllEndsEveryCliSession:
    'Sign out every CLI keeps a device-login CLI session alive when no CLI family is live at that moment.',
}

// Narrower scopes where a known finding cannot happen, so a mutation of the code
// that the finding's invariant guards still has a passing baseline to break.
const SCOPED_BASELINES = [
  { invariant: 'SignOutAllEndsEveryCliSession', constants: { LogoutEnabled: 'FALSE' } },
]

const MUTATIONS = [
  {
    name: 'rotate-ignores-revoked',
    code: "refreshCliSession: the rotate UPDATE loses .where('revoked_at', 'is', null)",
    find: 'c1 == IF cred[t].ex /\\ ~cred[t].revoked',
    replace: 'c1 == IF cred[t].ex',
    breaks: 'NoFork',
  },
  {
    name: 'replay-returns-rotated-successor',
    code: "readRotationReplay loses .where('next.revoked_at', 'is', null)",
    find: '/\\ ~cred[next].revoked',
    replace: '/\\ TRUE',
    breaks: 'RotationRepliesAreLive',
  },
  {
    name: 'replay-ignores-request-id',
    code: "readRotationReplay loses .where('old.rotation_request_hash', '=', requestHash)",
    find: 'found == /\\ cred[t].req = r',
    replace: 'found == /\\ TRUE',
    breaks: 'RepliesMatchTheirRotation',
  },
  {
    name: 'legacy-session-ignores-revocation',
    code: "refreshLegacyCliSession: the session INSERT loses .where('revoked_at', 'is', null)",
    find: 's1 == IF ~cred[Root].revoked',
    replace: 's1 == IF TRUE',
    breaks: 'LogoutIsFinal',
  },
  {
    name: 'logout-keeps-linked-sessions',
    code: 'revokeCliRefreshCredentialFamilyAtomic drops linkedSessions from its batch',
    find: 'THEN DeleteSessions(sess, LinkedSessions(sess)) ELSE sess',
    replace: 'THEN sess ELSE sess',
    breaks: 'LogoutIsFinal',
  },
  {
    name: 'sign-out-all-keeps-linked-sessions',
    code: 'buildCliRefreshCredentialRevocationStatements drops linkedSessions',
    find: 'THEN DeleteSessions(s2, LinkedSessions(s2)) ELSE s2',
    replace: 'THEN s2 ELSE s2',
    breaks: 'SignOutAllIsFinal',
  },
  {
    name: 'sign-out-all-without-batch-mark',
    code: 'activeFamilies() loses the credential.revocation_batch_id disjunct',
    find: '\\/ \\E i \\in CredIds : c[i].ex /\\ c[i].mark',
    replace: '\\/ FALSE',
    breaks: 'SignOutAllEndsEveryCliSession',
    constants: { LogoutEnabled: 'FALSE' },
  },
]

if (import.meta.main)
  await runModelChecks({
    modelDir: join(dirname(fileURLToPath(import.meta.url)), 'model'),
    module: 'CliRefreshRotation',
    knownFindings: KNOWN_FINDINGS,
    scopedBaselines: SCOPED_BASELINES,
    mutations: MUTATIONS,
  })
