import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { PACKAGE_ROOT, UPSTREAM, workerEnvironment, type BridgeConfig } from "./config.js"
import { nativeCatalog } from "./modelTools.js"
import { isTerminal, type JobView, type NativeTool } from "./protocol.js"

const FRAME_LIMIT = 16 * 1024 * 1024
interface Job extends JobView { timer?: NodeJS.Timeout; cancelReason?: string; bytes: number }
function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
}

// Private IPC client for a standalone vendored-tool worker. No OpenCode HTTP
// client, session prompts, agent routing, model selection or backend fallback.
export class OpencodeClient {
  private child?: ChildProcessWithoutNullStreams
  private catalog: NativeTool[] = []
  private jobs = new Map<string, Job>()
  private changed = new EventEmitter()
  private fatal?: Error
  private started = false
  private stopping = false
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  constructor(readonly config: BridgeConfig) { this.changed.setMaxListeners(128) }

  async start(): Promise<void> {
    if (this.started) throw new Error("Native worker already started")
    this.started = true
    this.config.root = await realpath(this.config.root)
    if (!(await stat(this.config.root)).isDirectory() || dirname(this.config.root) === this.config.root) throw new Error("Invalid workspace root")
    if (dirname(this.config.stateDir) === this.config.stateDir) throw new Error("State directory must be a dedicated private folder")
    if (inside(this.config.root, this.config.stateDir) || inside(this.config.root, await realpath(PACKAGE_ROOT))) throw new Error("Package and state directories must be outside the editable workspace")
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    this.config.stateDir = await realpath(this.config.stateDir)
    if (inside(this.config.root, this.config.stateDir)) throw new Error("State directory resolves inside the editable workspace")
    if (process.platform !== "win32" && ((await stat(this.config.stateDir)).mode & 0o077)) throw new Error("State directory must be private (mode 0700); do not use a shared or general-purpose folder")
    for (const name of ["home", "home/tmp"]) await mkdir(join(this.config.stateDir, name), { recursive: true, mode: 0o700 })
    const env = workerEnvironment(this.config)
    const ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    const timer = setTimeout(() => this.fail(new Error("Native runtime startup timed out")), 30000)
    const entry = join(PACKAGE_ROOT, "dist/runtime/worker.js")
    this.child = spawn(process.execPath, [entry, JSON.stringify({ root: this.config.root, stateDir: this.config.stateDir, ripgrep: this.config.ripgrep })], {
      cwd: this.config.root, env, stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))
    this.child.stdout.setEncoding("utf8")
    let buffer = ""
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > FRAME_LIMIT) return this.fail(new Error("Native result exceeded the IPC limit; verify file state before retrying"))
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) }
        catch (error) { this.fail(new Error(`Invalid native response: ${(error as Error).message}`)); return }
      }
    })
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) => {
      if (!this.stopping) this.fail(new Error(`Native runtime exited (${code ?? signal}); verify file state before retrying. Work is never automatically retried.`))
    })
    try { await ready } finally { clearTimeout(timer) }
  }
  private receive(message: Record<string, any>): void {
    if (message.type === "ready") {
      if (message.protocol !== 1 || this.catalog.length) throw new Error("Unsupported or duplicate native handshake")
      this.catalog = nativeCatalog(message.tools)
      this.readyResolve?.()
      return
    }
    const job = this.jobs.get(message.id)
    if (!job || isTerminal(job.status)) return
    job.updated_at = new Date().toISOString()
    if (message.type === "progress") job.progress = message.progress
    else if (message.type === "result" || message.type === "error") {
      job.status = job.cancelReason ? "cancelled" : message.type === "error" ? "failed" : "completed"
      if (message.type === "result") job.result = message.result
      job.error = job.cancelReason ?? message.error
      clearTimeout(job.timer)
    } else throw new Error("Unknown native response type")
    job.bytes = Buffer.byteLength(JSON.stringify(this.snapshot(job.job_id)))
    this.changed.emit(job.job_id)
    this.prune(job.job_id)
  }
  private send(value: unknown): void {
    if (this.fatal) throw this.fatal
    if (!this.child || this.stopping || !this.child.stdin.writable) throw new Error("Native runtime is not available")
    const line = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(line) > FRAME_LIMIT) throw new Error("Native request exceeds the IPC limit")
    this.child.stdin.write(line, (error) => { if (error) this.fail(error) })
  }
  private fail(error: Error): void {
    if (this.fatal) return
    this.fatal = error
    this.readyReject?.(error)
    for (const job of this.jobs.values()) if (!isTerminal(job.status)) {
      job.status = "failed"; job.error = error.message
      clearTimeout(job.timer); this.changed.emit(job.job_id)
    }
    this.child?.kill("SIGTERM")
    const child = this.child
    const force = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") }, 5000)
    force.unref()
  }
  private prune(protectedId?: string): void {
    let bytes = [...this.jobs.values()].reduce((total, job) => total + job.bytes, 0)
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < this.config.maxJobs && bytes <= 32 * 1024 * 1024) break
      if (id === protectedId || !isTerminal(job.status) || this.changed.listenerCount(id)) continue
      bytes -= job.bytes; this.jobs.delete(id)
    }
  }
  private get(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new Error("Unknown or expired job_id; results are bounded and belong to this bridge instance")
    return job
  }
  snapshot(id: string): JobView {
    const { timer: _timer, cancelReason: _cancelReason, bytes: _bytes, ...view } = this.get(id)
    return view
  }
  tools(): NativeTool[] {
    if (this.fatal) throw this.fatal
    if (!this.catalog.length) throw new Error("Native runtime is not ready")
    return this.catalog
  }
  info(): Record<string, unknown> {
    return { mode: "toolbox-only", implementation: "vendored-tools", runtime: "node", opencode_installation_required: false, llm_delegation: false, pre_execution_approval: false, workspace_confinement: false, ready: !!this.catalog.length && !this.fatal,
      upstream: UPSTREAM, directory: this.config.root, tools: this.catalog.map((tool) => tool.name) }
  }
  list(): JobView[] {
    return [...this.jobs.keys()].map((id) => { const { result: _result, progress: _progress, ...summary } = this.snapshot(id); return summary })
  }
  startJob(tool: string, args: Record<string, unknown>): string {
    if (!this.tools().some((item) => item.name === tool)) throw new Error("Unknown tool: " + tool)
    if ([...this.jobs.values()].filter((job) => !isTerminal(job.status)).length >= this.config.maxConcurrent) throw new Error("Toolbox concurrency limit reached; wait for or cancel a running job")
    this.prune()
    const id = randomUUID()
    const now = new Date().toISOString()
    const job: Job = { job_id: id, tool, status: "running", created_at: now, updated_at: now, bytes: 0 }
    this.jobs.set(id, job)
    job.timer = setTimeout(() => { this.cancel(id, "Execution deadline reached; cancellation does not undo completed writes") }, this.config.jobTimeoutMs)
    try { this.send({ type: "execute", id, tool, args }) }
    catch (error) { clearTimeout(job.timer); this.jobs.delete(id); throw error }
    return id
  }
  wait(id: string, waitMs: number): Promise<JobView> {
    const job = this.get(id)
    if (isTerminal(job.status) || waitMs <= 0) return Promise.resolve(this.snapshot(id))
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.changed.off(id, changed); resolve(this.snapshot(id)) }
      const changed = () => { if (isTerminal(this.get(id).status)) finish() }
      const timer = setTimeout(finish, Math.min(50000, Math.max(0, waitMs)))
      this.changed.on(id, changed)
    })
  }
  cancel(id: string, reason = "Cancellation requested; completed file writes are not undone"): JobView {
    const job = this.get(id)
    if (!isTerminal(job.status) && !job.cancelReason) {
      job.cancelReason = reason; job.status = "cancelling"
      try { this.send({ type: "cancel", id }) }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
      this.changed.emit(id)
    }
    return this.snapshot(id)
  }
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const job of this.jobs.values()) clearTimeout(job.timer)
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL") }, 5000)
      child.once("exit", () => { clearTimeout(timer); resolve() })
      child.stdin.end()
    })
  }
}
