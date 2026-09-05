// Executed by Bun INSIDE the unchanged, commit-pinned OpenCode workspace.
// Only context/permissions/IPC live here. Every tool schema, algorithm,
// diagnostic, attachment, and truncation result comes from upstream Tool.init.
import { randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ReadTool } from "@/tool/read"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { ShellTool } from "@/tool/shell"
import { WebFetchTool } from "@/tool/webfetch"
import { TodoWriteTool } from "@/tool/todo"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Format } from "@/format"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID } from "@/session/schema"
import { Permission } from "@/permission"

const options = JSON.parse(process.argv[2]!) as {
  root: string; permissions: Config.Info["permission"]; lsp: boolean; formatter: boolean
}
const directory = await realpath(options.root)
if (dirname(directory) === directory) throw new Error("Filesystem-root workspace is forbidden")
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const disabled = () => Effect.die(new Error("Agent generation, configuration changes and LLM delegation are unavailable in this toolbox"))

// These are execution-context providers, NOT substitute implementations of tools.
// Replacing these nodes prunes Provider/Auth/ModelsDev/Skill/plugin discovery.
// In particular, a shell.env hook must never initialize an OpenCode HTTP server.
const rules = Permission.merge(
  Permission.fromConfig({
    "*": "deny",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
    glob: "allow", grep: "allow", todowrite: "allow", edit: "ask", bash: "ask", webfetch: "ask",
  }),
  Permission.fromConfig(options.permissions ?? {}),
  Permission.fromConfig({ external_directory: "deny", task: "deny", question: "deny" }),
)
const profile: Agent.Info = {
  name: "toolbox", description: "Non-reasoning execution context", mode: "primary",
  native: true, options: {}, permission: rules,
}
const fixedConfig: Config.Info = {
  lsp: options.lsp ? {} : false, formatter: options.formatter ? {} : false,
  plugin: [], mcp: {}, agent: {}, provider: {}, instructions: [],
  skills: { paths: [], urls: [] }, share: "disabled", autoupdate: false,
}
const configLayer = Layer.succeed(Config.Service, Config.Service.of({
  get: () => Effect.succeed(fixedConfig), getGlobal: () => Effect.succeed(fixedConfig),
  getConsoleState: disabled, update: disabled, updateGlobal: disabled,
  invalidate: () => Effect.void, directories: () => Effect.succeed([]), waitForDependencies: () => Effect.void,
}))
const agentLayer = Layer.succeed(Agent.Service, Agent.Service.of({
  get: (name) => name === profile.name ? Effect.succeed(profile) : disabled(),
  list: () => Effect.succeed([profile]), defaultInfo: () => Effect.succeed(profile),
  defaultAgent: () => Effect.succeed(profile.name), generate: disabled,
}))
const pluginLayer = Layer.succeed(Plugin.Service, Plugin.Service.of({
  trigger: (_name, _input, output) => Effect.succeed(output),
  list: () => Effect.succeed([]), init: () => Effect.void,
}))
const layer = LayerNode.compile(LayerNode.group([
  FSUtil.node, Ripgrep.node, CrossSpawnSpawner.node, Truncate.node, Agent.node,
  LSP.node, Instruction.node, Format.node, EventV2Bridge.node, Config.node,
  RuntimeFlags.node, Plugin.node, Git.node, InstanceStore.node, Project.node,
  Session.node, Todo.node, httpClient,
]), [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
  [httpClient, FetchHttpClient.layer], [Agent.node, agentLayer],
  [Config.node, configLayer], [Plugin.node, pluginLayer],
  [RuntimeFlags.node, RuntimeFlags.layer({
    pure: true, disableDefaultPlugins: true, disableExternalSkills: true,
    disableClaudeCode: true, disableLspDownload: true, enableQuestionTool: false,
    experimentalBackgroundSubagents: false, experimentalPlanMode: false,
  })],
])
const runtime = ManagedRuntime.make(layer)
const scope = await Effect.runPromise(Scope.make())
const state = await runtime.runPromise(Effect.gen(function* () {
  const projects = yield* Project.Service
  const instances = yield* InstanceStore.Service
  const project = yield* projects.fromDirectory(directory)
  // Do not inherit '/' for non-git directories or a parent repository's worktree.
  return yield* instances.provide({ directory, worktree: directory, project: project.project }, Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "MCP execution toolbox" })
    const tools = yield* Effect.all([
      ReadTool.pipe(Effect.flatMap(Tool.init)), WriteTool.pipe(Effect.flatMap(Tool.init)),
      EditTool.pipe(Effect.flatMap(Tool.init)), GlobTool.pipe(Effect.flatMap(Tool.init)),
      GrepTool.pipe(Effect.flatMap(Tool.init)), ShellTool.pipe(Effect.flatMap(Tool.init)),
      WebFetchTool.pipe(Effect.flatMap(Tool.init)), TodoWriteTool.pipe(Effect.flatMap(Tool.init)),
    ])
    return { instance, session, tools }
  }))
}).pipe(Effect.provideService(Scope.Scope, scope)))

