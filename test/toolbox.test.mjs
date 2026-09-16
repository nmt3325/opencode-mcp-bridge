import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access, readdir, chmod, rename } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig, NATIVE_TOOL_IDS, UPSTREAM } from "../dist/config.js"
import { OpencodeClient } from "../dist/opencodeClient.js"
import { buildMcpServer, runHttp } from "../dist/index.js"

// Real extracted tools on real files. Node and npm are sufficient; no OpenCode checkout, Bun, application database or model is available to this worker.
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
    if (req.url === "/oversized") { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(5 * 1024 * 1024 + 1)); return }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" }); res.flushHeaders()
      const timer = setTimeout(() => res.end("late"), 3000)
      res.on("close", () => clearTimeout(timer)); return
    }
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
  assert.equal(info.implementation, "vendored-tools")
  assert.equal(info.opencode_installation_required, false)
  assert.equal(info.runtime, "node")
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

test("extracted edit applies upstream replacement logic and returns a real diff", async () => {
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

test("TODO writes use small standalone JSON storage, not an OpenCode database", async () => {
  const todos = [{ content: "Actual native TODO", status: "in_progress", priority: "high" }]
  const job = await complete("todowrite", { todos })
  assert.deepEqual(job.result.metadata.todos, todos)
  const runs = await readdir(join(config.stateDir, "runs"))
  const rows = JSON.parse(await readFile(join(config.stateDir, "runs", runs[0], "todos.json"), "utf8"))
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

test("apply_patch adds, updates, moves and deletes real files", async () => {
  const added = await complete("apply_patch", { patchText: "*** Begin Patch\n*** Add File: patch/a.txt\n+alpha\n+beta\n*** Add File: patch/remove.txt\n+delete me\n*** End Patch" })
  assert.equal(added.result.metadata.files.length, 2)
  await complete("apply_patch", { patchText: "*** Begin Patch\n*** Update File: patch/a.txt\n*** Move to: patch/moved.txt\n@@\n-alpha\n+updated 日本語\n beta\n*** Delete File: patch/remove.txt\n*** End Patch" })
  assert.equal(await readFile(join(root, "patch/moved.txt"), "utf8"), "updated 日本語\nbeta\n")
  assert.equal(await exists(join(root, "patch/a.txt")), false)
  assert.equal(await exists(join(root, "patch/remove.txt")), false)
})

test("patch path escapes and bad later hunks fail before any writes", async () => {
  for (const suffix of ["*** Add File: ../escape-patch.txt\n+bad", "*** Update File: seed.txt\n@@\n-not in file\n+bad"]) {
    const job = await finish(await call("apply_patch", { patchText: `*** Begin Patch\n*** Add File: must-not-exist.txt\n+bad\n${suffix}\n*** End Patch` }))
    assert.equal(job.status, "failed", JSON.stringify(job))
    assert.equal(await exists(join(root, "must-not-exist.txt")), false)
  }
})

test("patch refuses an existing add/move target and duplicate paths", async () => {
  const patches = [
    "*** Add File: seed.txt\n+bad",
    "*** Update File: written.txt\n*** Move to: seed.txt\n@@\n-changed\n+bad",
    "*** Add File: duplicate.txt\n+one\n*** Add File: duplicate.txt\n+two",
  ]
  for (const patchText of patches) {
    const job = await finish(await call("apply_patch", { patchText: `*** Begin Patch\n${patchText}\n*** End Patch` }))
    assert.equal(job.status, "failed", JSON.stringify(job))
  }
  assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "alpha 日本語\nbeta\n")
  assert.equal(await exists(join(root, "duplicate.txt")), false)
})

test("write refuses a file changed while its permission was pending", async () => {
  const path = join(root, "concurrent.txt")
  await writeFile(path, "original")
  const pending = await call("write", { filePath: path, content: "tool change" })
  assert.equal(pending.status, "awaiting_permission")
  await writeFile(path, "user change")
  const rejected = await finish(pending, true)
  assert.equal(rejected.status, "failed")
  assert.match(rejected.error, /changed.*permission/)
  assert.equal(await readFile(path, "utf8"), "user change")
})

test("new-file permission cannot overwrite a file created by someone else", async () => {
  const path = join(root, "created-concurrently.txt")
  const pending = await call("write", { filePath: path, content: "tool change" })
  await writeFile(path, "created by user")
  assert.equal((await finish(pending, true)).status, "failed")
  assert.equal(await readFile(path, "utf8"), "created by user")
})

test("edit retains BOM and CRLF with upstream replacement semantics", async () => {
  const path = join(root, "bom.txt")
  await writeFile(path, "\uFEFFfirst\r\nsecond\r\n")
  await complete("edit", { filePath: path, oldString: "first\nsecond", newString: "updated\nsecond" })
  assert.equal(await readFile(path, "utf8"), "\uFEFFupdated\r\nsecond\r\n")
})

test("ambiguous edit fails; replaceAll and literal replacement dollars work", async () => {
  const path = join(root, "repeated.txt")
  await writeFile(path, "same same")
  const job = await finish(await call("edit", { filePath: path, oldString: "same", newString: "changed" }))
  assert.equal(job.status, "failed")
  assert.equal(await readFile(path, "utf8"), "same same")
  await complete("edit", { filePath: path, oldString: "same", newString: "$&-$1", replaceAll: true })
  assert.equal(await readFile(path, "utf8"), "$&-$1 $&-$1")
})

test("empty oldString may create but cannot overwrite an existing file", async () => {
  const path = join(root, "created-by-edit.txt")
  await complete("edit", { filePath: path, oldString: "", newString: "new" })
  const failed = await finish(await call("edit", { filePath: path, oldString: "", newString: "overwrite" }))
  assert.equal(failed.status, "failed")
  assert.equal(await readFile(path, "utf8"), "new")
})

test("grep with a file path does not leak matches from sibling files", async () => {
  await writeFile(join(root, "grep-target.txt"), "chosen\n")
  await writeFile(join(root, "grep-sibling.txt"), "chosen chosen\n")
  const job = await complete("grep", { path: join(root, "grep-target.txt"), pattern: "chosen" })
  assert.equal(job.result.metadata.matches, 1)
  assert.ok(!job.result.output.includes("grep-sibling.txt"))
})

test("search does not follow out-of-root directory symlinks", async () => {
  const outside = join(temporary, "search-outside")
  await mkdir(outside)
  await writeFile(join(outside, "secret.txt"), "UNIQUE-OUTSIDE-SEARCH-CONTENT")
  await symlink(outside, join(root, "search-link"))
  const job = await complete("grep", { pattern: "UNIQUE-OUTSIDE-SEARCH-CONTENT" })
  assert.equal(job.result.metadata.matches, 0)
})

test("read handles unterminated lines, directory pages and binary rejection", async () => {
  await writeFile(join(root, "unterminated.txt"), "一行\nlast")
  const read = await complete("read", { filePath: join(root, "unterminated.txt"), offset: 2 })
  assert.match(read.result.output, /2: last/)
  const directory = await complete("read", { filePath: root, limit: 1 })
  assert.equal(directory.result.metadata.display.type, "directory")
  assert.equal(directory.result.metadata.display.entries.length, 1)
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]))
  assert.equal((await finish(await call("read", { filePath: join(root, "binary.bin") }))).status, "failed")
})

