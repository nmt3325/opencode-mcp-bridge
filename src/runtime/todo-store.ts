import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({
    description: "Priority level of the task: high, medium, low",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export class Service extends Context.Service<Service, {
  update: (input: { sessionID: string; todos: ReadonlyArray<Info> }) => Effect.Effect<void>
}>()("toolbox/TodoStore") {}
export function layer(directory: string) {
  return Layer.succeed(Service, Service.of({ update: ({ todos }) => Effect.promise(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.todos-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(todos, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, join(directory, "todos.json"))
  }) }))
}
export * as Todo from "./todo-store.js"
