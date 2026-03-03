# Bring Your Own Relay: OpenCode Remote Control

## 1. Overview

The "Bring Your Own Relay" Remote Control feature allows users to securely expose their locally running OpenCode agent to a remote Web UI Viewer. Rather than relying on a centralized SaaS proxy, developers can deploy their own lightweight relay (using Cloudflare Workers and Durable Objects) to bridge the gap between their local `workspace-serve` instance and a remote web browser.

The key design principles are:

- **Zero Trust & E2E Encryption:** The relay only passes encrypted bytes. It cannot read the payload.
- **Self-Hostable:** Built on Cloudflare Workers for easy, nearly free self-hosting.
- **Ephemeral Access:** Sessions are tied to short-lived credentials and specific connections.
- **Local Native Support:** This exact architecture naturally works for viewing a local agent in a local browser—the encrypted traffic just loops back from the edge securely.

## 2. Architectural Design

### System Components

1. **Local CLI Host (`opencode remote-control`)**
   - A new command in the OpenCode CLI.
   - Connects to the local OpenCode agent's `workspace-serve` via local WebSocket/HTTP.
   - Generates an ephemeral session and an encryption key.
   - Establishes a secure outbound WebSocket connection to the Cloudflare Relay.
   - Displays a sharable URL (with the encryption key in the URL hash, e.g., `#key=...`) to the user.

2. **Cloudflare Relay (`packages/relay`)**
   - A Cloudflare Worker utilizing a Durable Object to maintain the state of the connection between the Host and the Viewer.
   - Acts as a dumb pipe: it authenticates connections via ephemeral JWTs but simply forwards encrypted binary/text frames between the Host and the Viewer.

3. **Web UI Viewer & SDK (`createRemoteClient`)**
   - The remote frontend (typically running in a browser).
   - Extracts the encryption key from the URL hash (ensuring it is never sent to the server).
   - Connects to the Cloudflare Relay via WebSocket.
   - Decrypts incoming state updates from the Host and encrypts outbound commands/actions using the key.

4. **CLI Viewer (`opencode attach`)**
   - The remote terminal interface (to be built after the Web UI).
   - Operates identically to the Web Viewer, using the SDK to connect a terminal session on one machine to a Host on another.

### Data Flow

```text
[ Local Agent ] <-> [ CLI Host ] <=== Encrypted WS ===> [ CF Relay ] <=== Encrypted WS ===> [ Web UI Viewer ]
(workspace-serve)   (Encryption/Decryption)               (Dumb Pipe)                       (Encryption/Decryption)
```

## 3. Security Model

- **E2E Encryption via URL Hash:**
  The CLI generates a strong symmetric key (e.g., AES-GCM) locally. When it generates the viewer URL, the key is placed in the URL fragment (`#key=...`). Browsers do not send fragments to the server, guaranteeing the Relay never sees the key. Both the CLI Host and the Web UI Viewer use this key to encrypt/decrypt all WebSocket messages.
- **Ephemeral JWTs:**
  When the CLI initiates a session, it requests a short-lived connection token from the Relay. The Relay uses this token to authorize the WebSocket upgrade.
- **Cloudflare Durable Objects:**
  Each remote control session maps to a unique Durable Object instance. This ensures strict isolation between different sessions and guarantees that messages are serialized and delivered to the correct connected viewer.

## 4. Step-by-Step Implementation Plan

### Phase 1: Cloudflare Relay (`packages/relay`)

1. **Setup Project:**
   - Create `packages/relay` using the Cloudflare Workers + Durable Objects template (Wrangler).
   - Define the `SessionRelay` Durable Object.
2. **API Routes:**
   - `POST /api/session/create`: Called by the CLI Host to create a new session room. Returns a session ID and an ephemeral JWT for the Host.
   - `POST /api/session/join`: Called by the Web Viewer to request a connection token, validating limits or passwords if configured.
3. **WebSocket Handling & State Buffering:**
   - Implement WebSocket upgrade endpoints for both Host and Viewer.
   - Inside the Durable Object, maintain references to the `hostWebSocket` and an array of `viewerWebSockets`.
   - Use the Durable Object's built-in SQLite storage to buffer the last ~100 messages. This allows viewers who temporarily disconnect (e.g., refreshing the page) to receive missed events without a full state re-sync.
   - Forward messages from Host -> Viewers, and Viewer -> Host.
   - Handle disconnects cleanly (e.g., terminating the session if the Host disconnects).
4. **Deployment:**
   - Provide a `wrangler.toml` and documentation for users to deploy their own instance (`npm run deploy`).

### Phase 2: OpenCode Core CLI Host (`remote-control` command)

1. **CLI Command Setup:**
   - Add `opencode remote-control` to `packages/opencode/src/cli/cmd/remote-control.ts`.
   - Allow passing the Relay URL as an argument or via `opencode.json` config.
2. **Local Bridge Implementation:**
   - Start or connect to the local `workspace-serve` instance.
   - Listen for local state changes and output logs.
3. **Encryption & Session Management:**
   - Generate a random AES-256-GCM key.
   - Call the Relay's `/api/session/create` endpoint.
   - Connect to the Relay via WebSocket using the returned JWT.
4. **Message Forwarding:**
   - Intercept messages from the local agent, encrypt them using the AES key, and send them over the Relay WebSocket.
   - Receive encrypted messages from the Relay, decrypt them, and forward them as commands to the local agent.
5. **Output Sharable Link:**
   - Construct the viewer URL: `https://viewer.opencode.dev/remote?relay=<relay_url>&session=<session_id>#key=<encryption_key>`
   - Print the link to the console for the user to open.

### Phase 3: SDK & Web UI Viewer

1. **SDK Updates (`packages/sdk`):**
   - Create a new `createRemoteClient` factory that mimics the local client interface but routes traffic over the Relay WebSocket.
   - Integrate the Web Crypto API to handle AES-GCM encryption/decryption seamlessly inside the client layer.
2. **Web UI Integration:**
   - Build the connection flow in the React application:
     - Parse the URL parameters (`relay`, `session`).
     - Extract the encryption key from `window.location.hash`.
     - Initialize `createRemoteClient`.
   - Add UI states for "Connecting to Relay...", "Waiting for Host...", and connection dropped errors.
3. **Testing E2E:**
   - Spin up a local mock Relay.
   - Run the CLI host in test mode.
   - Connect the Web UI and verify that state synchronizes and that network inspection shows only opaque encrypted blobs.

### Phase 4: CLI Attach Command (Terminal-to-Terminal)

1. **`opencode attach <url>`:**
   - Implement a new CLI command that acts as a Viewer.
   - Parse the URL to extract the `relay`, `session`, `token`, and `#key`.
   - Connect to the Relay via WebSocket using the SDK.
   - Route incoming events to the local TUI to render output exactly as if it were a local session.
   - Capture user prompts from the terminal and send them securely over the Relay to the Host.
