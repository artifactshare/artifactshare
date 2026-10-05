import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { setTimeout as waitFor } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

export const PIN = Object.freeze({
  url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2370/webkit-ubuntu-24.04.zip',
  size: 108122739,
  sha256: '63b31a5d68d908d9aee2e445b88edc4c1e1d1eba488f5bd7e35668f91315b968',
  libraries: Object.freeze([
    Object.freeze({
      // These are also the exact entries extracted from the r2370 archive.
      path: 'minibrowser-wpe/sys/lib/libsoup-3.0.so.0.7.4',
      original:
        '03d635a54478e3aefd5fb202e53c8897431a6c9aaaad0408698c4b2c3a1275a3',
      replacement:
        '47ac78474975d417b377a68cbbea58794a90c533f8ec93f6d2c6d96312956bd7',
    }),
    Object.freeze({
      path: 'minibrowser-gtk/sys/lib/libsoup-3.0.so.0.7.4',
      original:
        '0f02328d13684e0eadca97f1477eca3b244b8b446727dec628587a66c451a39d',
      replacement:
        '81839c7074fc8c105bb130dfc9080e72751e69b4f61ce60e4f17af65066eabe1',
    }),
  ]),
})

export function selectedExecutablePath() {
  const require = createRequire(
    new URL('../../apps/web/package.json', import.meta.url),
  )
  return require('playwright').webkit.executablePath()
}

export function selectedWebkitDirectory(executable) {
  if (
    typeof executable !== 'string' ||
    !path.isAbsolute(executable) ||
    path.basename(executable) !== 'pw_run.sh' ||
    path.basename(path.dirname(executable)) !== 'webkit-2359'
  ) {
    throw new Error(
      `Unexpected selected WebKit executable: ${String(executable)}; workaround must be removed or re-pinned`,
    )
  }
  return path.dirname(executable)
}

class IntegrityError extends Error {}

class ArchiveDownloadError extends Error {
  constructor(message, retryable, cause) {
    super(message, { cause })
    this.retryable = retryable
  }
}

export async function verifyFile(filename, expected, size) {
  const stat = await fs.lstat(filename)
  if (!stat.isFile())
    throw new IntegrityError(`Expected regular file: ${filename}`)
  if (size !== undefined && stat.size !== size) {
    throw new IntegrityError(
      `Unexpected byte count for ${filename}: ${stat.size}, expected ${size}`,
    )
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  const actual = hash.digest('hex')
  if (actual !== expected)
    throw new IntegrityError(
      `SHA-256 mismatch for ${filename}: ${actual}, expected ${expected}`,
    )
  return stat
}

export async function downloadArchive(pin, destination, fetchArchive = fetch) {
  const signal = AbortSignal.timeout(180_000)
  let response
  try {
    response = await fetchArchive(pin.url, { signal })
  } catch (error) {
    throw new ArchiveDownloadError(error.message, true, error)
  }
  if (!response.ok) {
    // The HTTP status remains authoritative if discarding its body fails.
    await response.body?.cancel().catch(() => undefined)
    throw new ArchiveDownloadError(
      `Archive download HTTP ${response.status}`,
      response.status === 429 ||
        (response.status >= 500 && response.status <= 599),
    )
  }
  if (!response.body)
    throw new ArchiveDownloadError('Archive download has no body', true)
  let bytes = 0
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length
      callback(
        bytes > pin.size
          ? new ArchiveDownloadError(
              'Archive download exceeds pinned byte count',
              true,
            )
          : null,
        chunk,
      )
    },
  })
  const source = Readable.fromWeb(response.body)
  const destinationStream = createWriteStream(destination, { flags: 'wx' })
  // Record the originating stream before pipeline propagates its error to peers.
  let origin
  source.on('error', () => {
    origin ??= 'transport'
  })
  destinationStream.on('error', () => {
    origin ??= 'filesystem'
  })
  try {
    await pipeline(source, counter, destinationStream, { signal })
  } catch (error) {
    if (error instanceof ArchiveDownloadError) throw error
    if (
      origin === 'transport' ||
      (signal.aborted && error.name === 'AbortError')
    )
      throw new ArchiveDownloadError(error.message, true, error)
    throw error
  }
  if (bytes !== pin.size)
    throw new ArchiveDownloadError(
      `Archive download byte count ${bytes}, expected ${pin.size}`,
      true,
    )
}

