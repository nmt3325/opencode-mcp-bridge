import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { PACKAGE_ROOT, loadConfig, workerEnvironment } from "../config.js"
import { OpencodeClient } from "../opencodeClient.js"
import { runHttp } from "../index.js"
import { isTerminal } from "../protocol.js"
import { type PluginOptions, settings, outside } from "./config.js"
import { exclusiveLock, hash, Journal, mcpSecret, privateDirectory, readJson, saveJson } from "./storage.js"
import { NotionBackend, notionConfig } from "./notion.js"
import { NotionTransport } from "./transport.js"
const execute = promisify(execFile)
export async function registerConnection(manager: ReturnType<NotionBackend["client"]["mcp"]>, name: string, url: string, token: string, file: string): Promise<void> {
  const record = await readJson<{ id?: string; credentialHash?: string }>(file, {})
  const all = await manager.list()
  let matches = all.filter(item => item.linked && item.name === name)
  if (record.id) {
    const saved = all.find(item => item.id === record.id && item.linked)
    if (saved && saved.name !== name) throw new Error("Saved MCP connection ownership changed; refusing to modify an unrelated connection")
    if (saved) matches = [saved]
  }
  if (matches.length > 1) throw new Error("Multiple plugin-owned MCP connections found; resolve duplicates before starting")
  const existing = matches[0], credentialHash = hash(token)
  const policy = { runReadToolsAutomatically: true, runWriteToolsAutomatically: true }
  let id: string
  if (existing) {
    const status = await manager.status(existing.id)
    if (existing.serverUrl !== url || status.status !== "connected" || record.credentialHash !== credentialHash) {
      await manager.update(existing.id, { serverUrl: url, auth: { type: "bearer", token }, transport: "streamableHttp", enabledToolNames: null, ...policy })
    } else if (!existing.runReadToolsAutomatically || !existing.runWriteToolsAutomatically || existing.enabledToolNames !== null) {
      await manager.update(existing.id, { enabledToolNames: null, ...policy })
    }
    id = existing.id
  } else {
    if (all.some(item => item.linked && item.serverUrl === url)) throw new Error("This URL is already registered under another connection. Use a dedicated URL; the plugin will not take over its permissions")
    id = (await manager.add({ name, serverUrl: url, auth: { type: "bearer", token }, transport: "streamableHttp", ...policy })).id
  }
  await saveJson(file, { id, credentialHash })
}
async function prepared(runtimeDir: string): Promise<boolean> {
  for (const name of ["entry.ts", "native-worker.ts"]) {
    try { if (!(await readFile(join(runtimeDir, "packages/opencode/.mcp-toolbox", name))).equals(await readFile(join(PACKAGE_ROOT, "runtime", name)))) return false }
    catch { return false }
  }
  return true
}
export async function startRuntime(directory: string, options: PluginOptions = {}, backendFactory = (config: ReturnType<typeof notionConfig>) => new NotionBackend(config)) {
  const s = await settings(directory, options)
  await privateDirectory(s.stateBase)
  if (!outside(s.root, await realpath(s.stateBase))) throw new Error("State directory resolves inside the workspace")
  const releaseEndpoint = await exclusiveLock(join(s.stateBase, "locks", `${hash(s.publicUrl)}.lock`))
  let releaseRoot: (() => Promise<void>) | undefined, closeHttp: (() => Promise<void>) | undefined
  let client: OpencodeClient | undefined, secret = ""
  const redact = (text: string) => { let safe = text.split(s.tokenV2).join("[redacted]"); if (secret) safe = safe.split(secret).join("[redacted]"); return safe }
  try {
    releaseRoot = await exclusiveLock(join(s.stateBase, "locks", `root-${hash(s.root)}.lock`))
    const probe = backendFactory(notionConfig(s)), account = await probe.withTimeout(30000, () => probe.client.account())
    const stateDir = join(s.stateBase, "accounts", hash(`${s.root}\0${account.userId}\0${account.spaceId}`))
    await privateDirectory(stateDir)
    secret = await mcpSecret(join(stateDir, "execution-secret.json"))
    const config = loadConfig({ OPENCODE_MCP_ROOT: s.root, OPENCODE_MCP_RUNTIME_DIR: s.runtimeDir,
      OPENCODE_MCP_STATE_DIR: join(stateDir, "worker"), OPENCODE_MCP_BUN: s.bun,
      OPENCODE_MCP_PORT: String(s.port), OPENCODE_MCP_TOKEN: secret,
      OPENCODE_MCP_PERMISSIONS: JSON.stringify({ "*": "allow", read: "allow", glob: "allow", grep: "allow", edit: "allow", bash: "allow", webfetch: "allow", todowrite: "allow" }) })
    if (!await prepared(s.runtimeDir)) {
      if (!s.autoSetup) throw new Error("Native runtime needs setup; enable autoSetup or run npm run setup:native")
      const releaseSetup = await exclusiveLock(join(s.stateBase, "setup", `${hash(s.runtimeDir)}.lock`))
      try {
        const env = { ...workerEnvironment(config), OPENCODE_MCP_BUN: s.bun, OPENCODE_MCP_RUNTIME_DIR: s.runtimeDir }
        await privateDirectory(config.stateDir)
        for (const dir of ["home", "home/tmp", "home/cache"]) await privateDirectory(join(config.stateDir, dir))
        await execute(s.bun, [join(PACKAGE_ROOT, "scripts/setup-native.mjs")], { cwd: PACKAGE_ROOT, env, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
      } finally { await releaseSetup() }
    }
    client = new OpencodeClient(config, () => {}); await client.start(); closeHttp = await runHttp(client, config, () => {})
    const nconfig = notionConfig(s, stateDir); nconfig.account = { ...account }
    const backend = backendFactory(nconfig)
    await backend.withTimeout(60000, () => registerConnection(backend.client.mcp(), s.connectionName, s.publicUrl, secret, join(stateDir, "connection.json")))
    const journal = new Journal(join(stateDir, "conversations.json")); await journal.load()
    const transport = new NotionTransport(backend, journal,
      `This conversation is displayed in OpenCode. For local coding work use only the execution MCP connection named ${JSON.stringify(s.connectionName)}. Its workspace is ${JSON.stringify(s.root)}. Do not substitute another project's execution connection. You own reasoning and tool selection; OpenCode only displays your answer. Tools on this dedicated connection are authorized for automatic execution.`, redact,
      async () => { for (const job of client!.list()) if (!isTerminal(job.status)) client!.cancel(job.job_id) })
    let closed = false
    return { transport, close: async () => {
      if (closed) return; closed = true
      try { await transport.close() }
      finally { try { await closeHttp!() } finally { try { await releaseRoot!() } finally { await releaseEndpoint() } } }
    } }
  } catch (error) {
    if (closeHttp) await closeHttp().catch(() => {}); else await client?.stop().catch(() => {})
    try { await releaseRoot?.() } finally { await releaseEndpoint() }
    throw new Error(redact(error instanceof Error ? error.message : String(error)))
  }
}
