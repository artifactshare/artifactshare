import type {
  CommentsActionData,
  CommentsDeleteData,
  CommentsListData,
  CommentsPostData,
  OutputMode,
  ParsedArgs,
} from '../types.js'
import { apiGet, apiPost, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { configString, resolveProjectConfig } from '../destination.js'
import { serviceError, validationError } from '../errors.js'
import { writeFailure, writeSuccess, writeText } from '../output.js'
import { parseArtifactTarget } from '../shared.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runCommentsList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'comments list'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const artifactId = target.artifactId

  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const comments = await apiGet(
        `/api/cli/artifacts/${encodeURIComponent(artifactId)}/comments`,
        current.token,
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
        },
      )
      return comments.error
        ? { error: comments.error }
        : { data: comments.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const comments = Array.isArray(result.data?.comments)
    ? result.data.comments
    : []
  const data: CommentsListData = {
    artifact_id: artifactId,
    share_url: configString(result.data?.share_url),
    comments,
    has_more: result.data?.has_more === true,
  }
  writeSuccess(command, data, mode)
  if (!mode.json && comments.length === 0) {
    writeText('No comments yet.\n')
  }
}

export async function runCommentsPost(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'comments post'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const artifactId = target.artifactId

  const body = parsed.options.body
  if (!body || !body.trim()) {
    return writeFailure(
      command,
      validationError(
        'A comment body is required.',
        'Retry with --body <text>.',
      ),
      mode,
      1,
    )
  }
  const replyTo = parsed.options.replyTo
  const quote = parsed.options.quote
  if (quote !== undefined && replyTo !== undefined) {
    return writeFailure(
      command,
      validationError(
        'Choose either --quote or --reply-to.',
        'A quote anchors a new thread; a reply joins an existing thread. Remove one and retry.',
      ),
      mode,
      1,
    )
  }
  if (
    quote === undefined &&
    (parsed.options.quoteBefore !== undefined ||
      parsed.options.quoteAfter !== undefined)
  ) {
    return writeFailure(
      command,
      validationError(
        '--quote-before and --quote-after require --quote.',
        'Add --quote <text>, or remove the context options.',
      ),
      mode,
      1,
    )
  }

  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const agent = parsed.options.agent
  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const posted = await apiPost(
        `/api/cli/artifacts/${encodeURIComponent(artifactId)}/comments`,
        current.token,
        {
          body,
          reply_to: replyTo,
          quote,
          quote_before: parsed.options.quoteBefore,
          quote_after: parsed.options.quoteAfter,
          ...(agent ? { agent } : {}),
        },
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
        },
      )
      return posted.error ? { error: posted.error } : { data: posted.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const threadId = configString(result.data?.thread_id)
  if (!threadId) {
    return writeFailure(
      command,
      serviceError('Comment was saved but the response had no thread id.'),
      mode,
      1,
    )
  }
  const data: CommentsPostData = {
    artifact_id: artifactId,
    share_url: configString(result.data?.share_url),
    thread_id: threadId,
    reply: result.data?.reply === true,
    thread: result.data?.thread ?? null,
  }
  writeSuccess(command, data, mode)
}

export async function runCommentsEdit(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'comments edit'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const messageId = requiredOption(
    parsed.options.messageId,
    '--message-id is required.',
    'Run comments list and retry with a listed message_id.',
  )
  if (messageId.error) return writeFailure(command, messageId.error, mode, 1)
  const body = requiredOption(
    parsed.options.body,
    '--body is required.',
    'Pass --body <text> with the updated comment.',
  )
  if (body.error) return writeFailure(command, body.error, mode, 1)

  const result = await postCommentAction(
    parsed,
    command,
    target.artifactId,
    { action: 'edit', message_id: messageId.value, body: body.value },
    mode,
  )
  if (!result) return
  const threadId = configString(result.thread_id)
  if (!threadId || result.thread === undefined) {
    return writeFailure(
      command,
      serviceError('Comment was changed but the response had no thread.'),
      mode,
      1,
    )
  }
  writeSuccess(
    command,
    {
      artifact_id: target.artifactId,
      share_url: configString(result.share_url),
      thread_id: threadId,
      thread: result.thread,
    } satisfies CommentsActionData,
    mode,
  )
}

