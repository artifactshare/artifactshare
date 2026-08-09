import { spawnFile } from './process.js'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { baseUrlOf } from './api.js'
import { readJsonFile } from './destination.js'
import { isRecord, nonEmpty } from './validators.js'

export { nonEmpty }
import type {
  CliOptions,
  GlobalConfig,
  PendingDeviceAuth,
  StoredProfileCredential,
  TokenStoreKind,
} from './types.js'

const SERVICE = 'artifactshare-cli'

export type StoredToken =
  | {
      ok: true
      token: string
      store: TokenStoreKind
      credential: StoredProfileCredential
    }
  | { ok: false; reason: 'missing' | 'unavailable' | 'legacy' }

export type SaveTokenResult =
  | { ok: true; store: TokenStoreKind }
  | { ok: false; reason: 'unavailable' }

export type DeleteProfileCredentialResult =
  | {
      ok: true
      credential_removed: boolean
      token_store: TokenStoreKind | null
    }
  | { ok: false; reason: 'unavailable' }

export async function readProfileToken(
  profile: string,
  options: CliOptions,
): Promise<StoredToken> {
  const account = accountName(profile, baseUrlOf(options))
  const native = await nativeStore()
  if (native) {
    const raw = await native.read(account)
    const parsed = parseStoredProfileCredential(raw)
    if (parsed.ok) return { ...parsed, store: native.kind }
    if (parsed.reason === 'legacy') return parsed
  }
  // The flag gates plaintext *writes* only; an existing 0600 file is always
  // readable so commands after `login --allow-plaintext-token-store` work
  // without repeating the flag.
  const plaintext = parseStoredProfileCredential(
    await readPlaintextToken(account),
  )
  if (plaintext.ok) return { ...plaintext, store: 'plaintext_file' }
  if (plaintext.reason === 'legacy') return plaintext
  return {
    ok: false,
    reason:
      native || options.allowPlaintextTokenStore ? 'missing' : 'unavailable',
  }
}

export async function saveProfileSessionCredential(
  profile: string,
  credential: Extract<StoredProfileCredential, { kind: 'session' }>,
  options: CliOptions,
): Promise<SaveTokenResult> {
  return await saveProfileCredential(profile, credential, options)
}

export async function saveProfileApiTokenCredential(
  profile: string,
  credential: Extract<StoredProfileCredential, { kind: 'api_token' }>,
  options: CliOptions,
): Promise<SaveTokenResult> {
  return await saveProfileCredential(profile, credential, options)
}

async function saveProfileCredential(
  profile: string,
  credential: StoredProfileCredential,
  options: CliOptions,
): Promise<SaveTokenResult> {
  const account = accountName(profile, baseUrlOf(options))
  const value = JSON.stringify(credential)
  const native = await nativeStore()
  if (native && (await native.write(account, value))) {
    return { ok: true, store: native.kind }
  }
  const hasPlaintextEntry = (await readPlaintextToken(account)) !== null
  if (
    (options.allowPlaintextTokenStore || hasPlaintextEntry) &&
    (await writePlaintextToken(account, value))
  ) {
    return { ok: true, store: 'plaintext_file' }
  }
  return { ok: false, reason: 'unavailable' }
}

export async function deleteProfileCredential(
  profile: string,
  options: CliOptions,
): Promise<DeleteProfileCredentialResult> {
  const account = accountName(profile, baseUrlOf(options))
  let credentialRemoved = false
  let tokenStore: TokenStoreKind | null = null
  const native = await nativeStore()
  if (native) {
    const raw = await native.read(account)
    if (raw) {
      if (!(await native.delete(account))) {
        return { ok: false, reason: 'unavailable' }
      }
      credentialRemoved = true
      tokenStore = native.kind
    }
  }
  if ((await readPlaintextToken(account)) !== null) {
    if (!(await deletePlaintextTokenAccount(account))) {
      return { ok: false, reason: 'unavailable' }
    }
    credentialRemoved = true
    tokenStore ??= 'plaintext_file'
  }
  return {
    ok: true,
    credential_removed: credentialRemoved,
    token_store: tokenStore,
  }
}

