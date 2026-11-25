import { describe, expect, test } from 'vitest'
import { AGENT_SURFACE_HEADERS_TXT } from '~/lib/agent-surface'
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

  test('serves the agent commands and surface URLs', async () => {
    const body = await loader().text()

    for (const command of [
      'artifactshare init --json',
      'artifactshare open <artifact-id-or-url> --json',
      'artifactshare share <path> --json',
      'artifactshare update <artifact-id-or-url> <path> --json',
      'artifactshare artifacts get <artifact-id-or-url> --json',
      'artifactshare download <artifact-id-or-url> --output ./artifact --json',
    ])
      expect(body).toContain(
        `npm exec --yes --package=@artifactshare/cli -- ${command}`,
      )
    for (const url of [
      'https://artifactshare.com/share-with-ai',
      'https://artifactshare.com/connect',
      'https://artifactshare.com/.well-known/agent.json',
    ])
      expect(body).toContain(url)
  })
})
