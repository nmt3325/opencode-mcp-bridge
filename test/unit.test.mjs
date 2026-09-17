import assert from "node:assert/strict"
import { test } from "node:test"
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, workerEnvironment } from "../dist/config.js"
import { OpencodeClient } from "../dist/opencodeClient.js"
import { checkPath, checkedWrite, fingerprint, reserve } from "../dist/runtime/workspace.js"
import { parseArgs } from "../dist/index.js"

// Unit tests inject IPC outcomes only, never substitute native tool algorithms.
const configuration = () => loadConfig({ OPENCODE_MCP_ROOT: "/test/workspace" })
const exists = (path) => access(path).then(() => true, () => false)
function started(client, id = "job") {
  const job = { job_id: id, tool: "write", status: "running", created_at: "now", updated_at: "now", bytes: 0 }
  client.jobs.set(id, job)
  return job
}
test("root and removed agent configuration fail closed", () => {
  assert.throws(() => loadConfig({}), /OPENCODE_MCP_ROOT/)
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/" }), /filesystem root/)
  for (const key of ["OPENCODE_BASE_URL", "OPENCODE_MCP_DEFAULT_MODEL", "OPENCODE_MCP_DEFAULT_AGENT", "OPENCODE_MCP_SHELL_BACKEND", "OPENCODE_MCP_RUNTIME_DIR", "OPENCODE_MCP_BUN"]) {
    assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", [key]: "removed" }), /removed/)
  }
})
test("configuration bounds hold and approval policy settings are rejected", () => {
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_WAIT_MAX_SECONDS: "51" }), /integer/)
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_MAX_JOBS: "8", OPENCODE_MCP_MAX_CONCURRENT: "9" }), /must not exceed/)
  for (const policy of ['{"edit":"ask"}', '{"bash":"allow"}']) {
    assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_PERMISSIONS: policy }), /removed/)
  }
  assert.equal(configuration().ripgrep, "rg")
  assert.equal(configuration().permissions, undefined)
  assert.equal(configuration().runtimeDir, undefined)
  assert.equal(configuration().bun, undefined)
})
test("HTTP transport authentication remains mandatory and length-checked", () => {
  assert.equal(configuration().mcpToken, undefined)
  assert.equal(loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_TOKEN: "x".repeat(24) }).mcpToken, "x".repeat(24))
})
test("worker environment excludes parent credentials and injection flags", () => {
  const env = workerEnvironment(configuration(), { PATH: "/bin", OPENAI_API_KEY: "example", OPENCODE_MCP_TOKEN: "example", SSH_AUTH_SOCK: "/example", NODE_OPTIONS: "--require=example", BUN_OPTIONS: "example", HOME: "/parent" })
  for (const key of ["OPENAI_API_KEY", "OPENCODE_MCP_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "BUN_OPTIONS"]) assert.equal(env[key], undefined)
  assert.notEqual(env.HOME, "/parent")
  assert.equal(env.PATH, "/bin")
})
test("removed CLI backend flags cannot select a legacy route", () => {
  assert.throws(() => parseArgs(["--base-url", "http://example.invalid"]), /removed/)
  assert.throws(() => parseArgs(["--opencode", "http://example.invalid"]), /removed/)
  assert.equal(parseArgs(["--stdio"]).mode, "stdio")
})
test("a permission frame is no longer a valid worker response", () => {
  const client = new OpencodeClient(configuration())
  const job = started(client)
  assert.throws(() => client.receive({ type: "permission", id: job.job_id, request: { id: "request" } }), /Unknown native response type/)
  assert.equal(job.status, "running")
  assert.equal(job.permission, undefined)
  assert.equal(typeof client.reply, "undefined")
  assert.equal(typeof client.pending, "undefined")
})
test("transport failure during cancellation does not escape an event callback", () => {
  const client = new OpencodeClient(configuration())
  const job = started(client)
  client.send = () => { throw new Error("test worker unavailable") }
  assert.doesNotThrow(() => client.cancel(job.job_id))
  assert.equal(job.status, "failed")
})
test("retention measures progress, errors, and results", () => {
  const client = new OpencodeClient(configuration())
  const job = started(client)
  client.receive({ type: "progress", id: job.job_id, progress: { metadata: { output: "日本語".repeat(100) } } })
  assert.equal(job.bytes, Buffer.byteLength(JSON.stringify(client.snapshot(job.job_id))))
  client.receive({ type: "error", id: job.job_id, error: "test error".repeat(50) })
  assert.equal(job.bytes, Buffer.byteLength(JSON.stringify(client.snapshot(job.job_id))))
})
test("a newly finished job is not immediately evicted behind active jobs", () => {
  const client = new OpencodeClient({ ...configuration(), maxJobs: 8 })
  for (let index = 0; index < 8; index++) started(client, String(index))
  client.receive({ type: "result", id: "7", result: { title: "new result", output: "kept", metadata: {} } })
  assert.equal(client.snapshot("7").result.output, "kept")
})
// Without an approval pause the conflict window is short, so the write guards
// are exercised directly: they still refuse to overwrite someone else's edit.
test("writes refuse changed content, mode swaps and swapped parent directories", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "toolbox-guard-")))
  const root = join(base, "workspace"), outside = join(base, "outside")
  await mkdir(root); await mkdir(outside)
  const invocation = async (path) => ({ abort: new AbortController().signal, root, savedOutputs: new Set(), guards: new Map([[path, await fingerprint(path)]]) })
  try {
    const file = join(root, "file.txt")
    await writeFile(file, "original", { mode: 0o600 })
    const content = await invocation(file)
    await writeFile(file, "external change")
    await assert.rejects(checkedWrite(content, file, "tool change"), /changed/)
    assert.equal(await readFile(file, "utf8"), "external change")
    const mode = await invocation(file)
    await chmod(file, 0o644)
    await assert.rejects(checkedWrite(mode, file, "tool change"), /changed/)
    const created = join(root, "new.txt")
    const fresh = await invocation(created)
    await writeFile(created, "created by someone else")
    await assert.rejects(checkedWrite(fresh, created, "tool change"), /changed/)
    assert.equal(await readFile(created, "utf8"), "created by someone else")
    const parent = join(root, "swap-parent")
    await mkdir(parent)
    const swapped = join(parent, "file.txt")
    const escape = await invocation(swapped)
    await rename(parent, parent + "-original"); await symlink(outside, parent)
    await assert.rejects(checkedWrite(escape, swapped, "tool change"), /changed/i)
    assert.equal(await exists(join(outside, "file.txt")), false)
  } finally { await rm(base, { recursive: true, force: true }) }
})
// The workspace root is a default, not a boundary: only the bridge's private
// trees are withheld from the tools.
test("tools reach outside the workspace root but not the bridge's private trees", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "toolbox-reserved-")))
  const root = join(base, "workspace"), outside = join(base, "outside"), state = join(base, "state")
  for (const directory of [root, outside, state]) await mkdir(directory)
  try {
    reserve([state])
    const target = join(outside, "external.txt")
    assert.equal(await checkPath(root, "../outside/external.txt"), target)
    assert.equal(await checkPath(root, target), target)
    await assert.rejects(checkPath(root, join(state, "runs", "job.json")), /private state|denied/i)
    const invocation = { abort: new AbortController().signal, root, savedOutputs: new Set(), guards: new Map([[target, await fingerprint(target)]]) }
    await checkedWrite(invocation, target, "written outside the root")
    assert.equal(await readFile(target, "utf8"), "written outside the root")
  } finally { reserve([]); await rm(base, { recursive: true, force: true }) }
})

test("standalone CLI rejects runtime and application-service options", () => {
  assert.throws(() => parseArgs(["--runtime-dir", "/old/runtime"]), /removed/)
  for (const key of ["OPENCODE_MCP_LSP", "OPENCODE_MCP_FORMATTER"]) assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", [key]: "true" }), /removed/)
})
