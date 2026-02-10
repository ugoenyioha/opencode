import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { TeamEvent } from "./events"

const log = Log.create({ service: "team.inbox" })

export interface InboxMessage {
  id: string
  from: string
  text: string
  timestamp: number
  read: boolean
}

/** Storage key for an agent's inbox */
function key(teamName: string, agentName: string): string[] {
  return ["team_inbox", Instance.project.id, teamName, agentName]
}

export namespace Inbox {
  /**
   * Write a message to an agent's inbox.
   * Creates the inbox file if it doesn't exist.
   */
  export async function write(teamName: string, to: string, message: Omit<InboxMessage, "read">): Promise<void> {
    const k = key(teamName, to)
    try {
      await Storage.update<InboxMessage[]>(k, (draft) => {
        draft.push({ ...message, read: false })
      })
    } catch {
      // Inbox doesn't exist yet — create it with this message
      await Storage.write(k, [{ ...message, read: false }])
    }
    log.info("inbox write", { teamName, to, from: message.from, id: message.id })
  }

  /**
   * Read all unread messages from an agent's inbox.
   */
  export async function unread(teamName: string, agentName: string): Promise<InboxMessage[]> {
    try {
      const messages = await Storage.read<InboxMessage[]>(key(teamName, agentName))
      return messages.filter((m) => !m.read)
    } catch {
      return []
    }
  }

  /**
   * Read all messages (read and unread) from an agent's inbox.
   */
  export async function all(teamName: string, agentName: string): Promise<InboxMessage[]> {
    try {
      return await Storage.read<InboxMessage[]>(key(teamName, agentName))
    } catch {
      return []
    }
  }

  /**
   * Mark all unread messages as read for an agent.
   * Returns the newly-read messages so callers can send delivery receipts.
   * Publishes TeamEvent.MessageRead with the count.
   */
  export async function markRead(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const read: InboxMessage[] = []
    try {
      await Storage.update<InboxMessage[]>(key(teamName, agentName), (draft) => {
        for (const msg of draft) {
          if (msg.read) continue
          msg.read = true
          read.push({ ...msg })
        }
      })
    } catch {
      return []
    }
    if (read.length > 0) {
      log.info("inbox marked read", { teamName, agentName, count: read.length })
      await Bus.publish(TeamEvent.MessageRead, { teamName, agentName, count: read.length })
    }
    return read
  }

  /**
   * Remove an agent's inbox entirely.
   */
  export async function remove(teamName: string, agentName: string): Promise<void> {
    try {
      await Storage.remove(key(teamName, agentName))
    } catch {
      // Already gone
    }
  }

  /**
   * Remove all inboxes for a team.
   */
  export async function removeAll(teamName: string, agentNames: string[]): Promise<void> {
    for (const name of agentNames) {
      await remove(teamName, name)
    }
    // Also remove the lead inbox
    await remove(teamName, "lead")
  }
}
