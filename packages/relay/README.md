# OpenCode Remote Control Relay

This is the Bring-Your-Own-Relay (BYOR) backend for OpenCode's Remote Control feature. It is a lightweight Cloudflare Worker that uses Durable Objects to securely route end-to-end encrypted WebSockets between your local `opencode` CLI and the web-based Viewer.

## Deployment Instructions

To deploy this relay to your own Cloudflare account so you can securely share your terminal over the internet:

### 1. Install Dependencies
```bash
bun install
```

### 2. Login to Cloudflare
Authenticate the Wrangler CLI with your Cloudflare account:
```bash
bunx wrangler login
```

### 3. Generate a Secret Key
You need a cryptographically secure random string (at least 32 characters long) to sign the session JWTs. 

Generate one in your terminal:
```bash
openssl rand -base64 32
```

### 4. Set the Secret in Cloudflare
Add the generated secret to your Cloudflare Worker's encrypted environment variables:
```bash
bunx wrangler secret put JWT_SECRET
# Paste your generated secret when prompted
```

### 5. Deploy the Worker
Deploy the Relay to the Cloudflare edge:
```bash
bun run deploy
```

Wrangler will output the URL of your new worker (e.g., `https://opencode-relay.<your-subdomain>.workers.dev`).

### 6. Configure OpenCode
Now tell your local OpenCode CLI to use your personal Relay instead of the default local one. 

You can do this by exporting the environment variable before running the remote command:
```bash
export OPENCODE_RELAY_URL="https://opencode-relay.<your-subdomain>.workers.dev"
opencode remote-control
```
*(Or simply type `/remote` inside the TUI while the variable is exported).*

---

### Local Development
If you want to run the relay locally for testing:

1. Create a `.dev.vars` file in this directory:
   ```env
   JWT_SECRET="your-32-character-local-development-secret-key"
   ```
2. Run the dev server:
   ```bash
   bun run dev
   ```
