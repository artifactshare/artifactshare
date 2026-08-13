import type { CliCommand } from './types.js'

export const SCHEMA_VERSION = 2
export const DEFAULT_BASE_URL = 'https://artifactshare.com'
export const DEVICE_CLIENT_ID = 'artifactshare-cli'
export const CLI_INVOCATION = 'npx --yes @artifactshare/cli'
export const AGENT_DOWNLOAD_OUTPUT = './artifact'
export const TOKEN_ENV_VAR = 'ARTIFACTSHARE_TOKEN'
export const TOKEN_OPTION = '--token'
export const IGNORED_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])
export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.artifactshare',
  '.turbo',
])
export const BOOLEAN_FLAGS = new Set([
  'allow-plaintext-token-store',
  'archive',
  'dry-run',
  'force',
  'json',
  'help',
  'home',
  'insecure-localhost',
  'no-link-expiry',
  'unarchive',
])
export const VALUE_FLAGS = new Set([
  'add-email',
  'agent',
  'base-url',
  'body',
  'cursor',
  'description',
  'grant-email',
  'include',
  'key',
  'link-expires-at',
  'message-id',
  'name',
  'note',
  'offset',
  'output',
  'profile',
  'preset',
  'project',
  'project-id',
  'query',
  'quote',
  'quote-after',
  'quote-before',
  'reply-to',
  'remove-email',
  'revoke-email',
  'scope',
  'thread-id',
  'title',
  'token',
  'tool',
  'visibility',
])
export const COMMAND_NAMES = new Set<CliCommand>([
  'login',
  'logout',
  'share',
  'open',
  'update',
  'append',
  'edit',
  'delete',
  'resolve',
  'download',
  'move',
  'artifacts',
  'comments',
  'whoami',
  'doctor',
  'profiles',
  'projects',
  'skills',
  'init',
  'changelog',
  'config',
])
export const SUBCOMMANDS: Record<string, readonly string[]> = {
  artifacts: ['list', 'get'],
  comments: ['list', 'post', 'edit', 'resolve', 'reopen', 'delete'],
  profiles: ['list', 'use', 'import-token', 'delete'],
  projects: ['list', 'create', 'edit'],
  skills: ['install', 'list', 'update', 'remove', 'ensure'],
  config: ['get', 'set', 'unset'],
}
export const UPDATE_OPTION_KEYS = new Set([
  'allowPlaintextTokenStore',
  'baseUrl',
  'help',
  'insecureLocalhost',
  'json',
  'profile',
  'token',
])

export function agentDownloadCommand(target: string): string {
  return `${CLI_INVOCATION} download ${target} --output ${AGENT_DOWNLOAD_OUTPUT} --json`
}

/** Prefix for one-time bot tokens issued by workspace admins. */
export const BOT_TOKEN_PREFIX = 'asb_'
