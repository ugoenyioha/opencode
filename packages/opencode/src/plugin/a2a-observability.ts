import { Log } from "../util/log"
import { appendFileSync } from "node:fs"

const log = Log.create({ service: "a2a" })

const KEY = Symbol.for("opencode.a2a.observability.sink")

function state() {
  const root = globalThis as typeof globalThis & {
    [KEY]?: ((event: string, data: Record<string, unknown>) => void) | undefined
  }
  return root
}

export function setA2AEventSink(next?: (event: string, data: Record<string, unknown>) => void) {
  state()[KEY] = next
}

export const A2AObs = {
  emit(event: string, data: Record<string, unknown>) {
    state()[KEY]?.(event, data)
    const file = process.env.OPENCODE_A2A_OBS_FILE
    if (file) {
      appendFileSync(file, `${JSON.stringify({ event, ...data })}\n`)
    }
    log.info(event, { event, ...data })
  },
}
