import { PublisherApprovalSchema } from '@artifactshare/contract'
import { afterEach, expect, it, vi } from 'vitest'
import { loadDeviceAgentApproval } from './auth-client'

// auth-client.ts carries its own copy of the publisher approval schema so the
// sign-in, consent and device routes do not pull the contract into their
// browser chunk, which `auth-client.test.ts` holds them to. This file is the
// other half of that trade: it runs the copy and the contract over the same
// inputs and fails when the two stop agreeing. The copy is reached through
// `loadDeviceAgentApproval`, so nothing has to be exported for the comparison.
//
// `loadDeviceAgentApproval` only parses a truthy `publisherApproval`, so every
// case below is truthy.

vi.mock('better-auth/react', () => ({ createAuthClient: () => ({}) }))
vi.mock('@better-auth/oauth-provider/client', () => ({
  oauthProviderClient: () => ({}),
}))
vi.mock('better-auth/client/plugins', () => ({
  deviceAuthorizationClient: () => ({}),
  emailOTPClient: () => ({}),
}))

afterEach(() => vi.unstubAllGlobals())

const approval = {
  preset: 'publisher',
  requestedName: 'Dashboard',
  clients: [{ id: 'client-1', name: 'Reports' }],
}

const names = [
  'Dashboard',
  '  Café  ',
  '日報 (1)._ -',
  '𐐀'.repeat(100),
  '𐐀'.repeat(101),
  'a'.repeat(100),
  'a'.repeat(101),
  '.',
  '   ',
  '',
  '<script>',
  'line\nbreak',
  'a\u0000b',
  'a‍b',
  '́',
  '－',
  '😀',
  'tab\there',
  null,
  123,
  true,
  {},
]

const cases: unknown[] = [
  approval,
  { ...approval, clients: [] },
  { ...approval, ignored: true },
  { ...approval, clients: [{ id: 'client-1', name: 'Reports', extra: 1 }] },
  { ...approval, clients: [{ id: 'client-1', name: '  日報 (1)._ -  ' }] },
  { ...approval, preset: 'unrestricted' },
  { ...approval, preset: undefined },
  { ...approval, requestedName: undefined },
  { ...approval, clients: undefined },
  { ...approval, clients: null },
  { ...approval, clients: {} },
  { ...approval, clients: [{}] },
  { ...approval, clients: [{ id: '', name: 'Reports' }] },
  { ...approval, clients: [{ id: 123, name: 'Reports' }] },
  { ...approval, clients: [{ name: 'Reports' }] },
  {},
  'publisher',
  42,
  [approval],
  ...names.map((name) => ({ ...approval, requestedName: name })),
  ...names.map((name) => ({ ...approval, clients: [{ id: 'c', name }] })),
]

it.each(cases.map((value, index) => [index, value] as const))(
  'case %i parses in the browser copy exactly as the contract does: %j',
  async (_index, value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ publisherApproval: value })),
    )
    const contract = PublisherApprovalSchema.safeParse(value)
    if (contract.success)
      await expect(loadDeviceAgentApproval('code')).resolves.toEqual(
        contract.data,
      )
    else await expect(loadDeviceAgentApproval('code')).rejects.toThrow()
  },
)
