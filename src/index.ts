#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig, type BridgeConfig } from "./config.js"
import { OpencodeClient } from "./opencodeClient.js"
import { registerTools } from "./tools.js"

export const SERVER_NAME = "opencode-mcp-bridge"
export const SERVER_VERSION = "0.1.0"

export function buildMcpServer(client: OpencodeClient, config: BridgeConfig): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			instructions:
				"Bridge to a running `opencode serve`. Long work never blocks: opencode_start returns a session_id, opencode_wait long polls under the client timeout, opencode_shell returns a shell_id and opencode_shell_output streams it in chunks.",
		},
	)
	registerTools(server, client, config)
	return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	if (chunks.length === 0) return undefined
	const raw = Buffer.concat(chunks).toString("utf8")
	if (raw.trim() === "") return undefined
	return JSON.parse(raw)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload)
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
	res.end(body)
}

function authorized(req: IncomingMessage, config: BridgeConfig): boolean {
	if (!config.mcpToken) return true
	const header = req.headers.authorization
	if (typeof header === "string" && header.startsWith("Bearer ") && header.slice(7) === config.mcpToken) return true
	const alt = req.headers["x-mcp-token"]
	return typeof alt === "string" && alt === config.mcpToken
}

export async function runHttp(client: OpencodeClient, config: BridgeConfig): Promise<void> {
	const transports = new Map<string, StreamableHTTPServerTransport>()

	const httpServer = createHttpServer((req, res) => {
		void (async () => {
			try {
				const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"))
				if (url.pathname === "/healthz") {
					const capabilities = await client.capabilities(url.searchParams.get("refresh") === "1").catch((error: unknown) => ({
						error: (error as Error).message,
					}))
					sendJson(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, opencode: capabilities })
					return
				}
				if (url.pathname !== "/mcp") {
					sendJson(res, 404, { error: "not found", hint: "the MCP endpoint is POST /mcp" })
					return
				}
				if (!authorized(req, config)) {
					sendJson(res, 401, { error: "unauthorized", hint: "send Authorization: Bearer $OPENCODE_MCP_TOKEN" })
					return
				}
				const body = req.method === "POST" ? await readBody(req) : undefined
				const rawSession = req.headers["mcp-session-id"]
				const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession
				let transport = sessionId ? transports.get(sessionId) : undefined
				if (!transport) {
					if (req.method !== "POST" || !isInitializeRequest(body)) {
						sendJson(res, 400, {
							jsonrpc: "2.0",
							id: null,
							error: { code: -32000, message: "Bad Request: no valid session id, send an initialize request first" },
						})
						return
					}
					const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						enableJsonResponse: true,
						onsessioninitialized: (id: string) => {
							transports.set(id, created)
						},
					})
					created.onclose = () => {
						const id = created.sessionId
						if (id) transports.delete(id)
					}
					await buildMcpServer(client, config).connect(created)
					transport = created
				}
				await transport.handleRequest(req, res, body)
			} catch (error) {
				console.error("[opencode-mcp-bridge] request failed:", error)
				if (!res.headersSent) {
					sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: (error as Error).message } })
				}
			}
		})()
	})

	await new Promise<void>((resolve) => {
		httpServer.listen(config.httpPort, config.httpHost, () => {
			console.error(
				"[opencode-mcp-bridge] listening on http://" + config.httpHost + ":" + config.httpPort + "/mcp -> " + config.baseUrl,
			)
			resolve()
		})
	})

	const shutdown = () => {
		console.error("[opencode-mcp-bridge] shutting down")
		httpServer.close()
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

export async function runStdio(client: OpencodeClient, config: BridgeConfig): Promise<void> {
	const server = buildMcpServer(client, config)
	await server.connect(new StdioServerTransport())
	console.error("[opencode-mcp-bridge] stdio transport ready -> " + config.baseUrl)
}

function parseArgs(argv: string[]): { mode: "http" | "stdio"; overrides: NodeJS.ProcessEnv } {
	const overrides: NodeJS.ProcessEnv = {}
	let mode: "http" | "stdio" = "stdio"
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		const next = argv[i + 1]
		if (arg === "--http") mode = "http"
		else if (arg === "--stdio") mode = "stdio"
		else if (arg === "--port" && next) {
			overrides.OPENCODE_MCP_PORT = next
			i += 1
		} else if (arg === "--host" && next) {
			overrides.OPENCODE_MCP_HOST = next
			i += 1
		} else if ((arg === "--base-url" || arg === "--opencode") && next) {
			overrides.OPENCODE_BASE_URL = next
			i += 1
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				[
					"opencode-mcp-bridge",
					"",
					"  --http                 serve MCP over streamable HTTP (POST /mcp)",
					"  --stdio                serve MCP over stdio (default)",
					"  --port <n>             HTTP port (default 8787)",
					"  --host <addr>          HTTP bind address (default 127.0.0.1)",
					"  --base-url <url>       opencode server URL (default http://127.0.0.1:4096)",
				].join("\n"),
			)
			process.exit(0)
		}
	}
	return { mode, overrides }
}

async function main(): Promise<void> {
	const { mode, overrides } = parseArgs(process.argv.slice(2))
	const config = loadConfig({ ...process.env, ...overrides })
	const client = new OpencodeClient(config)
	if (mode === "http") await runHttp(client, config)
	else await runStdio(client, config)
}

const entry = process.argv[1] ?? ""
if (entry.endsWith("index.js") || entry.endsWith("opencode-mcp-bridge")) {
	main().catch((error: unknown) => {
		console.error("[opencode-mcp-bridge] fatal:", error)
		process.exit(1)
	})
}
