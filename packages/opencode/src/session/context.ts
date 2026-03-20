type Info = {
  a2a?: {
    subject_token?: string
    workload_token?: string
  }
}

const map = new Map<string, Info>()

export namespace SessionContext {
  export function set(sessionID: string, info: Info) {
    map.set(sessionID, info)
  }

  export function get(sessionID: string) {
    return map.get(sessionID)
  }

  export function clear(sessionID: string) {
    map.delete(sessionID)
  }
}
