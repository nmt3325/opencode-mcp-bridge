// Exercises the npm archive in a new production-only install, with neither
// this repository's source files nor an OpenCode checkout in its working tree.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
const exec = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "toolbox-package-"))
let client
try {
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", directory], { cwd: resolve("."), maxBuffer: 4 * 1024 * 1024 })).stdout)
  const archive = join(directory, packed[0].filename)
  const files = packed[0].files.map((file) => file.path)
  for (const required of ["dist/runtime/worker.js", "dist/vendor/opencode/edit.js", "vendor/opencode/LICENSE", "vendor/opencode/UPSTREAM.json"]) assert.ok(files.includes(required), "missing package file: " + required)
  assert.ok(!files.some((path) => /^(?:src|runtime|node_modules|\.opencode-runtime)\//.test(path)))
  await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, maxBuffer: 4 * 1024 * 1024 })
  const installed = join(directory, "node_modules/opencode-mcp-bridge")
  await access(join(installed, "vendor/opencode/LICENSE"))
  await assert.rejects(access(join(installed, "src")))
  await assert.rejects(access(join(installed, "runtime/native-worker.ts")))
  const root = join(directory, "workspace"), state = join(directory, "state"), blocked = join(directory, "blocked")
  await mkdir(root); await mkdir(blocked)
  const marker = join(directory, "forbidden-runtime-called")
  for (const name of ["bun", "opencode", "git"]) await writeFile(join(blocked, name), `#!/bin/sh\nprintf forbidden > '${marker}'\nexit 99\n`, { mode: 0o755 })
  const rg = process.env.OPENCODE_MCP_RG || (await exec("which", ["rg"])).stdout.trim()
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(installed, "dist/index.js")], cwd: directory, stderr: "pipe",
    env: { PATH: blocked, OPENCODE_MCP_ROOT: root, OPENCODE_MCP_STATE_DIR: state,
      OPENCODE_MCP_RG: rg },
  })
  let diagnostics = ""
  transport.stderr?.on("data", (chunk) => { diagnostics += chunk })
  client = new Client({ name: "packed-toolbox-smoke", version: "1" })
  try { await client.connect(transport) } catch (error) { throw new Error(`${error}\n${diagnostics}`) }
  const tools = (await client.listTools()).tools.map((tool) => tool.name)
  for (const name of ["read", "write", "edit", "apply_patch", "bash", "glob", "grep", "webfetch", "todowrite"]) assert.ok(tools.includes(name))
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args })
    return response.structuredContent ?? JSON.parse(response.content[0].text)
  }
  const run = async (name, args) => {
    let job = await call(name, args)
    for (let i = 0; !["completed", "failed", "cancelled"].includes(job.status) && i < 20; i++) job = await call("opencode_job_result", { job_id: job.job_id, wait_seconds: 1 })
    assert.equal(job.status, "completed", JSON.stringify(job)); return job
  }
  const info = await call("opencode_native_info", {})
  assert.equal(info.opencode_installation_required, false)
  assert.equal(info.implementation, "vendored-tools")
  await run("write", { filePath: "packed.txt", content: "before 日本語\n" })
  await run("edit", { filePath: "packed.txt", oldString: "before", newString: "after" })
  assert.match((await run("read", { filePath: "packed.txt" })).result.output, /after 日本語/)
  await run("apply_patch", { patchText: "*** Begin Patch\n*** Add File: patch.txt\n+packaged patch\n*** End Patch" })
  assert.equal((await run("bash", { command: "printf packed-shell; exit 7", timeout: 5000 })).result.metadata.exit, 7)
  assert.equal((await run("grep", { pattern: "packaged patch", path: "patch.txt" })).result.metadata.matches, 1)
  assert.ok((await run("glob", { pattern: "*.txt" })).result.output.includes("packed.txt"))
  await run("todowrite", { todos: [{ content: "Package smoke test", status: "completed", priority: "high" }] })
  assert.equal(await readFile(join(root, "packed.txt"), "utf8"), "after 日本語\n")
  await assert.rejects(access(marker))
  console.log(`Production archive passed: ${packed[0].filename}; tools execute without source checkout, OpenCode, Bun or Git.`)
} finally { await client?.close(); await rm(directory, { recursive: true, force: true }) }
