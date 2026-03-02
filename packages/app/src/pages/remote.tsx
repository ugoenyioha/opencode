import { useNavigate, useSearchParams } from "@solidjs/router"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useServer } from "@/context/server"

export default function RemoteControl() {
  const [searchParams] = useSearchParams()
  const server = useServer()
  const navigate = useNavigate()

  const [status, setStatus] = createSignal("Initializing...")
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    // We must read the #key from the hash manually, as SolidJS router doesn't parse it out
    // natively if we just want the raw string, and we need to immediately strip it from the URL bar
    const params = new URLSearchParams(window.location.search)
    let key = params.get("key")
    if (!key) {
      const hashMatch = window.location.hash.match(/#?key=(.+)/)
      key = hashMatch ? hashMatch[1] : null
    }

    if (!key) {
      setError("Missing encryption key in URL hash. This link is invalid.")
      return
    }

    const relay = Array.isArray(searchParams.relay) ? searchParams.relay[0] : searchParams.relay
    const session = Array.isArray(searchParams.session) ? searchParams.session[0] : searchParams.session

    if (!relay || !session) {
      setError("Missing relay or session parameters in URL.")
      return
    }

    // Immediately remove the key from the URL bar to prevent accidental sharing
    const sanitized = new URL(window.location.href)
    sanitized.searchParams.delete("key")
    if (sanitized.hash.startsWith("#key=")) {
      sanitized.hash = ""
    }
    window.history.replaceState(null, "", sanitized.pathname + sanitized.search + sanitized.hash)

    setStatus("Connecting to Relay...")

    // Tell the Server context to switch to a remote connection mode
    // We will need to update the Server context to handle this new type of connection
    const cleanup = server.connectRemote({
      relayUrl: relay,
      sessionId: session,
      encryptionKeyBase64: key,
      onConnect: () => {
        setStatus("Connected! Handshaking with Host...")
        // Wait for the server.connected event from the host, then navigate to the remote session view
        // For now, just a small delay before assuming it works and navigating
        setTimeout(() => {
          navigate(`/-/session`) // Special directory route for remote viewing
        }, 1000)
      },
      onError: (err) => {
        setError(err.message)
      },
    })

    onCleanup(() => {
      cleanup?.()
    })
  })

  return (
    <div class="flex h-screen w-full items-center justify-center bg-base-900 text-base-100">
      <div class="flex max-w-md flex-col items-center gap-4 text-center">
        <Show
          when={error()}
          fallback={
            <>
              <div class="size-8 animate-spin rounded-full border-4 border-base-700 border-t-primary-500" />
              <h1 class="text-xl font-medium">{status()}</h1>
              <p class="text-sm text-base-400">
                Establishing a secure end-to-end encrypted connection to the remote agent.
              </p>
            </>
          }
        >
          {(err) => (
            <>
              <div class="flex size-12 items-center justify-center rounded-full bg-danger-500/20 text-danger-500">
                <svg class="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h1 class="text-xl font-medium text-danger-500">Connection Failed</h1>
              <p class="text-sm text-base-400">{err()}</p>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
