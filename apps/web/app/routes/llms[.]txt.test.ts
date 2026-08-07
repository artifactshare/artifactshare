import { describe, expect, test } from 'vitest'
import { AGENT_SURFACE_HEADERS_TXT, llmsTxt } from '~/lib/agent-surface'
import { loader } from './llms[.]txt'

describe('/llms.txt route', () => {
  test('returns anonymous cacheable plain text with CORS', () => {
    const response = loader()
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(response.headers.get('Content-Type')).toBe(
      AGENT_SURFACE_HEADERS_TXT['Content-Type'],
    )
  })

  test('body matches the published llms contract', async () => {
    const response = loader()
    expect(await response.text()).toBe(llmsTxt)
  })
})

describe('llmsTxt', () => {
  test('prioritizes CLI, documents MCP fallback and auth flow', () => {
    expect(llmsTxt).toMatch(/prefer the CLI/i)
    expect(llmsTxt).toMatch(/First-time setup/)
    expect(llmsTxt).toMatch(/npx --yes @artifactshare\/cli init --json/)
    expect(llmsTxt).toMatch(
      /npx --yes @artifactshare\/cli open <artifact-id-or-url> --json/,
    )
    expect(llmsTxt).toMatch(/npx --yes @artifactshare\/cli share <path> --json/)
    expect(llmsTxt).toMatch(
      /npx --yes @artifactshare\/cli update <artifact-id-or-url> <path> --json/,
    )
    expect(llmsTxt).toMatch(
      /npx --yes @artifactshare\/cli artifacts get <artifact-id-or-url> --json/,
    )
    expect(llmsTxt).toMatch(
      /npx --yes @artifactshare\/cli download <artifact-id-or-url> --output \.\/artifact --json/,
    )
    expect(llmsTxt).not.toMatch(/skills ensure/)
    expect(llmsTxt).toMatch(/auth_required/)
    expect(llmsTxt).toMatch(/verification URL and user_code/)
    expect(llmsTxt).toMatch(/rerun the same command/)
    expect(llmsTxt).toMatch(/shell access is unavailable/)
    expect(llmsTxt).toMatch(/remote MCP server/)
    expect(llmsTxt).toMatch(/ask the user before uploading/)
    expect(llmsTxt).toMatch(/https:\/\/artifactshare\.com\/share-with-ai/)
    expect(llmsTxt).toMatch(/https:\/\/artifactshare\.com\/connect/)
    expect(llmsTxt).toMatch(
      /https:\/\/artifactshare\.com\/\.well-known\/agent\.json/,
    )
  })
})
