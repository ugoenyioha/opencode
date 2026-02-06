import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
}

function statusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓"
    case "in_progress":
      return "•"
    case "blocked":
      return "⊘"
    case "cancelled":
      return "✗"
    default:
      return " "
  }
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  const fg = () => {
    switch (props.status) {
      case "in_progress":
        return theme.warning
      case "blocked":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0} style={{ fg: fg() }}>
        [{statusIcon(props.status)}]{" "}
      </text>
      <text flexGrow={1} wrapMode="word" style={{ fg: fg() }}>
        {props.content}
      </text>
    </box>
  )
}