test("saved output access is limited to the exact registered file", async () => {
  const job = await complete("bash", { command: "printf '%60000s' x", timeout: 5000 })
  assert.equal(job.result.metadata.truncated, true)
  const path = job.result.metadata.outputPath
  const forbidden = await finish(await call("read", { filePath: join(path, "../../todos.json") }))
  assert.equal(forbidden.status, "failed")
  const write = await finish(await call("write", { filePath: path, content: "cannot rewrite private output" }))
  assert.equal(write.status, "failed")
})

test("webfetch caps chunked bytes and times out slow response bodies", async () => {
  const large = await finish(await call("webfetch", { url: `${webUrl}/oversized`, format: "text" }), true)
  assert.equal(large.status, "failed", JSON.stringify(large))
  assert.match(large.error, /too large/)
  const slow = await finish(await call("webfetch", { url: `${webUrl}/slow`, format: "text", timeout: 0.1 }), true)
  assert.equal(slow.status, "failed", JSON.stringify(slow))
  assert.match(slow.error, /timed out/)
})

test("the MCP server advertises tools only, no prompts or sampling service", async () => {
  const capabilities = client.getServerCapabilities()
  assert.deepEqual(Object.keys(capabilities), ["tools"])
  await assert.rejects(client.listPrompts())
  await assert.rejects(client.listResources())
})

test("permission-time mode changes and parent symlink swaps are refused", async () => {
  const modePath = join(root, "mode-change.txt")
  await writeFile(modePath, "original", { mode: 0o600 })
  let pending = await call("write", { filePath: modePath, content: "changed" })
  await chmod(modePath, 0o644)
  assert.equal((await finish(pending, true)).status, "failed")
  assert.equal(await readFile(modePath, "utf8"), "original")
  const parent = join(root, "swap-parent"), outside = join(temporary, "swap-outside")
  await mkdir(parent); await mkdir(outside)
  pending = await call("write", { filePath: join(parent, "file.txt"), content: "changed" })
  await rename(parent, parent + "-original"); await symlink(outside, parent)
  assert.equal((await finish(pending, true)).status, "failed")
  assert.equal(await exists(join(outside, "file.txt")), false)
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
    PATH: process.env.PATH, OPENCODE_MCP_ROOT: root, OPENCODE_MCP_STATE_DIR: join(temporary, "stdio-state"),
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

test("unavailable workspace fails closed instead of selecting another execution directory", async () => {
  const unavailable = new OpencodeClient({ ...config, stateDir: join(temporary, "missing-state"), root: join(temporary, "missing-workspace") })
  await assert.rejects(unavailable.start(), /ENOENT/)
  await unavailable.stop()
})

test("no model sampling, provider requests, or project plugin execution occurred", async () => {
  assert.equal(samplingRequests, 0)
  assert.equal(inferenceRequests, 0)
  assert.equal(await exists(join(root, "plugin-ran")), false)
})
