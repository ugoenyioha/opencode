import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createSignal, onMount, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

interface TaskInfo {
  id: string
  pid: number
  command: string
  startTime: number
  status: "running" | "completed" | "failed"
  exitCode?: number
  workdir: string
  description?: string
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function DialogTasks() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()

  const [tasks, setTasks] = createSignal<TaskInfo[]>([])
  const [toKill, setToKill] = createSignal<string>()

  const fetchTasks = async () => {
    try {
      const res = await sdk.fetch(`${sdk.url}/task`)
      if (res.ok) {
        setTasks((await res.json()) as TaskInfo[])
      }
    } catch {
      // Silently retry on next interval — task list is non-critical
    }
  }

  onMount(() => {
    fetchTasks()
    dialog.setSize("large")
  })

  const refreshInterval = setInterval(fetchTasks, 2000)
  onCleanup(() => clearInterval(refreshInterval))

  const options = createMemo(() => {
    const list = tasks()
    if (list.length === 0) return []

    return list
      .toSorted((a, b) => b.startTime - a.startTime)
      .map((task): DialogSelectOption<string> => {
        const isKilling = toKill() === task.id
        const dur = formatDuration(Date.now() - task.startTime)
        const statusText =
          task.status === "running"
            ? `running ${dur}`
            : task.status === "completed"
              ? `completed (exit: ${task.exitCode ?? 0})`
              : `failed (exit: ${task.exitCode ?? "?"})`
        const category = task.status === "running" ? "Running" : task.status === "completed" ? "Completed" : "Failed"

        return {
          title: isKilling ? "Press again to confirm kill" : task.description || task.command.substring(0, 60),
          bg: isKilling ? theme.error : undefined,
          value: task.id,
          category,
          footer: `PID ${task.pid} | ${statusText}`,
          gutter:
            task.status === "running" ? (
              <text fg={theme.primary}>*</text>
            ) : task.status === "completed" ? (
              <text fg={theme.success}>ok</text>
            ) : (
              <text fg={theme.error}>!</text>
            ),
        }
      })
  })

  const killTask = async (taskId: string) => {
    try {
      const res = await sdk.fetch(`${sdk.url}/task/${taskId}/kill`, { method: "POST" })
      if (res.ok) {
        toast.show({ message: "Task killed", variant: "info" })
        fetchTasks()
      } else {
        toast.show({ message: "Failed to kill task", variant: "error", duration: 3000 })
      }
    } catch {
      toast.show({ message: "Failed to kill task", variant: "error", duration: 3000 })
    }
    setToKill(undefined)
  }

  const viewOutput = async (taskId: string) => {
    try {
      const res = await sdk.fetch(`${sdk.url}/task/${taskId}/tail?lines=100`)
      if (res.ok) {
        const data = (await res.json()) as { output: string }
        dialog.replace(() => <DialogTaskOutput taskId={taskId} output={data.output} />)
      }
    } catch {
      toast.show({ message: "Failed to fetch output", variant: "error" })
    }
  }

  return (
    <Show
      when={tasks().length > 0}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={1}>
              Background Tasks
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>
          <text fg={theme.textMuted}>No background tasks.</text>
          <text fg={theme.textMuted}>Press Ctrl+B while a bash command is running to send it to the background.</text>
        </box>
      }
    >
      <DialogSelect
        title="Background Tasks"
        options={options()}
        onMove={() => setToKill(undefined)}
        onSelect={(option) => viewOutput(option.value)}
        keybind={[
          {
            keybind: { name: "k", ctrl: true, meta: false, shift: false, leader: false },
            title: "kill",
            onTrigger: async (option) => {
              const task = tasks().find((t) => t.id === option.value)
              if (!task || task.status !== "running") {
                toast.show({ message: "Task is not running", variant: "warning" })
                return
              }
              if (toKill() === option.value) {
                await killTask(option.value)
                return
              }
              setToKill(option.value)
            },
          },
        ]}
      />
    </Show>
  )
}

function DialogTaskOutput(props: { taskId: string; output: string }) {
  const { theme } = useTheme()

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1} flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={1}>
          Task Output: {props.taskId}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <scrollbox flexGrow={1}>
        <text fg={theme.text} wrapMode="word">
          {props.output || "(No output)"}
        </text>
      </scrollbox>
    </box>
  )
}
