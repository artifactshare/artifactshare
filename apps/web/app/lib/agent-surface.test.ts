import { describe, expect, test } from 'vitest'
import { MCP_OAUTH_SCOPES } from './mcp-metadata'
import {
  AGENT_CAPABILITIES,
  AGENT_RESTRICTIONS,
  agentSurface,
  capabilitiesMd,
  llmsTxt,
  openapiStub,
} from './agent-surface'

// These lock the discovery surface to the remote MCP reality: a regression that
// flips `headless` back to false or drops the MCP advertisement would silently
// tell agents the service has no programmatic path.

describe('agentSurface', () => {
  test('advertises headless OAuth and the MCP connector', () => {
    expect(agentSurface.auth.headless).toBe(true)
    expect(agentSurface.connector.protocol).toBe('mcp')
    expect(agentSurface.connector.preferred_when).toBe(
      'source_text_in_chat_or_temporary_sandbox',
    )
    expect(agentSurface.connector.endpoint).toMatch(/\/mcp$/)
    expect(agentSurface.connector.scopes).toEqual([...MCP_OAUTH_SCOPES])
    expect(agentSurface.connector.tools).toEqual([
      'whoami',
      'share_artifact',
      'update_artifact',
      'append_artifact',
      'list_artifacts',
      'get_artifact',
      'preview_artifact',
      'list_comments',
      'post_comment',
      'update_comment',
      'resolve_comment',
      'reopen_comment',
      'delete_comment',
      'list_projects',
      'create_project',
      'edit_project',
      'edit_artifact',
      'delete_artifact',
    ])
  })

  test('points docs at the connect guide', () => {
    expect(agentSurface.docs).toBe('https://artifactshare.com/connect')
  })

  test('advertises share-with-ai entrance URLs in guide', () => {
    expect(agentSurface.guide).toEqual({
      share_with_ai: 'https://artifactshare.com/share-with-ai',
      share_with_ai_ja: 'https://artifactshare.com/ja/share-with-ai',
      cli: 'https://artifactshare.com/guides/cli',
      cli_ja: 'https://artifactshare.com/ja/guides/cli',
      workspace_owner: 'https://artifactshare.com/guides/workspace-owner',
      workspace_owner_ja: 'https://artifactshare.com/ja/guides/workspace-owner',
      workspace_admin: 'https://artifactshare.com/guides/workspace-admin',
      workspace_admin_ja: 'https://artifactshare.com/ja/guides/workspace-admin',
      link_sharing: 'https://artifactshare.com/guides/link-sharing',
      link_sharing_ja: 'https://artifactshare.com/ja/guides/link-sharing',
      connect: 'https://artifactshare.com/connect',
      connect_ja: 'https://artifactshare.com/ja/connect',
      terms: 'https://artifactshare.com/terms',
      privacy: 'https://artifactshare.com/privacy',
      updates: 'https://artifactshare.com/updates',
      updates_ja: 'https://artifactshare.com/ja/updates',
      capabilities: 'https://artifactshare.com/capabilities.md',
    })
  })

  test('advertises apex Artifact Share URL routing and intent boundaries', () => {
    expect(agentSurface.url_patterns).toEqual([
      'https://artifactshare.com/a/...',
    ])
    expect(agentSurface.routing_intents.positive).toContain('as で共有して')
    expect(agentSurface.routing_intents.positive).toContain(
      'https://artifactshare.com/a/... を読んで',
    )
    expect(agentSurface.routing_intents.negative).toContain(
      'Claude Artifact を作って',
    )
    expect(agentSurface.routing_intents.alias_note).toMatch(
      /bare English "as" alone is not/,
    )
    expect(agentSurface.routing_intents.boundary).toMatch(/Claude Artifact/)
  })

  test('llms text names the apex URL pattern and Japanese as upload intent', () => {
    expect(llmsTxt).toContain('https://artifactshare.com/a/...')
    expect(llmsTxt).toContain(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json',
    )
    expect(llmsTxt).toContain('https://artifactshare.com/guides/cli')
    expect(llmsTxt).toContain('https://artifactshare.com/guides/link-sharing')
    expect(llmsTxt).toContain('link_expires_at')
    expect(capabilitiesMd).toContain('https://artifactshare.com/guides/cli')
    expect(capabilitiesMd).toContain(
      'https://artifactshare.com/guides/link-sharing',
    )
    expect(capabilitiesMd).toContain('link_sharing_plan_required')
    expect(llmsTxt).toContain('as で共有して')
    expect(llmsTxt).toMatch(/Do not treat bare "artifact" as Artifact Share/)
  })

  test('advertises CLI as the shell-available path', () => {
    expect(agentSurface.cli).toEqual({
      package: '@artifactshare/cli',
      invocation:
        'npm exec --yes --package=@artifactshare/cli -- artifactshare',
      preferred_when:
        'user_controlled_workspace_with_package_install_and_artifactshare_network',
      supports: [
        'local-file',
        'local-directory',
        'static-site',
        'json-output',
        'versioned-update',
        'human-device-authorization',
      ],
      commands: {
        init: 'npm exec --yes --package=@artifactshare/cli -- artifactshare init --json',
        open: 'npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json',
        share:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare share <path> --json',
        update:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> <path> --json',
        read: 'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <artifact-id-or-url> --json',
        download:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare download <artifact-id-or-url> --output ./artifact --json',
        login:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare login --json',
        logout:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare logout --json',
        doctor:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare doctor --json',
        edit: 'npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --json',
        delete:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare delete <artifact-id-or-url> --json',
        resolve:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare resolve <value> --json',
        whoami:
          'npm exec --yes --package=@artifactshare/cli -- artifactshare whoami --json',
        'artifacts list':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts list --json',
        'comments list':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare comments list <artifact-id-or-url> --json',
        'comments post':
          "npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body '<text>' --json",
        'comments edit':
          "npm exec --yes --package=@artifactshare/cli -- artifactshare comments edit <artifact-id-or-url> --message-id <id> --body '<text>' --json",
        'comments resolve':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare comments resolve <artifact-id-or-url> --thread-id <id> --json',
        'comments reopen':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare comments reopen <artifact-id-or-url> --thread-id <id> --json',
        'comments delete':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare comments delete <artifact-id-or-url> --thread-id <id> --json',
        'projects list':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json',
        'projects create':
          "npm exec --yes --package=@artifactshare/cli -- artifactshare projects create '<name>' --json",
        'projects edit':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <project-id> --json',
        'profiles list':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare profiles list --json',
        'profiles use':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare profiles use <name> --json',
        'profiles import-token':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare profiles import-token --profile <name> --json',
        'profiles delete':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare profiles delete <name> --json',
        'skills ensure':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool auto --json',
        'skills install':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare skills install --tool <name> --json',
        'skills list':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare skills list --json',
        'skills update':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --json',
        'skills remove':
          'npm exec --yes --package=@artifactshare/cli -- artifactshare skills remove --tool <name> --json',
      },
      auth: {
        unauthenticated_json_code: 'auth_required',
        user_prompt_fields: [
          'verification_uri_complete',
          'verification_uri',
          'user_code',
        ],
        after_approval: 'rerun_same_command',
      },
    })
  })

  test('keeps existing capability and restriction keys', () => {
    expect(agentSurface.capabilities).toEqual([...AGENT_CAPABILITIES])
    expect(agentSurface.restrictions).toEqual([...AGENT_RESTRICTIONS])
    expect(agentSurface.capabilities).toContain('share-directory')
    expect(agentSurface.capabilities).toContain('share-static-site')
    expect(agentSurface.restrictions).toContain('single-file-only')
  })

  test('scopes single-file-only to MCP', () => {
    expect(agentSurface.restriction_details['single-file-only']).toEqual({
      applies_to: ['mcp'],
    })
    expect(agentSurface.restriction_details['mime-html-or-markdown']).toEqual({
      applies_to: ['mcp'],
    })
    expect(agentSurface.cli.supports).toContain('local-directory')
    expect(agentSurface.cli.supports).toContain('static-site')
  })

  test('documents size limits for single files and static sites', () => {
    expect(agentSurface.restriction_details['size-limit-25mb']).toEqual({
      applies_to: ['single-file', 'mcp-content', 'static-site-total'],
      max_bytes: 25 * 1024 * 1024,
      static_site: {
        max_total_bytes: 25 * 1024 * 1024,
        max_file_bytes: 10 * 1024 * 1024,
        max_files: 50,
        max_path_chars: 256,
        max_folder_depth: 10,
      },
    })
  })

  test('does not expose an unreleased roadmap', () => {
    expect(agentSurface).not.toHaveProperty('roadmap')
    expect(llmsTxt).not.toContain('roadmap')
  })
})

describe('openapiStub', () => {
  test('documents the /mcp endpoint behind the oauth2 scheme', () => {
    const mcp = openapiStub.paths['/mcp']
    expect(mcp.post.security).toEqual([{ oauth2: [...MCP_OAUTH_SCOPES] }])

    const scheme = openapiStub.components.securitySchemes.oauth2
    expect(scheme.type).toBe('oauth2')
    expect(scheme.flows.authorizationCode.authorizationUrl).toMatch(
      /\/api\/auth\/oauth2\/authorize$/,
    )
    expect(scheme.flows.authorizationCode.tokenUrl).toMatch(
      /\/api\/auth\/oauth2\/token$/,
    )
  })

  test('no longer claims there is no programmatic API', () => {
    expect(openapiStub.info.description).not.toMatch(/no .*programmatic/i)
  })
})
