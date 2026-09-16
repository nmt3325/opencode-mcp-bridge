// Private JSONL worker for extracted tools. This is Node code, not OpenCode.
import { randomUUID } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Tool } from "./tool.js"
import { FSUtil } from "./filesystem.js"
import { Ripgrep } from "./ripgrep.js"
import { Output } from "./output.js"
import { Todo } from "./todo-store.js"
import { PACKAGE_ROOT } from "../config.js"
import { Invocation, Workspace, canonical, checkPath, fingerprint, reserve, within } from "./workspace.js"
import { ReadTool } from "../vendor/opencode/read.js"
import { WriteTool } from "../vendor/opencode/write.js"
import { EditTool } from "../vendor/opencode/edit.js"
import { GlobTool } from "../vendor/opencode/glob.js"
import { GrepTool } from "../vendor/opencode/grep.js"
import { WebFetchTool } from "../vendor/opencode/webfetch.js"
import { TodoWriteTool } from "../vendor/opencode/todo.js"
import { ToolJsonSchema } from "../vendor/opencode/json-schema.js"
import { ShellTool } from "./shell.js"
import { ApplyPatchTool } from "./apply-patch.js"

console.log = console.error.bind(console)
console.info = console.error.bind(console)
console.debug = console.error.bind(console)
const options = JSON.parse(process.argv[2]!) as { root: string; stateDir: string; ripgrep: string }
const directory = await realpath(options.root)
if (dirname(directory) === directory) throw new Error("Filesystem-root workspace is forbidden")
const runId = randomUUID()
const runDir = join(options.stateDir, "runs", runId)
await mkdir(runDir, { recursive: true, mode: 0o700 })
// Tools may work anywhere the OS account can reach. Only the bridge's own
// private state and package trees stay reserved, so job bookkeeping, saved
// output and the toolbox's own code cannot be rewritten through a tool call.
reserve([await canonical(options.stateDir), await canonical(PACKAGE_ROOT)])
const workspace = Layer.succeed(Workspace, { directory, worktree: directory, stateDir: runDir, ripgrep: options.ripgrep })
const runtime = ManagedRuntime.make(Layer.mergeAll(
  workspace, FSUtil.layer, Ripgrep.layer.pipe(Layer.provide(workspace)),
  Output.layer(join(runDir, "output")), Todo.layer(runDir), FetchHttpClient.layer,
))
const definitions = await runtime.runPromise(Effect.all([ReadTool, WriteTool, EditTool, GlobTool, GrepTool, ShellTool, WebFetchTool, TodoWriteTool, ApplyPatchTool]))
const tools = new Map(definitions.map((tool) => [tool.id, tool]))
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const controllers = new Map<string, AbortController>()
const tasks = new Set<Promise<void>>()
const savedOutputs = new Set<string>()
const allowed = new Set(["read", "edit", "glob", "grep", "bash", "webfetch", "todowrite", "external_directory"])
// No interactive approval and no deny list: a declared capability either belongs
// to a shipped tool and runs immediately, or is not implemented here at all.
function ask(input: Parameters<Tool.Context["ask"]>[0]) {
  if (!allowed.has(input.permission) || !input.patterns.length) return Effect.die(new Error("Unsupported permission: " + input.permission))
  return Effect.void
}
async function execute(message: { id: string; tool: string; args: Record<string, unknown> }) {
  const controller = new AbortController()
  controllers.set(message.id, controller)
  try {
    const tool = tools.get(message.tool)
    if (!tool) throw new Error("Unknown tool: " + message.tool)
    const args = { ...message.args }
    const guards = new Map<string, Awaited<ReturnType<typeof fingerprint>>>()
    for (const key of ["filePath", "path", "workdir"]) {
      if (typeof args[key] !== "string") continue
      const target = await canonical(resolve(directory, args[key]))
      if (!(message.tool === "read" && key === "filePath" && savedOutputs.has(target))) await checkPath(directory, target)
      args[key] = target
      if (["write", "edit"].includes(message.tool) && key === "filePath") guards.set(target, await fingerprint(target))
    }
    controller.signal.throwIfAborted()
    const ctx: Tool.Context = {
      sessionID: runId, abort: controller.signal,
      metadata: (progress) => Effect.sync(() => { send({ type: "progress", id: message.id, progress }) }),
      ask: (input) => ask(input),
    }
    const result = await runtime.runPromise(tool.execute(args, ctx).pipe(Effect.provideService(Invocation, {
      abort: controller.signal, root: directory, savedOutputs: message.tool === "read" ? savedOutputs : new Set(), guards,
    })), { signal: controller.signal })
    if (typeof result.metadata.outputPath === "string") {
      const path = await canonical(result.metadata.outputPath)
      if (!within(join(runDir, "output"), path)) throw new Error("Unexpected output path")
      savedOutputs.add(path)
    }
    send({ type: "result", id: message.id, result })
  } catch (error) {
    send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) })
  } finally {
    controllers.delete(message.id)
  }
}
send({ type: "ready", protocol: 1, directory, tools: definitions.map((tool) => ({ name: tool.id, description: tool.description, inputSchema: ToolJsonSchema.fromTool(tool) })) })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const stop = () => { for (const controller of controllers.values()) controller.abort(); lines.close() }
process.once("SIGTERM", stop); process.once("SIGINT", stop)
try {
  for await (const line of lines) {
    if (!line.trim()) continue
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("IPC frame too large")
    const message = JSON.parse(line)
    if (message.type === "execute") {
      if (typeof message.id !== "string" || controllers.has(message.id) || typeof message.tool !== "string" || !message.args || typeof message.args !== "object" || Array.isArray(message.args)) throw new Error("Invalid execution frame")
      const task = execute(message); tasks.add(task); void task.finally(() => tasks.delete(task))
    } else if (message.type === "cancel") controllers.get(message.id)?.abort()
    else throw new Error("Unknown worker operation")
  }
} finally { stop(); await Promise.allSettled(tasks); await runtime.dispose() }
