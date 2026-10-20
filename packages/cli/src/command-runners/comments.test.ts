import { beforeEach, expect, test, vi } from 'vitest'
import type { CliOptions, ParsedArgs } from '../types.js'

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  writeFailure: vi.fn(),
  writeSuccess: vi.fn(),
}))
vi.mock('../api.js', () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  requestConfig: () => ({ init: {} }),
}))
vi.mock('../credentials.js', () => ({
  resolveCredential: async () => ({
    ok: true,
    token: 'test-token',
    source: 'env',
  }),
}))
vi.mock('../destination.js', async (original) => ({
  ...(await original<typeof import('../destination.js')>()),
  resolveProjectConfig: async () => ({}),
}))
vi.mock('../output.js', () => ({
  writeFailure: mocks.writeFailure,
  writeSuccess: mocks.writeSuccess,
  writeText: vi.fn(),
}))
vi.mock('./auto-login.js', () => ({
  runAuthenticatedApi: async (
    credential: { token: string },
    _options: CliOptions,
    request: (current: { token: string }) => Promise<unknown>,
  ) => request(credential),
}))
import {
  runCommentsList,
  runCommentsPost,
  runCommentsEdit,
  runCommentsResolve,
  runCommentsReopen,
  runCommentsDelete,
} from './comments.js'

beforeEach(() => vi.clearAllMocks())

for (const [action, runner] of [
  ['post', runCommentsPost],
  ['edit', runCommentsEdit],
  ['resolve', runCommentsResolve],
  ['reopen', runCommentsReopen],
  ['delete', runCommentsDelete],
] as const) {
  test(`${action} keeps committed success when advisory readback is unavailable`, async () => {
    const message = {
      message_id: 'msg1',
      body: 'Saved',
      author_name: 'Reviewer',
      author_email: 'reviewer@example.com',
      agent: null,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    }
    mocks.apiPost.mockResolvedValue({
      body: {
        artifact_id: 'abc123def4',
        thread_id: 'thr1',
        refresh_required: true,
        ...(action === 'post' ? { reply: true } : {}),
        ...(action === 'delete'
          ? { deleted: true, thread_deleted: false, deleted_message_id: 'msg1' }
          : { changed_message: message }),
      },
    })
    const parsed: ParsedArgs = {
      command: `comments ${action}`,
      positionals: ['abc123def4'],
      options:
        action === 'post'
          ? { body: 'Saved', replyTo: 'thr1' }
          : action === 'edit'
            ? { body: 'Saved', messageId: 'msg1' }
            : { threadId: 'thr1' },
    }
    await runner(parsed, { json: true })
    expect(mocks.writeFailure).not.toHaveBeenCalled()
    expect(mocks.writeSuccess).toHaveBeenCalledWith(
      `comments ${action}`,
      expect.objectContaining({
        thread_id: 'thr1',
        refresh_required: true,
        ...(action === 'delete'
          ? { deleted_message_id: 'msg1' }
          : { changed_message: message }),
      }),
      { json: true },
    )
    expect(mocks.apiPost).toHaveBeenCalledTimes(1)
  })
}

test.each([
  { threadId: 'thr1', aroundMessageId: '' },
  { threadId: 'thr1', before: '' },
  { threadId: 'thr1', before: '', limit: '1' },
  { threadId: 'thr1', aroundMessageId: '', limit: '1' },
])('rejects empty pagination selectors offline: %j', async (options) => {
  await runCommentsList(
    { command: 'comments list', positionals: ['abc123def4'], options },
    { json: true },
  )
  expect(mocks.writeFailure).toHaveBeenCalledWith(
    'comments list',
    expect.objectContaining({ message: 'Invalid comment page options.' }),
    { json: true },
    1,
  )
  expect(mocks.apiGet).not.toHaveBeenCalled()
  expect(mocks.writeSuccess).not.toHaveBeenCalled()
})
