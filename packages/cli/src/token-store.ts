import { spawnFile } from './process.js'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
      native || (options.allowPlaintextTokenStore && plaintextStoreWritable())
        ? 'missing'
        : 'unavailable',
  }
}

// Cheap, non-destructive predicate mirroring saveProfileCredential's success
// conditions. Used before consuming a one-time bot token so a locally
// detectable "nowhere to store it" failure never costs the token. An actual
// write can still fail afterwards (e.g. keychain denial mid-flight); that
// residual case keeps its explicit lost-token error.
export async function probeTokenStoreWritable(
  profile: string,
  options: CliOptions,
  // A forced import deletes the existing entry before saving, so that entry
  // cannot serve as proof that a plaintext write will be allowed afterwards.
  {
    ignoreExistingEntry = false,
    platform = process.platform,
  }: { ignoreExistingEntry?: boolean; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const native = await nativeStore()
  if (native) return true
  if (options.allowPlaintextTokenStore) return plaintextStoreWritable(platform)
  if (ignoreExistingEntry) return false
  if (!plaintextFallbackSupported(platform)) return false
  const account = accountName(profile, baseUrlOf(options))
  return (await readPlaintextToken(account)) !== null
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
    // A pre-upgrade Windows install may still have an explicit plaintext
    // credential. Once the native write commits, remove that legacy copy on a
    // best-effort basis without turning a successful native save into failure.
    if (process.platform === 'win32') {
      await deletePlaintextTokenAccount(account).catch(() => false)
    }
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
      ...(typeof parsed.device_id === 'string' && parsed.device_id
        ? { device_id: parsed.device_id }
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

export type NativeStore = {
  kind: Exclude<TokenStoreKind, 'plaintext_file'>
  read: (account: string) => Promise<string | null>
  write: (account: string, token: string) => Promise<boolean>
  delete: (account: string) => Promise<boolean>
}

type ProcessRunner = typeof spawnFile

export type TokenStoreDiagnostics = {
  config_home: string | null
  native_store: Exclude<TokenStoreKind, 'plaintext_file'> | 'none'
  plaintext_credentials: number
  plaintext_protection: 'mode_0600' | 'unavailable'
}

let nativeStorePromise: Promise<NativeStore | null> | undefined

function nativeStore(): Promise<NativeStore | null> {
  // Test seam, checked outside the memo: keeps the test suite away from the
  // developer's real keychain even when tests share a process.
  if (process.env.ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE === '1') {
    return Promise.resolve(null)
  }
  return (nativeStorePromise ??= detectNativeStore(process.platform))
}

export async function detectNativeStore(
  platform: NodeJS.Platform,
  run: ProcessRunner = spawnFile,
): Promise<NativeStore | null> {
  if (platform === 'darwin') return macosKeychain(run)
  if (platform === 'linux') return await linuxSecretService(run)
  if (platform === 'win32') return await windowsCredentialManager(run)
  return null
}

function macosKeychain(run: ProcessRunner): NativeStore {
  return {
    kind: 'macos_keychain',
    read: async (account) => {
      const result = await run('security', [
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
      const result = await run('security', ['-i'], `${command}\n`)
      return result.status === 0
    },
    delete: async (account) => {
      const result = await run('security', [
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

async function linuxSecretService(
  run: ProcessRunner,
): Promise<NativeStore | null> {
  const probe = await run('secret-tool', ['--version'])
  if (probe.status !== 0) return null
  return {
    kind: 'linux_secret_service',
    read: async (account) => {
      const result = await run('secret-tool', [
        'lookup',
        'service',
        SERVICE,
        'account',
        account,
      ])
      return result.status === 0 ? result.stdout.trim() || null : null
    },
    write: async (account, token) => {
      const result = await run(
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
      const result = await run('secret-tool', [
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

// Windows PowerShell 5.1 has no built-in Credential Manager cmdlets. This
// script calls the native Credential Manager API directly. The credential
// value travels over stdin and never appears in the process argument list.
const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ArtifactShareCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref Credential credential, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  private static extern void CredFree(IntPtr credential);

  private const UInt32 Generic = 1;
  private const UInt32 PersistLocalMachine = 2;
  private const int ErrorNotFound = 1168;

  public static bool Probe() { return true; }

  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == ErrorNotFound) return null;
      throw new Win32Exception(error);
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] value = new byte[credential.CredentialBlobSize];
      if (value.Length > 0) Marshal.Copy(credential.CredentialBlob, value, 0, value.Length);
      return value;
    } finally {
      CredFree(pointer);
    }
  }

  public static void Write(string target, byte[] value) {
    IntPtr blob = Marshal.AllocHGlobal(value.Length);
    try {
      if (value.Length > 0) Marshal.Copy(value, 0, blob, value.Length);
      Credential credential = new Credential {
        Type = Generic,
        TargetName = target,
        CredentialBlobSize = (UInt32)value.Length,
        CredentialBlob = blob,
        Persist = PersistLocalMachine,
        UserName = Environment.UserName
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, Generic, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != ErrorNotFound) throw new Win32Exception(error);
    }
  }
}
'@

$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$request = $requestJson | ConvertFrom-Json
$target = 'artifactshare-cli:' + [string]$request.account
$chunkSize = 2400
$chunkMarker = 'artifactshare-chunks-v1:'
$deletingMarker = 'artifactshare-chunks-deleting-v1:'
$cleanupMarker = 'artifactshare-chunks-cleanup-v1:'

function Get-ChunkManifest([byte[]]$bytes, [string]$marker = $chunkMarker) {
  if ($null -eq $bytes) { return $null }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if (-not $text.StartsWith($marker)) { return $null }
  $parts = $text.Substring($marker.Length).Split(':')
  $count = 0
  if ($parts.Length -ne 2 -or -not [int]::TryParse($parts[1], [ref]$count) -or $count -lt 1) {
    throw 'Invalid chunked credential manifest.'
  }
  return [PSCustomObject]@{ Version = $parts[0]; Count = $count }
}

function Get-CleanupManifest([byte[]]$bytes) {
  if ($null -eq $bytes) { return $null }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if (-not $text.StartsWith($cleanupMarker)) { return $null }
  $parts = $text.Substring($cleanupMarker.Length).Split(':')
  $activeCount = 0
  $staleCount = 0
  if (
    $parts.Length -ne 4 -or
    -not [int]::TryParse($parts[1], [ref]$activeCount) -or
    -not [int]::TryParse($parts[3], [ref]$staleCount) -or
    $activeCount -lt 1 -or
    $staleCount -lt 1
  ) {
    throw 'Invalid credential cleanup manifest.'
  }
  return [PSCustomObject]@{
    Active = [PSCustomObject]@{ Version = $parts[0]; Count = $activeCount }
    Stale = [PSCustomObject]@{ Version = $parts[2]; Count = $staleCount }
  }
}

function Remove-CredentialChunks($manifest) {
  if ($null -eq $manifest) { return }
  for ($index = 0; $index -lt $manifest.Count; $index++) {
    [ArtifactShareCredentialManager]::Delete(($target + ':chunk:' + $manifest.Version + ':' + $index))
  }
}

switch ([string]$request.operation) {
  'probe' { [void][ArtifactShareCredentialManager]::Probe() }
  'read' {
    $bytes = [ArtifactShareCredentialManager]::Read($target)
    $deletingManifest = Get-ChunkManifest $bytes $deletingMarker
    if ($null -ne $deletingManifest) { break }
    $cleanupManifest = Get-CleanupManifest($bytes)
    $manifest = if ($null -ne $cleanupManifest) {
      $cleanupManifest.Active
    } else {
      Get-ChunkManifest($bytes)
    }
    if ($null -ne $manifest) {
      $stream = New-Object IO.MemoryStream
      try {
        for ($index = 0; $index -lt $manifest.Count; $index++) {
          $chunkTarget = $target + ':chunk:' + $manifest.Version + ':' + $index
          $chunk = [ArtifactShareCredentialManager]::Read($chunkTarget)
          if ($null -eq $chunk) { throw 'Credential chunk is missing.' }
          $stream.Write($chunk, 0, $chunk.Length)
        }
        $bytes = $stream.ToArray()
      } finally {
        $stream.Dispose()
      }
    }
    if ($null -ne $bytes) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }
  }
  'write' {
    $oldBytes = [ArtifactShareCredentialManager]::Read($target)
    $pendingCleanup = Get-CleanupManifest($oldBytes)
    if ($null -ne $pendingCleanup) {
      Remove-CredentialChunks($pendingCleanup.Stale)
      $oldManifest = $pendingCleanup.Active
      $oldBytes = [Text.Encoding]::UTF8.GetBytes(($chunkMarker + $oldManifest.Version + ':' + $oldManifest.Count))
      [ArtifactShareCredentialManager]::Write($target, $oldBytes)
    } else {
      $oldManifest = Get-ChunkManifest($oldBytes)
    }
    if ($null -eq $oldManifest) {
      $oldManifest = Get-ChunkManifest $oldBytes $deletingMarker
      if ($null -ne $oldManifest) {
        Remove-CredentialChunks($oldManifest)
        $oldManifest = $null
      }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
    if ($bytes.Length -le $chunkSize -and $null -eq $oldManifest) {
      [ArtifactShareCredentialManager]::Write($target, $bytes)
    } else {
      $version = [Guid]::NewGuid().ToString('N')
      $count = [int][Math]::Ceiling($bytes.Length / $chunkSize)
      $written = 0
      try {
        for ($index = 0; $index -lt $count; $index++) {
          $offset = [int]($index * $chunkSize)
          $length = [int][Math]::Min($chunkSize, $bytes.Length - $offset)
          $chunk = New-Object byte[] $length
          [Array]::Copy($bytes, $offset, $chunk, 0, $length)
          $chunkTarget = $target + ':chunk:' + $version + ':' + $index
          [ArtifactShareCredentialManager]::Write($chunkTarget, $chunk)
          $written++
        }
        $manifestBytes = [Text.Encoding]::UTF8.GetBytes(($chunkMarker + $version + ':' + $count))
        if ($null -ne $oldManifest) {
          $cleanupBytes = [Text.Encoding]::UTF8.GetBytes(
            ($cleanupMarker + $version + ':' + $count + ':' + $oldManifest.Version + ':' + $oldManifest.Count)
          )
          [ArtifactShareCredentialManager]::Write($target, $cleanupBytes)
          $written = 0
          Remove-CredentialChunks($oldManifest)
        }
        [ArtifactShareCredentialManager]::Write($target, $manifestBytes)
      } catch {
        for ($index = 0; $index -lt $written; $index++) {
          [ArtifactShareCredentialManager]::Delete(($target + ':chunk:' + $version + ':' + $index))
        }
        throw
      }
    }
  }
  'delete' {
    $bytes = [ArtifactShareCredentialManager]::Read($target)
    $pendingCleanup = Get-CleanupManifest($bytes)
    if ($null -ne $pendingCleanup) {
      Remove-CredentialChunks($pendingCleanup.Stale)
      $manifest = $pendingCleanup.Active
    } else {
      $manifest = Get-ChunkManifest($bytes)
    }
    if ($null -eq $manifest) {
      $manifest = Get-ChunkManifest $bytes $deletingMarker
    }
    if ($null -ne $manifest) {
      $deletingBytes = [Text.Encoding]::UTF8.GetBytes(($deletingMarker + $manifest.Version + ':' + $manifest.Count))
      [ArtifactShareCredentialManager]::Write($target, $deletingBytes)
      Remove-CredentialChunks($manifest)
    }
    [ArtifactShareCredentialManager]::Delete($target)
  }
  default { throw 'Unknown credential operation.' }
}
`

const WINDOWS_CREDENTIAL_COMMAND = Buffer.from(
  WINDOWS_CREDENTIAL_SCRIPT,
  'utf16le',
).toString('base64')

async function runWindowsCredentialOperation(
  run: ProcessRunner,
  operation: 'probe' | 'read' | 'write' | 'delete',
  account = '',
  value?: string,
) {
  return await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_CREDENTIAL_COMMAND,
    ],
    Buffer.from(
      JSON.stringify({
        operation,
        account,
        ...(value === undefined ? {} : { value }),
      }),
      'utf8',
    ).toString('base64'),
  )
}

async function windowsCredentialManager(
  run: ProcessRunner,
): Promise<NativeStore | null> {
  const probe = await runWindowsCredentialOperation(run, 'probe')
  if (probe.status !== 0) return null
  return {
    kind: 'windows_credential_manager',
    read: async (account) => {
      const result = await runWindowsCredentialOperation(run, 'read', account)
      if (result.status !== 0 || !result.stdout) return null
      return Buffer.from(result.stdout, 'base64').toString('utf8')
    },
    write: async (account, token) => {
      const result = await runWindowsCredentialOperation(
        run,
        'write',
        account,
        token,
      )
      return result.status === 0
    },
    delete: async (account) => {
      const result = await runWindowsCredentialOperation(run, 'delete', account)
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
  if (!plaintextFallbackSupported()) return false
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
    (value.preset === undefined ||
      value.preset === 'unrestricted' ||
      value.preset === 'agent') &&
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

export function resolveConfigHome(
  env: NodeJS.ProcessEnv,
  fallbackHome: () => string = homedir,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = nonEmpty(env.ARTIFACTSHARE_CONFIG_HOME)
  if (override) return override
  const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME)
  if (xdgConfigHome) return join(xdgConfigHome, 'artifactshare')
  const home =
    platform === 'win32'
      ? (nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME))
      : (nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE))
  if (home) return join(home, '.config/artifactshare')
  try {
    const detectedHome = nonEmpty(fallbackHome())
    if (detectedHome) return join(detectedHome, '.config/artifactshare')
  } catch {
    // Some embedded runtimes cannot resolve the current OS user.
  }
  return null
}

export function configHome(): string | null {
  return resolveConfigHome(process.env)
}

export function plaintextFallbackSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32'
}

function plaintextStoreWritable(
  platform: NodeJS.Platform = process.platform,
): boolean {
  const home = configHome()
  if (!home) return false
  return plaintextFallbackSupported(platform)
}

export async function tokenStoreDiagnostics(): Promise<TokenStoreDiagnostics> {
  const home = configHome()
  const native = await nativeStore()
  const plaintext = await readPlaintextTokens()
  const plaintextCredentials = plaintext
    ? Object.values(plaintext).filter(
        (value) => typeof value === 'string' && value.length > 0,
      ).length
    : 0
  const plaintextProtection =
    home && process.platform !== 'win32' ? 'mode_0600' : 'unavailable'
  return {
    config_home: home,
    native_store: native?.kind ?? 'none',
    plaintext_credentials: plaintextCredentials,
    plaintext_protection: plaintextProtection,
  }
}