export async function extractLibraries(
  archive,
  staging,
  libraries,
  execute = promisify(execFile),
) {
  await execute(
    'unzip',
    ['-q', archive, ...libraries.map((library) => library.path), '-d', staging],
    { timeout: 60_000 },
  )
}

// Injection is for offline unit tests only; the executable always uses PIN.
export async function replaceWebkitLibsoup({
  pin = PIN,
  resolveExecutable = selectedExecutablePath,
  platform = process.platform,
  temporaryRoot = os.tmpdir(),
  download = downloadArchive,
  extract = extractLibraries,
  copy = fs.copyFile,
  verify = verifyFile,
  log = console.log,
  wait = waitFor,
  cacheDirectory,
} = {}) {
  let temporary
  let cacheStaging
  const messages = []
  let phase = 'inspect selected WebKit and original libraries'
  try {
    if (platform !== 'linux') throw new Error('This workaround requires Linux')
    const executable = resolveExecutable()
    const directory = selectedWebkitDirectory(executable)
    if (!(await fs.lstat(executable)).isFile())
      throw new Error(`Missing regular executable: ${executable}`)
    const targets = []
    for (const library of pin.libraries) {
      const target = path.join(directory, library.path)
      const stat = await verify(target, library.original)
      targets.push({ ...library, target, mode: stat.mode & 0o7777 })
    }
    let source
    if (cacheDirectory) {
      phase = 'verify cached libraries'
      cacheDirectory = path.resolve(cacheDirectory)
      try {
        for (const library of targets)
          await verify(
            path.join(cacheDirectory, library.path),
            library.replacement,
          )
        source = cacheDirectory
      } catch (error) {
        if (
          !(error instanceof IntegrityError) &&
          error.code !== 'ENOENT' &&
          error.code !== 'ENOTDIR'
        )
          throw error
        log(`WebKit libsoup cache rejected: ${error.message}`)
        phase = 'discard rejected cache'
        await fs.rm(cacheDirectory, { recursive: true, force: true })
      }
    }
    if (!source) {
      phase = 'create temporary staging'
      temporary = await fs.mkdtemp(path.join(temporaryRoot, 'webkit-libsoup-'))
      const archive = path.join(temporary, 'webkit.zip')
      const staging = path.join(temporary, 'staging')
      const delays = [2000, 5000, 10000]
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          phase = 'download archive'
          await download(pin, archive)
          phase = 'verify archive'
          await verify(archive, pin.sha256, pin.size)
          break
        } catch (error) {
          log(
            `WebKit libsoup archive attempt ${attempt}/4 failed: ${error.message}`,
          )
          await fs.rm(archive, { force: true })
          if (
            !(error.retryable === true || error instanceof IntegrityError) ||
            attempt === 4
          )
            throw error
          await wait(delays[attempt - 1])
        }
      }
      phase = 'extract libraries'
      await fs.mkdir(staging)
      await extract(archive, staging, pin.libraries)
      phase = 'verify staged libraries'
      for (const library of targets)
        await verify(path.join(staging, library.path), library.replacement)
      source = staging
      if (cacheDirectory) {
        phase = 'publish verified cache'
        await fs.mkdir(path.dirname(cacheDirectory), { recursive: true })
        cacheStaging = await fs.mkdtemp(`${cacheDirectory}.staging-`)
        for (const library of targets) {
          const destination = path.join(cacheStaging, library.path)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(path.join(staging, library.path), destination)
          await verify(destination, library.replacement)
        }
        await fs.rename(cacheStaging, cacheDirectory)
        cacheStaging = undefined
      }
    }
    phase = 'replace installed libraries'
    for (const library of targets) {
      await copy(path.join(source, library.path), library.target)
      await fs.chmod(library.target, library.mode)
    }
    phase = 'verify installed libraries'
    for (const library of targets)
      await verify(library.target, library.replacement)
    for (const library of targets)
      messages.push(
        `Replaced ${library.target}: ${library.original} -> ${library.replacement}`,
      )
  } catch (error) {
    throw new Error(
      `WebKit libsoup workaround failed to ${phase}: ${error.message}. Workaround must be removed or re-pinned if the installation or pins changed.`,
      { cause: error },
    )
  } finally {
    if (cacheStaging)
      await fs.rm(cacheStaging, { recursive: true, force: true })
    if (temporary) await fs.rm(temporary, { recursive: true, force: true })
  }
  for (const message of messages) log(message)
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  replaceWebkitLibsoup({
    cacheDirectory: process.env.WEBKIT_LIBSOUP_CACHE_DIR || undefined,
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
