import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ANTHROPIC_LINK_ABUSE_TOOL_NAME,
  parseLinkAbuseJudgment,
} from './contract'
import {
  AnthropicLinkAbuseJudgmentProvider,
  WorkersAiLinkAbuseJudgmentProvider,
} from './providers'

const input = {
  text: 'ordinary report',
  externalDomains: ['docs.example.test'],
  accountAgeDays: 30,
  workspacePlan: 'plus',
  trigger: 'manual' as const,
  detail: 'owner_requested',
}

afterEach(() => vi.unstubAllGlobals())

describe('link abuse judgment providers', () => {
  test('validates constrained Workers AI JSON', async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          risk: 'low',
          reason: 'ordinary_report',
          impersonatedBrand: null,
          externalTargets: ['docs.example.test'],
        }),
      })),
    }
    const result = await new WorkersAiLinkAbuseJudgmentProvider(
      ai as unknown as Ai,
    ).judge(input)
    expect(result).toMatchObject({
      risk: 'low',
      reason: 'ordinary_report',
      provider: 'workers-ai',
    })
    expect(ai.run).toHaveBeenCalledWith(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      expect.objectContaining({
        response_format: expect.objectContaining({ type: 'json_schema' }),
      }),
    )
  })

  test('rejects undeclared external targets', () => {
    expect(() =>
      parseLinkAbuseJudgment(
        {
          risk: 'high',
          reason: 'redirect',
          impersonatedBrand: null,
          externalTargets: ['not-supplied.example.test'],
        },
        input.externalDomains,
      ),
    ).toThrow('outside the input')
  })

  test('normalizes model-controlled display fields to one line', () => {
    expect(
      parseLinkAbuseJudgment(
        {
          risk: 'high',
          reason: 'fake\n  download',
          impersonatedBrand: 'Example\t Brand',
          externalTargets: [],
        },
        [],
      ),
    ).toMatchObject({
      reason: 'fake download',
      impersonatedBrand: 'Example Brand',
    })
  })

  test('normalizes an empty impersonated brand to null', () => {
    expect(
      parseLinkAbuseJudgment(
        {
          risk: 'low',
          reason: 'ordinary',
          impersonatedBrand: '   ',
          externalTargets: [],
        },
        [],
      ).impersonatedBrand,
    ).toBeNull()
  })

  test('keeps the JSON schema reason constraint aligned with validation', async () => {
    const ai = { run: vi.fn(async () => ({ response: '{}' })) }
    await new WorkersAiLinkAbuseJudgmentProvider(ai as unknown as Ai).judge(
      input,
    )
    expect(ai.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response_format: expect.objectContaining({
          json_schema: expect.objectContaining({
            properties: expect.objectContaining({
              reason: expect.objectContaining({ minLength: 1 }),
            }),
          }),
        }),
      }),
    )
  })

  test('uses Anthropic tool input for the structured judgment', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(init?.headers).toMatchObject({
        'anthropic-version': '2023-06-01',
      })
      expect(body).toMatchObject({
        model: 'claude-haiku-4-5-20251001',
        tools: [
          {
            name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
            input_schema: expect.objectContaining({ type: 'object' }),
          },
        ],
        tool_choice: {
          type: 'tool',
          name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
        },
      })
      expect(body).not.toHaveProperty('output_config')
      return Response.json({
        content: [
          {
            type: 'tool_use',
            name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
            input: {
              risk: 'low',
              reason: 'ordinary_report',
              impersonatedBrand: null,
              externalTargets: ['docs.example.test'],
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      new AnthropicLinkAbuseJudgmentProvider('test-api-key').judge(input),
    ).resolves.toMatchObject({
      risk: 'low',
      reason: 'ordinary_report',
      provider: 'anthropic',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('maps invalid provider JSON to medium judgment_failed', async () => {
    const provider = new WorkersAiLinkAbuseJudgmentProvider({
      run: vi.fn(async () => ({ response: '{not-json' })),
    } as unknown as Ai)
    await expect(provider.judge(input)).resolves.toMatchObject({
      risk: 'medium',
      reason: 'judgment_failed',
      externalTargets: [],
    })
  })

  test('maps Anthropic request failure to medium judgment_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    )
    await expect(
      new AnthropicLinkAbuseJudgmentProvider('test-api-key').judge(input),
    ).resolves.toMatchObject({
      risk: 'medium',
      reason: 'judgment_failed',
      provider: 'anthropic',
    })
  })
})
