# @artifactshare/qm-bridge

This is a host-side service library, not a sharing CLI for a model shell. Do not expose its credential provider or trusted context to a model sandbox.

The package separates untrusted share intent, host-authenticated context, and the Artifact Share bridge credential. The server remains authoritative for conversation mapping, destination, grants, and the final audience ceiling.

## Install

```sh
npm install @artifactshare/qm-bridge
```

The root export provides `validateBridgeConfig`, `createBridgePolicy`, and `publishTrusted`. `@artifactshare/qm-bridge/client` provides the fetch-based Artifact Share client. Root, client, and testing exports contain no Node-only imports and can be bundled for Cloudflare Workers. The `qm` subpath only normalizes fields that a protected qm host has already authenticated; it does not read environment variables or infer trust.

## Minimal host integration

```ts
import {
  createBridgePolicy,
  publishTrusted,
  validateBridgeConfig,
} from '@artifactshare/qm-bridge'
import { createArtifactShareBridgeClient } from '@artifactshare/qm-bridge/client'

const config = validateBridgeConfig(parsedConfig)
const result = await publishTrusted({
  intent: untrustedModelIntent,
  context: authenticatedHostContext,
  policy: createBridgePolicy(config),
  client: createArtifactShareBridgeClient({
    baseUrl: config.base_url,
    timeoutMs: config.request_timeout_ms,
  }),
  credentialProvider: async () => ({
    bearer_token: await hostSecretStore.read(),
  }),
})
```

The host must reuse the same host-generated request ID when retrying. The library performs one request and no hidden retry. A requested workspace audience is only intent: private or stale host context and server policy can narrow it. A successful workspace `set_visibility` request may therefore return current `private` visibility without being treated as an error.

Every `BridgeClient` declares the exact `credentialOrigin` that receives the bridge credential. `publishTrusted` rejects a client whose origin differs from the policy before reading the credential.

## Configuration

The JSON configuration contains `base_url`, a bound `source`, optional `request_timeout_ms` and `max_payload_bytes`, and a nonempty `allowed_conversations` array. The allowlist compares the current authenticated conversation ID; former IDs support server-side mapping continuity but never authorize a request.

The Node operator executable reads only `ARTIFACTSHARE_BRIDGE_TOKEN`, and only `health` uses its value:

```sh
artifactshare-qm-bridge check --config bridge.json --json
artifactshare-qm-bridge health --config bridge.json --json
artifactshare-qm-bridge dry-run --config bridge.json --intent intent.json --context context.json --json
```

All commands require `--json`. Invalid command syntax returns exit 2 with `error.code: "invalid_cli_usage"`; scripts should parse that code to distinguish usage errors from a reachable bridge rejection. `dry-run` is offline and anchors public freshness to the fixture timestamp, so `fixture_anchor_valid` checks syntax and the freshness code path, not wall-clock freshness. Exit 0 is success, 2 is invalid input or application rejection, 3 is unavailable credential/network/timeout, and 1 is an invalid server response or unexpected failure.

## Lifecycle

The package has no install or postinstall script. Initial npm publication is a separate owner-approved production operation through the protected release workflow; merging this package does not publish it. For the first publication only, configure the production environment secret `NPM_QM_BRIDGE_BOOTSTRAP_TOKEN`. After the package exists, configure npm trusted publishing for `release-qm-bridge.yml` and the `production` environment, then delete the bootstrap secret. Later releases use OIDC with no npm write token. A future Cloudflare OS Gatekeeper can use the host-neutral root and client exports without importing the qm subpath.
