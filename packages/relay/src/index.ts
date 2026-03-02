import { SessionRelay } from "./durable";
import { SignJWT, jwtVerify, importJWK } from "jose";

export { SessionRelay };

export interface Env {
  SESSION_RELAY: DurableObjectNamespace;
  JWT_SECRET?: string; // Secret used to sign session tokens. Should be set in wrangler secrets.
}

async function getSecretKey(env: Env): Promise<Uint8Array> {
  const secret = env.JWT_SECRET || "default_dev_secret_please_change_in_prod";
  const encoder = new TextEncoder();
  return encoder.encode(secret);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers for API routes
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === "/health") {
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // --- API Routes ---

    if (path === "/api/session/create" && request.method === "POST") {
      // 1. Generate a random session ID
      const sessionId = crypto.randomUUID();
      
      // 2. Generate a Host JWT valid for this specific session
      const key = await getSecretKey(env);
      const hostToken = await new SignJWT({ role: "host", sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("24h") // Host session lasts max 24 hours
        .sign(key);

      return new Response(JSON.stringify({ sessionId, token: hostToken }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (path === "/api/session/join" && request.method === "POST") {
      try {
        const body = await request.json() as { sessionId?: string };
        if (!body.sessionId) {
          return new Response("Missing sessionId", { status: 400, headers: corsHeaders });
        }

        // 3. Generate a Viewer JWT valid for this specific session
        const key = await getSecretKey(env);
        const viewerToken = await new SignJWT({ role: "viewer", sessionId: body.sessionId })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("1h") // Viewer token expires relatively quickly
          .sign(key);

        return new Response(JSON.stringify({ token: viewerToken }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (e) {
        return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
      }
    }

    // --- WebSocket Routes ---

    if (path.startsWith("/relay/")) {
      const urlSessionId = path.split("/")[2];
      if (!urlSessionId) {
        return new Response("Missing session ID", { status: 400 });
      }

      // Check for token in query params or Authorization header
      const token = url.searchParams.get("token") || request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) {
        return new Response("Missing token", { status: 401 });
      }

      try {
        // Validate the JWT
        const key = await getSecretKey(env);
        const { payload } = await jwtVerify(token, key);

        if (payload.sessionId !== urlSessionId) {
          return new Response("Token does not match session", { status: 403 });
        }

        // Add the verified role to the request so the Durable Object knows who is connecting
        request.headers.set("X-Verified-Role", payload.role as string);
        
        const id = env.SESSION_RELAY.idFromName(urlSessionId);
        const stub = env.SESSION_RELAY.get(id);

        return stub.fetch(request);
      } catch (e) {
        return new Response("Invalid or expired token", { status: 401 });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}
