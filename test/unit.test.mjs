import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig, workerEnvironment } from "../dist/config.js"
import { OpencodeClient } from "../dist/opencodeClient.js"
import { parseArgs } from "../dist/index.js"

// Unit tests inject IPC outcomes only, never substitute native tool algorithms.
const configuration = () => loadConfig({ OPENCODE_MCP_ROOT: "/test/workspace" })
function pending(client, id = "job") {
  const job = { job_id: id, tool: "write", status: "awaiting_permission", created_at: "now", updated_at: "now", bytes: 0, permission: { id: "permission", permission: "edit", patterns: ["file.txt"], metadata: {} } }
  client.jobs.set(id, job)
  return job
}
test("root and removed agent configuration fail closed", () => {
  assert.throws(() => loadConfig({}), /OPENCODE_MCP_ROOT/)
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/" }), /filesystem root/)
  for (const key of ["OPENCODE_BASE_URL", "OPENCODE_MCP_DEFAULT_MODEL", "OPENCODE_MCP_DEFAULT_AGENT", "OPENCODE_MCP_SHELL_BACKEND"]) {
    assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", [key]: "removed" }), /removed/)
  }
})
test("configuration bounds and native permission shapes are validated", () => {
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_WAIT_MAX_SECONDS: "51" }), /integer/)
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_MAX_JOBS: "8", OPENCODE_MCP_MAX_CONCURRENT: "9" }), /must not exceed/)
  assert.throws(() => loadConfig({ OPENCODE_MCP_ROOT: "/workspace", OPENCODE_MCP_PERMISSIONS: '{"edit":"sometimes"}' }))
  assert.equal(configuration().lsp, false)
  assert.equal(configuration().formatter, false)
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
test("failed permission delivery retains the existing pending request", async () => {
  const client = new OpencodeClient(configuration())
  const job = pending(client)
  client.send = () => { throw new Error("test IPC failure") }
  await assert.rejects(client.reply(job.job_id, "permission", "once"), /IPC failure/)
  assert.equal(job.status, "awaiting_permission")
  assert.equal(job.permission.id, "permission")
})
test("ACK cannot erase a newer native permission", async () => {
  const client = new OpencodeClient(configuration())
  const job = pending(client)
  client.send = (frame) => {
    client.receive({ type: "ack", id: frame.id })
    client.receive({ type: "permission", id: job.job_id, request: { ...job.permission, id: "next" } })
  }
  await client.reply(job.job_id, "permission", "once")
  assert.equal(job.status, "awaiting_permission")
  assert.equal(job.permission.id, "next")
})
test("successful ACK clears only its own permission", async () => {
  const client = new OpencodeClient(configuration())
  const job = pending(client)
  client.send = (frame) => client.receive({ type: "ack", id: frame.id })
  await client.reply(job.job_id, "permission", "once")
  assert.equal(job.status, "running")
  assert.equal(job.permission, undefined)
})
test("transport failure during cancellation does not escape an event callback", () => {
  const client = new OpencodeClient(configuration())
  const job = pending(client)
  client.send = () => { throw new Error("test worker unavailable") }
  assert.doesNotThrow(() => client.cancel(job.job_id))
  assert.equal(job.status, "failed")
})
test("retention measures progress, permissions, errors, and results", () => {
  const client = new OpencodeClient(configuration())
  const job = pending(client)
  client.receive({ type: "progress", id: job.job_id, progress: { metadata: { output: "日本語".repeat(100) } } })
  assert.equal(job.bytes, Buffer.byteLength(JSON.stringify(client.snapshot(job.job_id))))
  client.receive({ type: "error", id: job.job_id, error: "test error".repeat(50) })
  assert.equal(job.bytes, Buffer.byteLength(JSON.stringify(client.snapshot(job.job_id))))
})
test("a newly finished job is not immediately evicted behind active jobs", () => {
  const client = new OpencodeClient({ ...configuration(), maxJobs: 8 })
  for (let index = 0; index < 8; index++) pending(client, String(index))
  client.receive({ type: "result", id: "7", result: { title: "new result", output: "kept", metadata: {} } })
  assert.equal(client.snapshot("7").result.output, "kept")
})
