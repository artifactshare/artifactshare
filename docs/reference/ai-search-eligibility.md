# AI-search eligibility

The public sitemap, crawler directives, canonical links, and language alternates are owned by the public application source. The repository includes a read-only audit for checking their deployed behavior.

```sh
pnpm audit:ai-search -- --base-url http://127.0.0.1:4173
pnpm audit:ai-search
```

The command defaults to `https://artifactshare.com` and sends HTTP requests with the `OAI-SearchBot` user agent. It checks sitemap URLs, HTTP success, `noindex`, self-canonical links, English/Japanese alternates, and reciprocal language URL sets. Pass an explicit local or staging base URL while developing; running against production is an intentional operator action, not a merge prerequisite.

The audit never changes Cloudflare or application configuration. A successful user-agent request also does not prove that every published crawler IP can pass every edge-security rule; inspect those rules separately when that distinction matters.

The application continues to keep authenticated pages, operational routes, sandbox content, and private artifact pages out of the searchable public surface. Route tests are the source of truth for those exclusions.

## MCP Registry listing

`server.json` at the repository root is the listing of the remote MCP server in the official MCP Registry (`registry.modelcontextprotocol.io`) under the name `com.artifactshare/artifactshare`. Registry clients and downstream catalogs read it to find the server URL, title, description, and icon.

The namespace is proven with DNS authentication: a `v=MCPv1` TXT record on the `artifactshare.com` apex holds the public key, and a maintainer keeps the matching private key outside the repository.

To change the listing, edit `server.json`, raise `version` (the registry rejects a version that is already published), and run:

```sh
mcp-publisher validate
mcp-publisher login dns --domain artifactshare.com --private-key <hex private key>
mcp-publisher publish
```

Keep `description` within the registry limit of 100 characters. Use the glossary terms for the product, and keep the `remotes` URL equal to the production MCP endpoint.
