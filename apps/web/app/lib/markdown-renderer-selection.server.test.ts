import { describe, expect, test, vi } from 'vitest'

import { selectMarkdownRenderer } from './markdown-renderer-selection.server'

describe('selectMarkdownRenderer', () => {
  test('targets the artifact workspace and enables TanStack', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)
    await expect(
      selectMarkdownRenderer(
        { APP_ENV: 'production', FLAGS: { getBooleanValue } },
        'workspace-1',
      ),
    ).resolves.toBe('tanstack')
    expect(getBooleanValue).toHaveBeenCalledWith('tanstack-markdown', false, {
      targetingKey: 'workspace-1',
      workspaceId: 'workspace-1',
    })
  })

  test.each([
    [
      'disabled',
      { APP_ENV: 'production', FLAGS: { getBooleanValue: async () => false } },
    ],
    ['missing binding', { APP_ENV: 'production' }],
    [
      'evaluation failure',
      {
        APP_ENV: 'production',
        FLAGS: {
          getBooleanValue: async () => Promise.reject(new Error('down')),
        },
      },
    ],
  ])('falls back to Marked when %s', async (_name, source) => {
    await expect(selectMarkdownRenderer(source, 'workspace-1')).resolves.toBe(
      'marked',
    )
  })

  test('allows the shared DEV_FLAGS fallback outside production', async () => {
    await expect(
      selectMarkdownRenderer(
        { APP_ENV: 'development', DEV_FLAGS: 'tanstack-markdown' },
        'workspace-1',
      ),
    ).resolves.toBe('tanstack')
  })
})