const tools = new Map(state.tools.map((tool) => [tool.id, tool]))
const controllers = new Map<string, AbortController>()
const tasks = new Set<Promise<unknown>>()
const savedOutputs = new Set<string>()
const approvals = new Map<string, { job: string; settle: (approved: boolean) => void }>()
const allowedPermissionKinds = new Set(["read", "edit", "glob", "grep", "bash", "webfetch", "todowrite", "external_directory"])

function within(root: string, path: string): boolean {
  const diff = relative(root, path)
  return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith("../") && !diff.startsWith("..\\"))
}

// Scope validation, not a replacement for native filesystem/search operations.
// This catches direct path traversal and symlink targets, including missing files.
// It is not an OS jail: use a dedicated container/VM for hostile shell commands.
async function canonical(path: string): Promise<string> {
  let current = path
  const tail: string[] = []
  while (true) {
    try { return resolve(await realpath(current), ...tail) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const info = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause
        return undefined
      })
      if (info?.isSymbolicLink()) throw new Error("Dangling symlink is outside the supported workspace scope")
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(relative(parent, current))
      current = parent
    }
  }
}
async function preflight(tool: string, args: Record<string, unknown>): Promise<boolean> {
  let savedOutput = false
  for (const key of ["filePath", "path", "workdir"]) {
    if (typeof args[key] !== "string") continue
    const target = await canonical(resolve(directory, args[key] as string))
    if (tool === "read" && key === "filePath" && savedOutputs.has(target)) { savedOutput = true; continue }
    if (!within(directory, target)) throw new Error("Path denied: target is outside OPENCODE_MCP_ROOT")
  }
  return savedOutput
}

function ask(job: string, input: Parameters<Tool.Context["ask"]>[0], savedOutput: boolean): Effect.Effect<void> {
  if (!allowedPermissionKinds.has(input.permission)) return Effect.die(new Error("Unsupported permission: " + input.permission))
  // Only an exact, previously returned native truncation file can use this exception.
  if (savedOutput && input.permission === "external_directory") return Effect.void
  const decisions = input.patterns.map((pattern) => Permission.evaluate(input.permission, pattern, rules))
  if (decisions.some((decision) => decision.action === "deny")) return Effect.die(new Error("Permission denied: " + input.permission))
  if (!decisions.some((decision) => decision.action === "ask")) return Effect.void
  return Effect.promise((signal) => new Promise<void>((resolveApproval, rejectApproval) => {
    const id = randomUUID()
    const cleanup = () => { approvals.delete(id); signal.removeEventListener("abort", abort) }
    const abort = () => { cleanup(); rejectApproval(new Error("Permission request cancelled")) }
    approvals.set(id, { job, settle: (approved) => {
      cleanup()
      if (approved) resolveApproval()
      else rejectApproval(new Error("Permission rejected: " + input.permission))
    } })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) return abort()
    send({ type: "permission", id: job, request: { id, permission: input.permission, patterns: input.patterns, metadata: input.metadata } })
  }))
}

async function execute(message: { id: string; tool: string; args: Record<string, unknown> }): Promise<void> {
  const controller = new AbortController()
  controllers.set(message.id, controller)
  try {
    const tool = tools.get(message.tool)
    if (!tool) throw new Error("Unknown native tool: " + message.tool)
    const savedOutput = await preflight(message.tool, message.args)
    const context: Tool.Context = {
      sessionID: state.session.id, messageID: MessageID.ascending(), callID: message.id,
      agent: profile.name, abort: controller.signal, messages: [],
      metadata: (progress) => Effect.sync(() => { send({ type: "progress", id: message.id, progress }) }),
      ask: (input) => ask(message.id, input, savedOutput),
    }
    const result = await runtime.runPromise(
      tool.execute(message.args as never, context).pipe(
        Effect.provideService(InstanceRef, state.instance), Effect.provideService(Scope.Scope, scope),
      ), { signal: controller.signal },
    )
    if (typeof result.metadata.outputPath === "string") savedOutputs.add(await canonical(result.metadata.outputPath))
    send({ type: "result", id: message.id, result })
  } catch (error) {
    send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) })
  } finally {
    controllers.delete(message.id)
    for (const [id, approval] of approvals) if (approval.job === message.id) { approval.settle(false); approvals.delete(id) }
  }
}

send({ type: "ready", protocol: 1, directory, tools: state.tools.map((tool) => ({
  name: tool.id, description: tool.description, inputSchema: ToolJsonSchema.fromTool(tool),
})) })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const stop = () => { for (const controller of controllers.values()) controller.abort(); lines.close() }
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
try {
  for await (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.type === "execute") {
      if (typeof message.id !== "string" || controllers.has(message.id) || typeof message.tool !== "string" || !message.args || typeof message.args !== "object" || Array.isArray(message.args)) throw new Error("Invalid execution frame")
      const task = execute(message)
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
    } else if (message.type === "cancel") {
      controllers.get(message.id)?.abort()
    } else if (message.type === "reply") {
      const approval = approvals.get(message.permission_id)
      if (!approval || approval.job !== message.job_id || !["once", "reject"].includes(message.reply)) {
        send({ type: "error", id: message.id, error: "No matching pending permission" })
      } else {
        approval.settle(message.reply === "once")
        send({ type: "ack", id: message.id })
      }
    } else throw new Error("Unknown worker operation")
  }
} finally {
  stop()
  await Promise.allSettled(tasks)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await runtime.dispose()
}
