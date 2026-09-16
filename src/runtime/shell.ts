// OpenCode's command schema, preview and tail algorithms with a Node process
// adapter. No shell.env plugin hook, application config or command parser VM.
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { Effect } from "effect"
import { Tool } from "./tool.js"
import { Workspace, checkPath } from "./workspace.js"
import { Parameters } from "../vendor/opencode/shell-parameters.js"
import { preview, tail } from "../vendor/opencode/shell-output.js"
import { MAX_BYTES, MAX_LINES } from "./output.js"
const CAPTURE_LIMIT = 64 * 1024 * 1024
export const ShellTool = Tool.define("bash", Effect.succeed({
  description: "Execute a shell command in the workspace (bash on POSIX, cmd.exe on Windows). The timeout is in milliseconds (default 120000). Output is bounded and longer output is saved for read. Commands run immediately; there is no confirmation step. A running job is not completion; poll its job_id, never repeat it. This tool does not invoke an AI model.",
  parameters: Parameters,
  execute: (params: Parameters, ctx: Tool.Context) => Effect.gen(function* () {
    const workspace = yield* Workspace
    const cwd = yield* Effect.promise(() => checkPath(workspace.directory, params.workdir ?? workspace.directory))
    if (!params.command.trim()) throw new Error("command must not be empty")
    yield* ctx.ask({ permission: "bash", patterns: [params.command], always: ["*"], metadata: { command: params.command, cwd } })
    // Wait for real process teardown even when the enclosing Effect is cancelled.
    return yield* Effect.uninterruptible(Effect.promise(() => capture(params.command, cwd, params.timeout ?? 120000, join(workspace.stateDir, "output"), ctx)))
  }),
}))
async function capture(command: string, cwd: string, timeout: number, directory: string, ctx: Tool.Context) {
  ctx.abort.throwIfAborted()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const outputPath = join(directory, `tool_${randomUUID()}.txt`)
  ctx.abort.throwIfAborted()
  const sink = createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
  const shell = process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/bash"
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
  const child = spawn(shell, args, { cwd, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
  let lastProgress = 0
  let retained = "", last = "", captured = 0, bytesSeen = 0, timedOut = false, aborted = false, captureLimited = false
  let failure: Error | undefined, escalation: NodeJS.Timeout | undefined, closed = false
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal)
      else { const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); killer.on("error", () => child.kill()) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error }
  }
  const terminate = () => {
    if (closed) return
    killTree("SIGTERM")
    if (!escalation) escalation = setTimeout(() => killTree("SIGKILL"), 3000)
  }
  const abort = () => { aborted = true; terminate() }
  const timer = setTimeout(() => { timedOut = true; terminate() }, Math.min(timeout, 2_147_483_647))
  sink.on("error", (error) => { failure = error; terminate() })
  const flush = new Promise<void>((resolve) => { sink.once("finish", resolve); sink.once("close", resolve) })
  const onChunk = (chunk: string) => {
    const bytes = Buffer.from(chunk)
    bytesSeen += bytes.length
    retained = tail(retained + chunk, MAX_LINES * 2, MAX_BYTES * 2).text
    last = preview(last + chunk)
    if (captured < CAPTURE_LIMIT) {
      const keep = bytes.subarray(0, CAPTURE_LIMIT - captured)
      captured += keep.length
      if (!sink.write(keep)) { child.stdout.pause(); child.stderr.pause() }
    }
    if (bytesSeen > CAPTURE_LIMIT) { captureLimited = true; terminate() }
    if (Date.now() - lastProgress >= 250) {
      lastProgress = Date.now()
      Effect.runSync(ctx.metadata({ metadata: { output: last, capturedBytes: captured } }))
    }
  }
  sink.on("drain", () => { child.stdout.resume(); child.stderr.resume() })
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8")
    stream.on("data", (chunk: Buffer) => onChunk(decoder.write(chunk)))
    stream.on("end", () => { const rest = decoder.end(); if (rest) onChunk(rest) })
    stream.on("error", (error) => { failure = error; terminate() })
  }
  const exit = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => { failure = error })
    child.once("close", (code) => { closed = true; resolve(code) })
    ctx.abort.addEventListener("abort", abort, { once: true })
    if (ctx.abort.aborted) abort()
  })
  clearTimeout(timer); ctx.abort.removeEventListener("abort", abort)
  if (escalation) { clearTimeout(escalation); killTree("SIGKILL") }
  sink.end(); await flush
  if (failure) throw failure
  const end = tail(retained, MAX_LINES, MAX_BYTES)
  const truncated = bytesSeen > MAX_BYTES || end.cut || captureLimited
  let output = end.text || "(no output)"
  if (truncated) output = `...output truncated...\n\n${captureLimited ? "Captured prefix" : "Full output"} saved to: ${outputPath}\n\n` + output
  else await unlink(outputPath)
  const notes: string[] = []
  if (timedOut) notes.push(`shell tool terminated command after exceeding timeout ${timeout} ms.`)
  if (aborted) notes.push("User aborted the command")
  if (captureLimited) notes.push(`Command terminated after exceeding the ${CAPTURE_LIMIT} byte capture limit. Output file contains a prefix, not the full output.`)
  if (notes.length) output += `\n\n<shell_metadata>\n${notes.join("\n")}\n</shell_metadata>`
  return { title: command, output, metadata: { output: last, exit: timedOut || aborted || captureLimited ? null : exit, truncated,
    timedOut, captureLimited, capturedBytes: captured, ...(truncated ? { outputPath } : {}),
  } }
}