export async function runCommentsResolve(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  return await runCommentsStatus(parsed, mode, 'comments resolve', 'resolve')
}

export async function runCommentsReopen(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  return await runCommentsStatus(parsed, mode, 'comments reopen', 'reopen')
}

export async function runCommentsDelete(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'comments delete'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const threadId = requiredOption(
    parsed.options.threadId,
    '--thread-id is required.',
    'Run comments list and retry with a listed thread_id.',
  )
  if (threadId.error) return writeFailure(command, threadId.error, mode, 1)

  const payload: Record<string, unknown> = {
    action: 'delete',
    thread_id: threadId.value,
  }
  if (parsed.options.messageId !== undefined) {
    if (!parsed.options.messageId.trim()) {
      return writeFailure(
        command,
        validationError(
          '--message-id cannot be empty.',
          'Run comments list and retry with a listed message_id.',
        ),
        mode,
        1,
      )
    }
    payload.message_id = parsed.options.messageId.trim()
  }

  const result = await postCommentAction(
    parsed,
    command,
    target.artifactId,
    payload,
    mode,
  )
  if (!result) return
  const responseThreadId = configString(result.thread_id)
  if (!responseThreadId || result.deleted !== true) {
    return writeFailure(
      command,
      serviceError('Comment was deleted but the response was incomplete.'),
      mode,
      1,
    )
  }
  writeSuccess(
    command,
    {
      artifact_id: target.artifactId,
      share_url: configString(result.share_url),
      thread_id: responseThreadId,
      deleted: true,
      thread_deleted: result.thread_deleted === true,
      ...(result.thread !== undefined ? { thread: result.thread } : {}),
    } satisfies CommentsDeleteData,
    mode,
  )
}

async function runCommentsStatus(
  parsed: ParsedArgs,
  mode: OutputMode,
  command: 'comments resolve' | 'comments reopen',
  action: 'resolve' | 'reopen',
): Promise<void> {
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const threadId = requiredOption(
    parsed.options.threadId,
    '--thread-id is required.',
    'Run comments list and retry with a listed thread_id.',
  )
  if (threadId.error) return writeFailure(command, threadId.error, mode, 1)

  const result = await postCommentAction(
    parsed,
    command,
    target.artifactId,
    { action, thread_id: threadId.value },
    mode,
  )
  if (!result) return
  const responseThreadId = configString(result.thread_id)
  if (!responseThreadId || result.thread === undefined) {
    return writeFailure(
      command,
      serviceError('Comment was changed but the response had no thread.'),
      mode,
      1,
    )
  }
  writeSuccess(
    command,
    {
      artifact_id: target.artifactId,
      share_url: configString(result.share_url),
      thread_id: responseThreadId,
      thread: result.thread,
    } satisfies CommentsActionData,
    mode,
  )
}

async function postCommentAction(
  parsed: ParsedArgs,
  command:
    | 'comments edit'
    | 'comments resolve'
    | 'comments reopen'
    | 'comments delete',
  artifactId: string,
  payload: Record<string, unknown>,
  mode: OutputMode,
) {
  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) {
    writeFailure(command, credential.error, mode, 1)
    return null
  }
  const request = await requestConfig(parsed.options)
  if (request.error) {
    writeFailure(command, request.error, mode, 1)
    return null
  }

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const action = await apiPost(
        `/api/cli/artifacts/${encodeURIComponent(artifactId)}/comments`,
        current.token,
        payload,
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
        },
      )
      return action.error ? { error: action.error } : { data: action.body }
    },
  )
  if (result.error) {
    writeFailure(command, result.error, mode, 1)
    return null
  }
  if (result.data === null) {
    writeFailure(
      command,
      serviceError('Comment was changed but the response was empty.'),
      mode,
      1,
    )
    return null
  }
  return result.data
}

function requiredOption(
  value: string | undefined,
  message: string,
  hint: string,
):
  | { value: string; error?: never }
  | { error: ReturnType<typeof validationError> } {
  if (!value || !value.trim()) {
    return { error: validationError(message, hint) }
  }
  return { value: value.trim() }
}
