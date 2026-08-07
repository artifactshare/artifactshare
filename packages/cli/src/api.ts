import { DEFAULT_BASE_URL } from './constants.js'
import type { Agent, Response } from 'undici'
import type {
  ApiBody,
  ApiErrorOptions,
  CliError,
  CliOptions,
  FetchInit,
  NetworkFailure,
  RequestConfig,
} from './types.js'
import { mapApiError, networkError, validationError } from './errors.js'

export type ApiRawResult =
  | { response: Response; body: ApiBody | null; error?: never }
  | { error: CliError; response?: never; body?: never }

let insecureLocalhostDispatcher: Agent | undefined
let undiciModule: typeof import('undici') | undefined

async function loadUndici() {
  return (undiciModule ??= await import('undici'))
}

export function baseUrlOf(options: CliOptions): string {
  return String(
    options.baseUrl ?? process.env.ARTIFACTSHARE_BASE_URL ?? DEFAULT_BASE_URL,
  ).replace(/\/$/, '')
}

export function requestConfig(options: CliOptions): RequestConfig {
  if (!insecureLocalhostEnabled(options)) return { init: {} }
  const baseUrl = baseUrlOf(options)
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || !isLocalHostname(url.hostname)) {
    return {
      error: validationError(
        '--insecure-localhost only works with local HTTPS base URLs.',
        'Use it only with https://localhost, https://127.0.0.1, or https://[::1].',
      ),
    }
  }
  return {
    init: {
      insecureLocalhost: true,
    },
  }
}

export async function cliFetch(
  input: string | URL,
  init: FetchInit = {},
): Promise<Response | NetworkFailure> {
  const { insecureLocalhost, ...fetchInit } = init
  const { fetch, Agent } = await loadUndici()
  const requestInit = insecureLocalhost
    ? {
        ...fetchInit,
        dispatcher: (insecureLocalhostDispatcher ??= new Agent({
          connect: { rejectUnauthorized: false },
        })),
      }
    : fetchInit
  try {
    return await fetch(input, requestInit)
  } catch (error) {
    return { networkError: error }
  }
}

function insecureLocalhostEnabled(options: CliOptions): boolean {
  return (
    Boolean(options.insecureLocalhost) ||
    process.env.ARTIFACTSHARE_INSECURE_LOCALHOST === '1'
  )
}

export function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    hostname.toLowerCase(),
  )
}

export function apiUrl(path: string, baseUrl: string): URL {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/$/, '')
  url.pathname = `${basePath}${path}`
  url.search = ''
  url.hash = ''
  return url
}

export function downloadFileUrl(
  baseUrl: string,
  artifactId: string,
  filePath: string,
): URL {
  const encodedPath = filePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return apiUrl(
    `/api/cli/artifacts/${encodeURIComponent(artifactId)}/download/${encodedPath}`,
    baseUrl,
  )
}

export async function readJson(response: Response): Promise<ApiBody | null> {
  return (await response.json().catch(() => null)) as ApiBody | null
}

export async function apiGet(
  path: string,
  token: string,
  options: CliOptions,
  init: FetchInit,
  errorOptions: ApiErrorOptions = {},
): Promise<
  { body: ApiBody | null; error?: never } | { error: CliError; body?: never }
> {
  return await apiRequest(
    path,
    options,
    { headers: { Authorization: `Bearer ${token}` }, ...init },
    errorOptions,
  )
}

export async function apiPost(
  path: string,
  token: string,
  payload: Record<string, unknown>,
  options: CliOptions,
  init: FetchInit,
  errorOptions: ApiErrorOptions = {},
): Promise<
  { body: ApiBody | null; error?: never } | { error: CliError; body?: never }
> {
  return await apiRequest(
    path,
    options,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      ...init,
    },
    errorOptions,
  )
}

export async function apiPostPublic(
  path: string,
  payload: Record<string, unknown>,
  options: CliOptions,
  init: FetchInit,
): Promise<ApiRawResult> {
  return await apiRequestRaw(path, options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...init,
  })
}

export async function apiDelete(
  path: string,
  token: string,
  options: CliOptions,
  init: FetchInit,
  errorOptions: ApiErrorOptions = {},
): Promise<
  { body: ApiBody | null; error?: never } | { error: CliError; body?: never }
> {
  return await apiRequest(
    path,
    options,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      ...init,
    },
    errorOptions,
  )
}

async function apiRequest(
  path: string,
  options: CliOptions,
  init: FetchInit,
  errorOptions: ApiErrorOptions,
): Promise<
  { body: ApiBody | null; error?: never } | { error: CliError; body?: never }
> {
  const result = await apiRequestRaw(path, options, init)
  if (result.error) return { error: result.error }
  const { response, body } = result
  if (!response.ok) {
    return {
      error: mapApiError(response.status, body, {
        authenticated: true,
        baseUrl: baseUrlOf(options),
        ...errorOptions,
      }),
    }
  }
  return { body }
}

async function apiRequestRaw(
  path: string,
  options: CliOptions,
  init: FetchInit,
): Promise<ApiRawResult> {
  const response = await cliFetch(apiUrl(path, baseUrlOf(options)), init)
  if ('networkError' in response) {
    return { error: networkError(response.networkError) }
  }
  return { response, body: await readJson(response) }
}
