import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadDeviceAgentApproval } from './auth-client'

// Fail even if a previous build left contract dist files available. Type-only
// imports disappear; any runtime import from auth-client executes this factory.
vi.mock('@artifactshare/contract', () => {
  throw new Error('Browser auth-client must not load the contract at runtime')
})

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({}),
}))
vi.mock('@better-auth/oauth-provider/client', () => ({
  oauthProviderClient: () => ({}),
}))
vi.mock('better-auth/client/plugins', () => ({
  deviceAuthorizationClient: () => ({}),
  emailOTPClient: () => ({}),
}))

afterEach(() => vi.unstubAllGlobals())

function respond(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json(body, { status })),
  )
}

const approval = {
  preset: 'publisher',
  requestedName: 'Dashboard',
  clients: [{ id: 'client-1', name: 'Reports' }],
}

describe('loadDeviceAgentApproval', () => {
  it('loads publisher context without a runtime contract dependency', async () => {
    respond({ publisherApproval: approval, agentApproval: null })
    await expect(loadDeviceAgentApproval('ABCD EFGH')).resolves.toEqual(
      approval,
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/cli/device-approval?user_code=ABCD%20EFGH',
      { headers: { accept: 'application/json' } },
    )
  })

  it('normalizes names and strips unknown fields like the contract', async () => {
    respond({
      publisherApproval: {
        ...approval,
        requestedName: '  Cafe\u0301  ',
        ignored: true,
        clients: [{ id: 'client-1', name: '  日報 (1)._ -  ', ignored: true }],
      },
    })
    await expect(loadDeviceAgentApproval('code')).resolves.toEqual({
      preset: 'publisher',
      requestedName: 'Café',
      clients: [{ id: 'client-1', name: '日報 (1)._ -' }],
    })
  })

  it('accepts 100 Unicode code points and an empty client list', async () => {
    const value = { ...approval, requestedName: '𐐀'.repeat(100), clients: [] }
    respond({ publisherApproval: value })
    await expect(loadDeviceAgentApproval('code')).resolves.toEqual(value)
  })

  it.each([
    '',
    '   ',
    'a'.repeat(101),
    '<script>',
    'line\nbreak',
    'a\u0000b',
    'a\u200db',
    '\u0301',
    null,
    123,
  ])(
    'rejects invalid requested and existing client names: %j',
    async (name) => {
      for (const value of [
        { ...approval, requestedName: name },
        { ...approval, clients: [{ id: 'client-1', name }] },
      ]) {
        respond({
          publisherApproval: value,
          agentApproval: { preset: 'agent' },
        })
        await expect(loadDeviceAgentApproval('code')).rejects.toThrow()
      }
    },
  )

  it.each([
    {},
    'publisher',
    { ...approval, preset: 'unrestricted' },
    { ...approval, requestedName: undefined },
    { ...approval, clients: undefined },
    { ...approval, clients: null },
    { ...approval, clients: [{}] },
    { ...approval, clients: [{ id: '', name: 'Reports' }] },
    { ...approval, clients: [{ id: 123, name: 'Reports' }] },
  ])('fails closed for malformed publisher context: %j', async (value) => {
    respond({ publisherApproval: value, agentApproval: { preset: 'agent' } })
    await expect(loadDeviceAgentApproval('code')).rejects.toThrow()
  })

  it('preserves agent and absent approval responses', async () => {
    const agentApproval = {
      preset: 'agent',
      deviceName: null,
      projectSelector: null,
      fixedProject: null,
      fixedProjectError: false,
    }
    respond({ agentApproval, publisherApproval: null })
    await expect(loadDeviceAgentApproval('code')).resolves.toEqual(
      agentApproval,
    )
    respond({ agentApproval: null })
    await expect(loadDeviceAgentApproval('code')).resolves.toBeNull()
  })

  it('rejects unsuccessful responses', async () => {
    respond({ publisherApproval: approval }, 403)
    await expect(loadDeviceAgentApproval('code')).rejects.toThrow(
      'Unable to load approval context',
    )
  })
})
