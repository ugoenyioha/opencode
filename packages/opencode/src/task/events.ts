import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const TaskStatus = z.enum(["running", "completed", "failed"])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskInfoSchema = z.object({
  id: z.string(),
  pid: z.number(),
  command: z.string(),
  startTime: z.number(),
  status: TaskStatus,
  exitCode: z.number().optional(),
  workdir: z.string(),
  description: z.string().optional(),
})

export type TaskInfo = z.infer<typeof TaskInfoSchema>

export namespace TaskEvent {
  export const Created = BusEvent.define(
    "task.created",
    z.object({
      info: TaskInfoSchema,
    }),
  )

  export const Output = BusEvent.define(
    "task.output",
    z.object({
      id: z.string(),
      data: z.string(),
      isError: z.boolean(),
    }),
  )

  export const Completed = BusEvent.define(
    "task.completed",
    z.object({
      id: z.string(),
      exitCode: z.number().nullable(),
      status: TaskStatus,
    }),
  )

  export const Killed = BusEvent.define(
    "task.killed",
    z.object({
      id: z.string(),
    }),
  )
}
