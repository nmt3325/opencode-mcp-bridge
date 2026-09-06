#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { pathToFileURL } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig, type BridgeConfig } from "./config.js"
import { OpencodeClient } from "./opencodeClient.js"
import { buildMcpServer } from "./tools.js"
export { buildMcpServer } from "./tools.js"

export function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  const alternative = req.headers["x-mcp-token"]
  const value = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : alternative
  if (typeof value !== "string") return false
  const expected = Buffer.from(token), actual = Buffer.from(value)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" })
  res.end(body)
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw new Error("Request body exceeds 8 MiB")
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text.trim() ? JSON.parse(text) : undefined
}
export async function runHttp(client: OpencodeClient, config: BridgeConfig, log: (message: string) => void = console.error): Promise<() => Promise<void>> {
  if (!config.mcpToken || config.mcpToken.length < 24) throw new Error("HTTP requires OPENCODE_MCP_TOKEN with at least 24 characters, including on loopback")
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; touched: number }>()
  const server = createServer((req, res) => { void (async () => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname
      if (path === "/healthz") { const ok = client.info().ready === true; json(res, ok ? 200 : 503, { ok, mode: "toolbox-only", version: "0.3.0" }); return }
      if (path !== "/mcp") { json(res, 404, { error: "not found" }); return }
      if (!authorized(req, config.mcpToken!)) { json(res, 401, { error: "unauthorized" }); return }
      if (req.headers.origin) { json(res, 403, { error: "Browser-origin requests are not supported; use an authenticated MCP client" }); return }
      const body = req.method === "POST" ? await readBody(req) : undefined
      const id = req.headers["mcp-session-id"]
      if (Array.isArray(id)) { json(res, 400, { error: "Invalid session header" }); return }
      let entry = id ? transports.get(id) : undefined
      if (id && !entry) { json(res, 404, { error: "MCP transport session expired; initialize again. Execution jobs remain available." }); return }
      if (!entry) {
        if (req.method !== "POST" || !isInitializeRequest(body)) { json(res, 400, { error: "Initialize an MCP session first" }); return }
        if (transports.size >= 128) { json(res, 503, { error: "Too many active transport sessions" }); return }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: (session) => { transports.set(session, { transport, touched: Date.now() }) },
        })
        await buildMcpServer(client, config).connect(transport)
        const onclose = transport.onclose
        transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); onclose?.() }
        entry = { transport, touched: Date.now() }
      }
      entry.touched = Date.now()
      await entry.transport.handleRequest(req, res, body)
    } catch (error) {
      console.error("[toolbox] request failed:", (error as Error).message)
      if (!res.headersSent) json(res, 400, { error: (error as Error).message })
      else res.end()
    }
  })() })
  server.requestTimeout = 65000
  const reap = setInterval(() => {
    for (const [id, entry] of transports) if (Date.now() - entry.touched > 30 * 60 * 1000) {
      transports.delete(id); void entry.transport.close()
    }
  }, 60000)
  reap.unref()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.httpPort, config.httpHost, resolve) })
  log(`[toolbox] HTTP ready on ${config.httpHost}:${config.httpPort}/mcp`)
  return async () => {
    clearInterval(reap)
    await Promise.allSettled([...transports.values()].map((entry) => entry.transport.close()))
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await client.stop()
  }
}
export function parseArgs(argv: string[]): { mode: "stdio" | "http"; overrides: NodeJS.ProcessEnv; help: boolean } {
  let mode: "stdio" | "http" = "stdio"
  const overrides: NodeJS.ProcessEnv = {}
  const keys: Record<string, string> = { "--root": "OPENCODE_MCP_ROOT", "--runtime-dir": "OPENCODE_MCP_RUNTIME_DIR", "--host": "OPENCODE_MCP_HOST", "--port": "OPENCODE_MCP_PORT" }
  let help = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--stdio" || arg === "--http") mode = arg === "--http" ? "http" : "stdio"
    else if (arg === "--help" || arg === "-h") help = true
    else if (keys[arg]) {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg)
      overrides[keys[arg]!] = value
    } else throw new Error("Unknown or removed argument: " + arg)
  }
  return { mode, overrides, help }
}
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log("opencode-mcp-bridge: native execution toolbox only\n  --stdio | --http\n  --root <workspace>\n  --runtime-dir <pinned-checkout>\n  --host <address> --port <number>\nRun npm run setup:native before the first start. HTTP requires OPENCODE_MCP_TOKEN."); return }
  const config = loadConfig({ ...process.env, ...args.overrides })
  if (args.mode === "http" && (!config.mcpToken || config.mcpToken.length < 24)) throw new Error("HTTP requires OPENCODE_MCP_TOKEN with at least 24 characters")
  const client = new OpencodeClient(config)
  try {
    await client.start()
    let close: () => Promise<void>
    if (args.mode === "http") close = await runHttp(client, config)
    else {
      const server = buildMcpServer(client, config)
      await server.connect(new StdioServerTransport())
      close = async () => { await server.close(); await client.stop() }
      console.error("[toolbox] stdio ready")
    }
    let closing = false
    const shutdown = () => { if (closing) return; closing = true; void close().then(() => process.exit(0), () => process.exit(1)) }
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown)
    if (args.mode === "stdio") {
      if (process.stdin.readableEnded) shutdown()
      else process.stdin.once("end", shutdown)
    }
  } catch (error) { await client.stop(); throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { console.error("[toolbox]", (error as Error).message); process.exitCode = 1 })
}
