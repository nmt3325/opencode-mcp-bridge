import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig, NATIVE_TOOL_IDS, UPSTREAM, workerEnvironment } from "../dist/config.js"
import { OpencodeClient } from "../dist/opencodeClient.js"
import { buildMcpServer, runHttp } from "../dist/index.js"

// No fake OpenCode server or substituted tool implementations: these tests
// require setup:native and execute the pinned upstream tools on real files.
let temporary, root, config, backend, client, server, web, webUrl
let samplingRequests = 0, inferenceRequests = 0
const exists = (path) => access(path).then(() => true, () => false)
const terminal = (job) => ["completed", "failed", "cancelled"].includes(job.status)
const unpack = (result) => result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text)
async function call(name, args = {}, connection = client) { return unpack(await connection.callTool({ name, arguments: args })) }
async function finish(job, approve = false, connection = client) {
  for (let attempt = 0; attempt < 30 && !terminal(job); attempt++) {
    if (job.status === "awaiting_permission") {
      if (!approve) return job
      job = await call("opencode_permission_reply", { job_id: job.job_id, permission_id: job.permission.id, reply: "once" }, connection)
    } else job = await call("opencode_job_result", { job_id: job.job_id, wait_seconds: 1 }, connection)
  }
  assert.ok(terminal(job), `job did not finish: ${JSON.stringify(job)}`)
  return job
}
async function complete(name, args, connection = client) {
  const job = await finish(await call(name, args, connection), true, connection)
  assert.equal(job.status, "completed", JSON.stringify(job))
  return job
}
function samplingGuard(connection) {
  connection.setRequestHandler(CreateMessageRequestSchema, async () => { samplingRequests++; throw new Error("LLM sampling is forbidden") })
}
async function freePort() {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "opencode-native-test-"))
  root = join(temporary, "workspace")
  await mkdir(root)
  web = createServer((req, res) => {
    if (req.url.startsWith("/v1/")) { inferenceRequests++; res.writeHead(500); res.end("Inference must not be requested"); return }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end("<html><body><h1>Native web fixture</h1><p>検証用本文</p></body></html>")
  })
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve))
  webUrl = `http://127.0.0.1:${web.address().port}`
  await mkdir(join(root, ".opencode/plugins"), { recursive: true })
  await writeFile(join(root, ".opencode/plugins/unwanted.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, "plugin-ran"))},'bad');export default async()=>({});`)
  await writeFile(join(root, "opencode.json"), JSON.stringify({
    model: "canary/model", plugin: [join(root, ".opencode/plugins/unwanted.mjs")],
    provider: { canary: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${webUrl}/v1`, apiKey: "test-only-not-a-secret" }, models: { model: { name: "Canary" } } } },
  }))
  await writeFile(join(root, "seed.txt"), "alpha 日本語\nbeta\n")
  config = loadConfig({
    OPENCODE_MCP_ROOT: root,
    OPENCODE_MCP_RUNTIME_DIR: process.env.OPENCODE_MCP_RUNTIME_DIR ?? resolve(".opencode-runtime"),
    OPENCODE_MCP_BUN: process.env.OPENCODE_MCP_BUN ?? "bun",
    OPENCODE_MCP_STATE_DIR: join(temporary, "state"),
    OPENCODE_MCP_WAIT_MAX_SECONDS: "1",
  })
  backend = new OpencodeClient(config)
  await backend.start()
  server = buildMcpServer(backend, config)
  client = new Client({ name: "native-tool-test", version: "1" }, { capabilities: { sampling: {} } })
  samplingGuard(client)
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(left)
  await client.connect(right)
}, { timeout: 45000 })

after(async () => {
  await client?.close()
  await server?.close()
  await backend?.stop()
  if (web) await new Promise((resolve) => web.close(resolve))
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

test("native catalog and original schemas are exposed, delegation is absent", async () => {
  const catalog = (await client.listTools()).tools
  for (const name of NATIVE_TOOL_IDS) {
    const advertised = catalog.find((tool) => tool.name === name)
    assert.ok(advertised)
    assert.deepEqual(advertised.inputSchema, backend.tools().find((tool) => tool.name === name).inputSchema)
  }
  assert.deepEqual(catalog.find((tool) => tool.name === "bash").inputSchema.required, ["command"])
  for (const name of ["opencode_start", "opencode_wait", "opencode_result", "opencode_abort", "opencode_sessions", "task", "opencode_shell"]) {
    assert.ok(!catalog.some((tool) => tool.name === name))
    const response = await client.callTool({ name, arguments: { prompt: "Must not be delegated" } })
    assert.equal(response.isError, true)
  }
  const info = await call("opencode_native_info")
  assert.equal(info.llm_delegation, false)
  assert.equal(info.upstream.commit, UPSTREAM.commit)
})

test("native read preserves line metadata and Unicode", async () => {
  const job = await complete("read", { filePath: join(root, "seed.txt"), offset: 1, limit: 1 })
  assert.match(job.result.output, /1: alpha 日本語/)
  assert.equal(job.result.metadata.display.lineStart, 1)
  assert.equal(job.result.metadata.display.totalLines, 2)
})

test("native write waits for approval and writes actual bytes", async () => {
  const file = join(root, "written.txt")
  const pending = await call("write", { filePath: file, content: "first\n日本語\n" })
  assert.equal(pending.status, "awaiting_permission")
  assert.equal(pending.permission.permission, "edit")
  assert.equal(await exists(file), false)
  const done = await finish(pending, true)
  assert.equal(done.status, "completed")
  assert.equal(await readFile(file, "utf8"), "first\n日本語\n")
})

test("native edit uses upstream read-before-edit state and returns a real diff", async () => {
  await complete("read", { filePath: join(root, "written.txt") })
  const job = await complete("edit", { filePath: join(root, "written.txt"), oldString: "first", newString: "changed" })
  assert.equal(await readFile(join(root, "written.txt"), "utf8"), "changed\n日本語\n")
  assert.match(job.result.metadata.diff, /-first\n\+changed/)
})

test("native glob and ripgrep find real workspace content", async () => {
  const glob = await complete("glob", { pattern: "*.txt" })
  assert.match(glob.result.output, /written\.txt/)
  const grep = await complete("grep", { pattern: "changed", include: "*.txt" })
  assert.match(grep.result.output, /Line 1: changed/)
  assert.equal(grep.result.metadata.matches, 1)
})

test("upstream argument validation errors are not replaced by local defaults", async () => {
  const job = await finish(await call("read", {}))
  assert.equal(job.status, "failed")
  assert.match(job.error, /filePath|invalid/i)
  const malformed = await finish(await call("grep", { pattern: "[" }))
  assert.equal(malformed.status, "failed")
})

test("native webfetch converts a local HTML fixture without a model", async () => {
  const job = await complete("webfetch", { url: webUrl, format: "markdown" })
  assert.match(job.result.output, /# Native web fixture/)
  assert.match(job.result.output, /検証用本文/)
})

test("native image attachments survive the MCP conversion", async () => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tskAAAAASUVORK5CYII="
  await writeFile(join(root, "pixel.png"), Buffer.from(data, "base64"))
  const response = await client.callTool({ name: "read", arguments: { filePath: join(root, "pixel.png") } })
  assert.ok(response.content.some((part) => part.type === "image" && part.mimeType === "image/png" && part.data === data))
})

test("native TODO writes use real OpenCode session/database storage", async () => {
  const todos = [{ content: "Actual native TODO", status: "in_progress", priority: "high" }]
  const job = await complete("todowrite", { todos })
  assert.deepEqual(job.result.metadata.todos, todos)
  const db = join(config.stateDir, "home/data/opencode/opencode-local.db")
  const rows = JSON.parse(execFileSync(config.bun, ["-e", "import {Database} from 'bun:sqlite';const db=new Database(process.env.TEST_DB,{readonly:true});console.log(JSON.stringify(db.query('select content,status,priority from todo').all()));db.close();"], { encoding: "utf8", env: { ...workerEnvironment(config), TEST_DB: db } }))
  assert.deepEqual(rows, todos)
})

test("workspace traversal, sibling prefixes, and symlink escapes are denied", async () => {
  await writeFile(join(temporary, "outside.txt"), "do not disclose")
  await symlink(join(temporary, "outside.txt"), join(root, "escape.txt"))
  await mkdir(join(temporary, "workspace-sibling"))
  await writeFile(join(temporary, "workspace-sibling/secret.txt"), "sibling")
  for (const path of ["../outside.txt", "escape.txt", "../workspace-sibling/secret.txt"]) {
    const job = await finish(await call("read", { filePath: path }))
    assert.equal(job.status, "failed")
    assert.match(job.error, /outside|denied/i)
    assert.ok(!JSON.stringify(job).includes("do not disclose"))
  }
  const job = await finish(await call("write", { filePath: "../outside.txt", content: "bad" }))
  assert.equal(job.status, "failed")
  assert.equal(await readFile(join(temporary, "outside.txt"), "utf8"), "do not disclose")
})

test("rejecting one permission does not approve or reject another job", async () => {
  const first = await call("write", { filePath: join(root, "rejected.txt"), content: "no" })
  const second = await call("write", { filePath: join(root, "approved.txt"), content: "yes" })
  assert.equal(first.status, "awaiting_permission")
  assert.equal(second.status, "awaiting_permission")
  const wrong = await client.callTool({ name: "opencode_permission_reply", arguments: { job_id: first.job_id, permission_id: second.permission.id, reply: "once" } })
  assert.equal(wrong.isError, true)
  const rejected = await call("opencode_permission_reply", { job_id: first.job_id, permission_id: first.permission.id, reply: "reject" })
  assert.equal((await finish(rejected)).status, "failed")
  assert.equal((await call("opencode_job_result", { job_id: second.job_id, wait_seconds: 0 })).status, "awaiting_permission")
  assert.equal((await finish(second, true)).status, "completed")
  assert.equal(await exists(join(root, "rejected.txt")), false)
})

test("protected .env reads require a permission decision", async () => {
  await writeFile(join(root, ".env"), "TEST_ONLY=example")
  const job = await call("read", { filePath: join(root, ".env") })
  assert.equal(job.status, "awaiting_permission")
  await call("opencode_job_cancel", { job_id: job.job_id })
  assert.equal((await finish(await call("opencode_job_result", { job_id: job.job_id, wait_seconds: 1 }))).status, "cancelled")
})

test("native shell returns real stdout and exit status", async () => {
  const job = await complete("bash", { command: "printf native-shell; exit 7", timeout: 5000 })
  assert.equal(job.result.output, "native-shell")
  assert.equal(job.result.metadata.exit, 7)
})

test("bounded waits retain a long native command without rerunning it", async () => {
  const pending = await call("bash", { command: "sleep 2; printf done >> once.txt", timeout: 10000 })
  const approved = await call("opencode_permission_reply", { job_id: pending.job_id, permission_id: pending.permission.id, reply: "once" })
  assert.equal(approved.job_id, pending.job_id)
  assert.equal(approved.status, "running")
  const done = await finish(approved)
  assert.equal(done.status, "completed")
  assert.equal(await readFile(join(root, "once.txt"), "utf8"), "done")
})

test("cancellation terminates the native shell and its child process", async () => {
  const pending = await call("bash", { command: "sleep 3; printf unwanted > cancelled-marker.txt", timeout: 10000 })
  const running = await call("opencode_permission_reply", { job_id: pending.job_id, permission_id: pending.permission.id, reply: "once" })
  await call("opencode_job_cancel", { job_id: running.job_id })
  const done = await finish(await call("opencode_job_result", { job_id: running.job_id, wait_seconds: 1 }))
  assert.equal(done.status, "cancelled")
  await delay(3200)
  assert.equal(await exists(join(root, "cancelled-marker.txt")), false)
})

test("native command timeout does not leave a delayed write running", async () => {
  const job = await complete("bash", { command: "sleep 2; printf unwanted > timeout-marker.txt", timeout: 100 })
  assert.notEqual(job.result.metadata.exit, 0)
  await delay(2200)
  assert.equal(await exists(join(root, "timeout-marker.txt")), false)
})

test("native truncation stays readable through its exact returned output path", async () => {
  const job = await complete("bash", { command: "python3 -c \"print('x' * 100000)\"", timeout: 10000 })
  assert.equal(job.result.metadata.truncated, true)
  assert.equal(typeof job.result.metadata.outputPath, "string")
  const read = await complete("read", { filePath: job.result.metadata.outputPath, limit: 1 })
  assert.match(read.result.output, /xxxx/)
})

test("real HTTP transport requires auth and retains jobs across transport sessions", async () => {
  const httpConfig = { ...config, httpPort: await freePort(), mcpToken: "test-only-auth-token-long-enough" }
  const close = await runHttp(backend, httpConfig)
  const url = new URL(`http://127.0.0.1:${httpConfig.httpPort}/mcp`)
  const httpClient = new Client({ name: "http-test", version: "1" })
  const reconnect = new Client({ name: "http-reconnect", version: "1" })
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401)
    const headers = { Authorization: `Bearer ${httpConfig.mcpToken}` }
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" } })).status, 403)
    await httpClient.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
    const job = await complete("read", { filePath: join(root, "seed.txt") }, httpClient)
    await httpClient.close()
    await reconnect.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
    assert.equal((await call("opencode_job_result", { job_id: job.job_id, wait_seconds: 0 }, reconnect)).status, "completed")
    const health = await (await fetch(new URL("/healthz", url))).json()
    assert.deepEqual(Object.keys(health).sort(), ["mode", "ok", "version"])
  } finally { await httpClient.close(); await reconnect.close(); await close() }
})

test("stdio starts a real native worker and does not inherit parent secrets", async () => {
  const stdio = new Client({ name: "stdio-test", version: "1" }, { capabilities: { sampling: {} } })
  samplingGuard(stdio)
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js"), "--stdio"], cwd: resolve("."), stderr: "pipe", env: {
    PATH: process.env.PATH, OPENCODE_MCP_ROOT: root, OPENCODE_MCP_RUNTIME_DIR: config.runtimeDir,
    OPENCODE_MCP_BUN: config.bun, OPENCODE_MCP_STATE_DIR: join(temporary, "stdio-state"),
    OPENCODE_MCP_PERMISSIONS: JSON.stringify({ bash: "allow" }),
    FAKE_PARENT_SECRET_FOR_TEST: "must-not-be-inherited", OPENAI_API_KEY: "fake-key-not-a-secret",
  } })
  transport.stderr?.on("data", () => {})
  try {
    await stdio.connect(transport)
    const job = await complete("bash", { command: "printf '%s|%s' \"${FAKE_PARENT_SECRET_FOR_TEST-unset}\" \"${OPENAI_API_KEY-unset}\"", timeout: 5000 }, stdio)
    assert.equal(job.result.output, "unset|unset")
  } finally { await stdio.close() }
})

test("unavailable runtime fails closed instead of selecting a legacy/agent route", async () => {
  const unavailable = new OpencodeClient({ ...config, stateDir: join(temporary, "missing-state"), runtimeDir: join(temporary, "missing-runtime") })
  await assert.rejects(unavailable.start(), /Native runtime unavailable.*no legacy or LLM fallback/s)
  await unavailable.stop()
})

test("no model sampling, provider requests, or project plugin execution occurred", async () => {
  assert.equal(samplingRequests, 0)
  assert.equal(inferenceRequests, 0)
  assert.equal(await exists(join(root, "plugin-ran")), false)
})
