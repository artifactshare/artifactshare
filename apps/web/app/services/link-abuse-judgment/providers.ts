import {
  ANTHROPIC_LINK_ABUSE_MODEL,
  ANTHROPIC_LINK_ABUSE_TOOL_NAME,
  failedLinkAbuseJudgment,
  judgmentUserPrompt,
  LINK_ABUSE_SYSTEM_PROMPT,
  linkAbuseJudgmentJsonSchema,
  parseLinkAbuseJudgment,
  WORKERS_AI_LINK_ABUSE_MODEL,
} from './contract'
import type {
  LinkAbuseJudgmentInput,
  LinkAbuseJudgmentProvider,
  LinkAbuseJudgmentResult,
} from './types'

export class WorkersAiLinkAbuseJudgmentProvider implements LinkAbuseJudgmentProvider {
  constructor(private readonly ai: Ai) {}

  async judge(input: LinkAbuseJudgmentInput): Promise<LinkAbuseJudgmentResult> {
    try {
      const response = await this.ai.run(WORKERS_AI_LINK_ABUSE_MODEL, {
        messages: [
          { role: 'system', content: LINK_ABUSE_SYSTEM_PROMPT },
          { role: 'user', content: judgmentUserPrompt(input) },
        ],
        max_tokens: 700,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: linkAbuseJudgmentJsonSchema,
        },
      })
      const raw =
        response && typeof response === 'object' && 'response' in response
          ? response.response
          : response
      return {
        ...parseLinkAbuseJudgment(raw, input.externalDomains),
        provider: 'workers-ai',
        model: WORKERS_AI_LINK_ABUSE_MODEL,
      }
    } catch (error) {
      console.error('link_abuse_judgment_provider_failed', {
        provider: 'workers-ai',
        error: error instanceof Error ? error.name : 'Error',
      })
      return failedLinkAbuseJudgment('workers-ai', WORKERS_AI_LINK_ABUSE_MODEL)
    }
  }
}

export class AnthropicLinkAbuseJudgmentProvider implements LinkAbuseJudgmentProvider {
  constructor(private readonly apiKey: string) {}

  async judge(input: LinkAbuseJudgmentInput): Promise<LinkAbuseJudgmentResult> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          model: ANTHROPIC_LINK_ABUSE_MODEL,
          max_tokens: 700,
          system: LINK_ABUSE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: judgmentUserPrompt(input) }],
          tools: [
            {
              name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
              description: 'Record the link abuse risk judgment.',
              input_schema: linkAbuseJudgmentJsonSchema,
            },
          ],
          tool_choice: {
            type: 'tool',
            name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
          },
        }),
      })
      if (!response.ok) throw new Error(`anthropic_http_${response.status}`)
      const body = (await response.json()) as {
        content?: Array<{ type?: unknown; name?: unknown; input?: unknown }>
      }
      const toolUse = body.content?.find(
        (part) =>
          part.type === 'tool_use' &&
          part.name === ANTHROPIC_LINK_ABUSE_TOOL_NAME,
      )
      return {
        ...parseLinkAbuseJudgment(toolUse?.input, input.externalDomains),
        provider: 'anthropic',
        model: ANTHROPIC_LINK_ABUSE_MODEL,
      }
    } catch (error) {
      console.error('link_abuse_judgment_provider_failed', {
        provider: 'anthropic',
        error: error instanceof Error ? error.name : 'Error',
      })
      return failedLinkAbuseJudgment('anthropic', ANTHROPIC_LINK_ABUSE_MODEL)
    }
  }
}

export function linkAbuseJudgmentProvider(
  env: Pick<
    Cloudflare.Env,
    'AI' | 'ANTHROPIC_API_KEY' | 'LINK_ABUSE_JUDGMENT_PROVIDER'
  >,
): LinkAbuseJudgmentProvider {
  if (env.LINK_ABUSE_JUDGMENT_PROVIDER === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) {
      return {
        judge: () =>
          Promise.resolve(
            failedLinkAbuseJudgment('anthropic', ANTHROPIC_LINK_ABUSE_MODEL),
          ),
      }
    }
    return new AnthropicLinkAbuseJudgmentProvider(env.ANTHROPIC_API_KEY)
  }
  return new WorkersAiLinkAbuseJudgmentProvider(env.AI)
}
