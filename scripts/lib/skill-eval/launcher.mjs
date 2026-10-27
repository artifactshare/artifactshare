import { readFile, appendFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { localOrigin } from './plan.mjs'
import { inventory, environments } from './environment.mjs'

export function guardedArguments(bin, argv, baseUrl) {
  let args = argv
  if (bin === 'npm') {
    const prefix = [
      'exec',
      '--yes',
      '--package=@artifactshare/cli',
      '--',
      'artifactshare',
    ]
    if (!prefix.every((value, i) => args[i] === value))
      throw new Error(
        'Unsupported npm form: only the bundled Artifact Share npm exec form is allowed',
      )
    args = args.slice(prefix.length)
  } else if (bin !== 'artifactshare')
    throw new Error(
      'Package runners are disabled; use artifactshare or the bundled npm exec form',
    )
  for (let i = 0; i < args.length; i++) {
    if (/^--base(?:-url|Url)(?:=|$)/u.test(args[i])) {
      const value = args[i].includes('=')
        ? args[i].slice(args[i].indexOf('=') + 1)
        : args[++i]
      if (localOrigin(value) !== baseUrl)
        throw new Error('CLI base URL must match the approved local origin')
    }
  }
  return args
}
export function redact(value, secrets) {
  let text = String(value)
  for (const secret of secrets.filter(Boolean))
    text = text.split(secret).join('[REDACTED]')
  return text
}
export async function launch(configPath, bin) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const original = process.argv.slice(2)
  const record = {
    bin,
    original,
    target: config.target,
    fingerprint: config.fingerprint,
    argv: null,
    stdout: '',
    stderr: '',
    exitCode: null,
  }
  const secrets = [config.token, encodeURIComponent(config.token)]
  try {
    record.argv = guardedArguments(bin, original, config.baseUrl)
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(import.meta.dirname, 'network-guard.mjs'),
        config.target,
        ...record.argv,
      ],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...environments({
            root: config.root,
            baseUrl: config.baseUrl,
            token: config.token,
            inherited: process.env,
          }).cli,
          SKILL_EVAL_OVERLAY_TARGET: config.target,
          ARTIFACTSHARE_BASE_URL: config.baseUrl,
          ARTIFACTSHARE_TOKEN: config.token,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
      },
    )
    child.stdout.on('data', (data) => {
      record.stdout += data
      process.stdout.write(data)
    })
    child.stderr.on('data', (data) => {
      record.stderr += data
      process.stderr.write(data)
    })
    record.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
  } catch (error) {
    record.exitCode = 1
    record.stderr = error.message
    process.stderr.write(`${error.message}\n`)
    if (
      record.argv === null &&
      bin !== 'artifactshare' &&
      !original.some((arg) => arg.includes('artifactshare'))
    ) {
      process.exitCode = record.exitCode
      return
    }
  }
  record.skills = await inventory(config.root, config.files)
  await appendFile(config.log, `${redact(JSON.stringify(record), secrets)}\n`, {
    mode: 0o600,
  })
  process.exitCode = record.exitCode
}