function parseStoredProfileCredential(
  raw: string | null,
):
  | { ok: true; token: string; credential: StoredProfileCredential }
  | { ok: false; reason: 'missing' | 'legacy' } {
  if (!raw) return { ok: false, reason: 'missing' }
  const parsed = parseJsonRecord(raw)
  if (!parsed) return { ok: false, reason: 'legacy' }
  if (
    parsed.kind === 'session' &&
    typeof parsed.session_token === 'string' &&
    parsed.session_token &&
    typeof parsed.refresh_token === 'string' &&
    parsed.refresh_token &&
    (typeof parsed.expires_at === 'string' ||
      parsed.expires_at === null ||
      parsed.expires_at === undefined)
  ) {
    const credential: StoredProfileCredential = {
      kind: 'session',
      session_token: parsed.session_token,
      refresh_token: parsed.refresh_token,
      ...(parsed.expires_at !== undefined
        ? { expires_at: parsed.expires_at }
        : {}),
      ...(typeof parsed.pending_rotation_id === 'string' &&
      parsed.pending_rotation_id
        ? { pending_rotation_id: parsed.pending_rotation_id }
        : {}),
    }
    return { ok: true, token: credential.session_token, credential }
  }
  if (
    parsed.kind === 'api_token' &&
    typeof parsed.token === 'string' &&
    parsed.token
  ) {
    const credential: StoredProfileCredential = {
      kind: 'api_token',
      token: parsed.token,
    }
    return { ok: true, token: credential.token, credential }
  }
  return { ok: false, reason: 'legacy' }
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function readGlobalConfig(): Promise<GlobalConfig | null> {
  const home = configHome()
  if (!home) return null
  return await readJsonFile<GlobalConfig>(join(home, 'config.json'))
}

export async function writeGlobalConfig(
  config: GlobalConfig,
): Promise<boolean> {
  const home = configHome()
  if (!home) return false
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(
    join(home, 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  )
  return true
}

export async function updateGlobalConfig(
  update: (config: GlobalConfig) => GlobalConfig,
): Promise<boolean> {
  return writeGlobalConfig(update((await readGlobalConfig()) ?? {}))
}

function accountName(profile: string, baseUrl: string): string {
  return `${baseUrl}:${profile}`
}

type NativeStore = {
  kind: Exclude<TokenStoreKind, 'plaintext_file'>
  read: (account: string) => Promise<string | null>
  write: (account: string, token: string) => Promise<boolean>
  delete: (account: string) => Promise<boolean>
}

let nativeStorePromise: Promise<NativeStore | null> | undefined

function nativeStore(): Promise<NativeStore | null> {
  // Test seam, checked outside the memo: keeps the test suite away from the
  // developer's real keychain even when tests share a process.
  if (process.env.ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE === '1') {
    return Promise.resolve(null)
  }
  return (nativeStorePromise ??= detectNativeStore())
}

async function detectNativeStore(): Promise<NativeStore | null> {
  if (process.platform === 'darwin') return macosKeychain()
  if (process.platform === 'linux') return await linuxSecretService()
  return null
}

function macosKeychain(): NativeStore {
  return {
    kind: 'macos_keychain',
    read: async (account) => {
      const result = await spawnFile('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
      ])
      return result.status === 0 ? result.stdout.trim() || null : null
    },
    // `security -i` reads the command from stdin so the token never appears
    // in the process argument list.
    write: async (account, token) => {
      const command = [
        'add-generic-password',
        '-U',
        '-s',
        securityQuote(SERVICE),
        '-a',
        securityQuote(account),
        '-w',
        securityQuote(token),
      ].join(' ')
      const result = await spawnFile('security', ['-i'], `${command}\n`)
      return result.status === 0
    },
    delete: async (account) => {
      const result = await spawnFile('security', [
        'delete-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
      ])
      return result.status === 0
    },
  }
}

function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function linuxSecretService(): Promise<NativeStore | null> {
  const probe = await spawnFile('secret-tool', ['--version'])
  if (probe.status !== 0) return null
  return {
    kind: 'linux_secret_service',
    read: async (account) => {
      const result = await spawnFile('secret-tool', [
        'lookup',
        'service',
        SERVICE,
        'account',
        account,
      ])
      return result.status === 0 ? result.stdout.trim() || null : null
    },
    write: async (account, token) => {
      const result = await spawnFile(
        'secret-tool',
        [
          'store',
          '--label',
          `Artifact Share ${account}`,
          'service',
          SERVICE,
          'account',
          account,
        ],
        token,
      )
      return result.status === 0
    },
    delete: async (account) => {
      const result = await spawnFile('secret-tool', [
        'clear',
        'service',
        SERVICE,
        'account',
        account,
      ])
      return result.status === 0
    },
  }
}

async function deletePlaintextTokenAccount(account: string): Promise<boolean> {
  const tokens = await readPlaintextTokens()
  if (!tokens || !Object.hasOwn(tokens, account)) return false
  const home = configHome()
  if (!home) return false
  const { [account]: _removed, ...rest } = tokens
  await mkdir(home, { recursive: true, mode: 0o700 })
  const path = plaintextTokensPath(home)
  if (Object.keys(rest).length === 0) {
    await writeFile(path, '{}\n', { mode: 0o600 })
  } else {
    await writeFile(path, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 })
  }
  await chmod(path, 0o600)
  return true
}

