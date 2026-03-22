import { Log } from "../util/log"
import { appendFileSync } from "node:fs"

const log = Log.create({ service: "a2a" })

let sink: ((event: string, data: Record<string, unknown>) => void) | undefined

export function setA2AEventSink(next?: (event: string, data: Record<string, unknown>) => void) {
  sink = next
}

export const A2AObs = {
  emit(event: string, data: Record<string, unknown>) {
    sink?.(event, data)
    const file = process.env.OPENCODE_A2A_OBS_FILE
    if (file) {
      appendFileSync(file, `${JSON.stringify({ event, ...data })}\n`)
    }
    log.info(event, { event, ...data })
  },
}
