# Automated Cloudflare Relay Deployment

Feedback received: "Why can't we take care of deploying the Cloudflare worker if you provide an API key and secret?"

## Answer
We absolutely can! The Wrangler CLI provides a programmatic way to deploy workers if provided with a `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. 

By wrapping Wrangler in a dedicated OpenCode CLI command (e.g., `opencode relay deploy`), we could completely automate the "Bring Your Own Relay" setup process for the user. 

### Proposed Flow for Auto-Deployment
1.  **The Trigger**: The user runs `opencode relay deploy` or types `/remote` for the first time.
2.  **API Key Prompt**: The TUI asks the user to input a standard Cloudflare API Token (which they can generate in 1 click from their Cloudflare dashboard).
3.  **Automated Bundling**: OpenCode downloads a pre-compiled bundle of the `packages/relay` worker code (or extracts it from the CLI binary assets).
4.  **Secret Generation**: OpenCode automatically generates the 32-byte cryptographic `JWT_SECRET`.
5.  **Provisioning**: OpenCode uses the Cloudflare API to:
    *   Create a new Worker namespace.
    *   Inject the generated `JWT_SECRET` as an encrypted binding.
    *   Deploy the worker and configure the Durable Object classes.
6.  **Persistence**: OpenCode automatically saves the resulting deployed URL (`https://opencode-relay.<user>.workers.dev`) to the user's global config so they never have to type it again.

### Why wasn't it built in V1?
In the initial implementation, the goal was to prove the secure transport and architectural viability of the E2E-encrypted WebSocket tunnel. We relied on the standard developer workflow (`bunx wrangler deploy`) to isolate the complexity of the transport layer from the complexity of infrastructure provisioning. 

Additionally, because the Relay code currently lives alongside the app code in a monorepo, programmatically extracting and deploying *just* the Relay sub-package from inside a distributed, compiled executable (`opencode` binary) requires a dedicated build-step to bundle the worker as an asset. 

This is a fantastic UX improvement and should definitely be the very next iteration of the feature.