async function readPlaintextToken(account: string): Promise<string | null> {
  const tokens = await readPlaintextTokens()
  const token = tokens?.[account]
  return typeof token === 'string' && token ? token : null
}

async function writePlaintextToken(
  account: string,
  token: string,
): Promise<boolean> {
  const home = configHome()
  if (!home) return false
  const tokens = (await readPlaintextTokens()) ?? {}
  tokens[account] = token
  await mkdir(home, { recursive: true, mode: 0o700 })
  const path = plaintextTokensPath(home)
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, {
    mode: 0o600,
  })
  await chmod(path, 0o600)
  return true
}

async function readPlaintextTokens(): Promise<Record<string, unknown> | null> {
  const home = configHome()
  if (!home) return null
  const raw = await readFile(plaintextTokensPath(home), 'utf8').catch(
    () => null,
  )
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function plaintextTokensPath(home: string): string {
  return join(home, 'tokens.json')
}

// Returns null when no user config location exists; callers must not fall
// back to the working directory (tokens must never land in a checked-out
// repo, and a repo-local config.json must not influence credential
// resolution).
function pendingDeviceAuthPath(home: string): string {
  return join(home, 'pending-device-auth.json')
}

function pendingDeviceAuthKey(baseUrl: string, profile: string): string {
  return `${baseUrl}:${profile}`
}

export async function readPendingDeviceAuth(
  baseUrl: string,
  profile: string,
): Promise<PendingDeviceAuth | null> {
  const home = configHome()
  if (!home) return null
  const raw = await readFile(pendingDeviceAuthPath(home), 'utf8').catch(
    () => null,
  )
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const entry = parsed[pendingDeviceAuthKey(baseUrl, profile)]
    return isPendingDeviceAuth(entry) ? entry : null
  } catch {
    return null
  }
}

export async function writePendingDeviceAuth(
  pending: PendingDeviceAuth,
): Promise<boolean> {
  const home = configHome()
  if (!home) return false
  const path = pendingDeviceAuthPath(home)
  const existing = await readFile(path, 'utf8')
    .then((raw) => {
      try {
        const parsed: unknown = JSON.parse(raw)
        return isRecord(parsed) ? parsed : {}
      } catch {
        return {}
      }
    })
    .catch(() => ({}))
  const key = pendingDeviceAuthKey(pending.base_url, pending.profile)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    `${JSON.stringify({ ...existing, [key]: pending }, null, 2)}\n`,
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
  return true
}

export async function clearPendingDeviceAuth(
  baseUrl: string,
  profile: string,
): Promise<void> {
  const home = configHome()
  if (!home) return
  const path = pendingDeviceAuthPath(home)
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (!raw) return
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return
    const key = pendingDeviceAuthKey(baseUrl, profile)
    if (!Object.hasOwn(parsed, key)) return
    const { [key]: _removed, ...rest } = parsed
    if (Object.keys(rest).length === 0) {
      await writeFile(path, '{}\n', { mode: 0o600 })
      return
    }
    await writeFile(path, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 })
  } catch {
    return
  }
}

function isPendingDeviceAuth(value: unknown): value is PendingDeviceAuth {
  if (!isRecord(value)) return false
  return (
    typeof value.base_url === 'string' &&
    typeof value.profile === 'string' &&
    typeof value.device_code === 'string' &&
    typeof value.verification_uri === 'string' &&
    (typeof value.verification_uri_complete === 'string' ||
      value.verification_uri_complete === null) &&
    typeof value.user_code === 'string' &&
    typeof value.expires_at === 'string' &&
    typeof value.interval_seconds === 'number' &&
    typeof value.created_at === 'string'
  )
}

export function configHome(): string | null {
  const override = nonEmpty(process.env.ARTIFACTSHARE_CONFIG_HOME)
  if (override) return override
  const xdgConfigHome = nonEmpty(process.env.XDG_CONFIG_HOME)
  if (xdgConfigHome) return join(xdgConfigHome, 'artifactshare')
  const home = nonEmpty(process.env.HOME)
  if (home) return join(home, '.config/artifactshare')
  return null
}
