import { randomUUID } from "node:crypto"
import type { BridgeConfig } from "./config.js"

export class OpencodeError extends Error {
	readonly status: number
	readonly body: string
	constructor(message: string, status = 0, body = "") {
		super(message)
		this.name = "OpencodeError"
		this.status = status
		this.body = body.slice(0, 2_000)
	}
}

export interface RawResponse {
	status: number
	ok: boolean
	data: unknown
	text: string
}

export interface Capabilities {
	baseUrl: string
	reachable: boolean
	shellApi: "v2" | "legacy" | "pty"
	/** True when this build exposes /api/pty, the only shell route free of a model. */
	ptyApi: boolean
	promptAsync: boolean
	sessionStatusEndpoint: boolean
	vcsBase: string | null
	detectedAt: string
	error?: string
}

export interface NormalizedMessage {
	index: number
	id: string
	role: string
	text: string
	tools: Array<{ name: string; status?: string }>
}

export interface LocalJob {
	id: string
	command: string
	sessionId: string
	status: "running" | "completed" | "failed" | "killed"
	output: string
	exitCode: number | null
	startedAt: number
	finishedAt?: number
	error?: string
}

/**
 * A command started through opencode's PTY API. Unlike the legacy route this
 * never involves a model: opencode spawns a real terminal, streams its bytes
 * over a WebSocket and reports the process exit code.
 */
export interface PtyJob {
	id: string
	command: string
	status: "running" | "completed" | "failed" | "killed"
	output: string
	exitCode: number | null
	startedAt: number
	finishedAt?: number
	error?: string
	truncated: boolean
	killRequested: boolean
	socket: MinimalSocket | null
	timeoutTimer?: NodeJS.Timeout
}

/**
 * The slice of the WebSocket API the bridge actually uses, declared locally so
 * this file still compiles against the Node types alone, with no DOM lib.
 */
export interface MinimalSocket {
	binaryType: string
	onmessage: ((event: { data: unknown }) => void) | null
	onerror: ((event: unknown) => void) | null
	onclose: ((event: unknown) => void) | null
	close: () => void
}

type SocketConstructor = new (url: string, options?: unknown) => MinimalSocket

/** Node exposes a global WebSocket from 22 onwards; 20 does not. */
export function socketConstructor(): SocketConstructor | null {
	const candidate = (globalThis as { WebSocket?: unknown }).WebSocket
	return typeof candidate === "function" ? (candidate as SocketConstructor) : null
}

const TERMINAL_NOISE =
	/\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** Terminals speak escape sequences and CRLF; MCP clients want plain text. */
export function stripTerminalNoise(chunk: string): string {
	return chunk.replace(TERMINAL_NOISE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function str(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number") return String(value)
	return undefined
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
	if (!record) return undefined
	for (const key of keys) {
		const value = str(record[key])
		if (value !== undefined) return value
	}
	return undefined
}

function firstNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
	if (!record) return undefined
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "number" && Number.isFinite(value)) return value
	}
	return undefined
}

function toArray(value: unknown, keys: string[] = ["items", "results", "data", "messages", "shells", "permissions"]): unknown[] {
	if (Array.isArray(value)) return value
	const record = asRecord(value)
	if (!record) return []
	for (const key of keys) {
		if (Array.isArray(record[key])) return record[key] as unknown[]
	}
	return []
}

/** Collect text out of a `{ info, parts }` style message payload. */
export function normalizeMessage(entry: unknown, index: number): NormalizedMessage {
	const record = asRecord(entry) ?? {}
	const info = asRecord(record.info) ?? record
	const rawParts = Array.isArray(record.parts)
		? record.parts
		: Array.isArray(info.parts)
			? (info.parts as unknown[])
			: []
	let text = ""
	const tools: Array<{ name: string; status?: string }> = []
	for (const part of rawParts) {
		const p = asRecord(part)
		if (!p) continue
		const type = str(p.type)
		if (type === "text" || type === "reasoning") {
			const value = str(p.text)
			if (value) text += (text === "" ? "" : "\n") + value
		} else if (type === "tool" || type === "tool-invocation") {
			const state = asRecord(p.state)
			tools.push({ name: firstString(p, ["tool", "name"]) ?? "tool", status: firstString(state, ["status"]) })
		}
	}
	if (text === "") text = firstString(record, ["text", "content"]) ?? firstString(info, ["text", "content"]) ?? ""
	return {
		index,
		id: firstString(info, ["id", "messageID"]) ?? "msg-" + index,
		role: firstString(info, ["role"]) ?? "unknown",
		text,
		tools,
	}
}

/** opencode replies use several shapes across versions; squeeze text out of all of them. */
export function extractShellText(data: unknown): string {
	if (typeof data === "string") return data
	const record = asRecord(data)
	if (!record) return ""
	const direct = firstString(record, ["output", "stdout", "text", "content", "result"])
	const stderr = firstString(record, ["stderr"])
	let out = direct ?? ""
	if (stderr && stderr !== direct) out += (out === "" ? "" : "\n") + stderr
	if (out !== "") return out
	const parts = Array.isArray(record.parts) ? record.parts : []
	for (const part of parts) {
		const p = asRecord(part)
		if (!p) continue
		const state = asRecord(p.state)
		const value =
			firstString(p, ["text"]) ??
			firstString(state, ["output", "stdout"]) ??
			firstString(asRecord(state?.metadata), ["output", "stdout"])
		if (value) out += (out === "" ? "" : "\n") + value
	}
	return out
}

export function extractSessionStatus(data: unknown, sessionId: string): string | undefined {
	if (Array.isArray(data)) {
		for (const entry of data) {
			const record = asRecord(entry)
			if (!record) continue
			const id = firstString(record, ["sessionID", "sessionId", "id"])
			if (id === sessionId) return firstString(record, ["status", "state"]) ?? (record.busy === true ? "busy" : record.busy === false ? "idle" : undefined)
		}
		return undefined
	}
	const record = asRecord(data)
	if (!record) return undefined
	const entry = record[sessionId]
	if (typeof entry === "string") return entry
	if (typeof entry === "boolean") return entry ? "busy" : "idle"
	const nested = asRecord(entry)
	if (nested) return firstString(nested, ["status", "state"]) ?? (nested.busy === true ? "busy" : nested.busy === false ? "idle" : undefined)
	if (Array.isArray(record.sessions)) return extractSessionStatus(record.sessions, sessionId)
	return undefined
}

/**
 * True when a response body really parsed as JSON. Guards against opencode builds
 * that answer unknown paths with the web UI (an HTML document) and HTTP 200,
 * which would otherwise look like a working v2 endpoint.
 */
export function isJsonPayload(response: { data: unknown; text: string }): boolean {
	if (response.data === null || response.data === undefined) return false
	if (typeof response.data !== "object") return false
	if (response.text.trimStart().startsWith("<")) return false
	return true
}

export class OpencodeClient {
	private readonly config: BridgeConfig
	private caps: Capabilities | null = null
	private capsAt = 0
	// Set only when a build that advertises /api/pty refuses to start one, so a
	// genuine no is remembered while a missed probe is not.
	private ptyRefused = false
	private static readonly PTY_RECHECK_MS = 15_000
	private promptAsyncSupported = true
	private sessionStatusSupported = true
	private readonly jobs = new Map<string, LocalJob>()
	private shellSessionId: string | null = null
	private readonly ptys = new Map<string, PtyJob>()

	constructor(config: BridgeConfig) {
		this.config = config
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" }
		if (this.config.bearerToken) headers.authorization = "Bearer " + this.config.bearerToken
		else if (this.config.basicPassword) {
			const raw = (this.config.basicUser ?? "opencode") + ":" + this.config.basicPassword
			headers.authorization = "Basic " + Buffer.from(raw, "utf8").toString("base64")
		}
		return headers
	}

	async request(
		method: string,
		path: string,
		options: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {},
	): Promise<RawResponse> {
		const url = new URL(this.config.baseUrl + path)
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined && value !== "") url.searchParams.set(key, String(value))
		}
		const controller = new AbortController()
		const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetch(url, {
				method,
				headers: this.headers(),
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal,
			})
			const text = await response.text()
			let data: unknown = null
			if (text !== "") {
				try {
					data = JSON.parse(text)
				} catch {
					data = text
				}
			}
			return { status: response.status, ok: response.ok, data, text }
		} catch (error) {
			const err = error as Error
			if (err.name === "AbortError") {
				throw new OpencodeError(method + " " + path + " timed out after " + timeoutMs + "ms", 0)
			}
			throw new OpencodeError(method + " " + path + " failed: " + err.message, 0)
		} finally {
			clearTimeout(timer)
		}
	}

	private async requireOk(method: string, path: string, options: Parameters<OpencodeClient["request"]>[2] = {}): Promise<unknown> {
		const response = await this.request(method, path, options)
		if (!response.ok) {
			throw new OpencodeError(method + " " + path + " returned HTTP " + response.status, response.status, response.text)
		}
		return response.data
	}

	/**
	 * True when the last probe found no pty but the server may simply have been
	 * mid-boot. The pty route is the only shell that needs no model, so being
	 * wrong about it once must not pin the process to the fallbacks for the life
	 * of the box.
	 */
	private shouldRecheckPty(): boolean {
		if (!this.caps || this.caps.ptyApi || this.ptyRefused) return false
		if (this.config.shellBackend !== "auto" && this.config.shellBackend !== "pty") return false
		return Date.now() - this.capsAt >= OpencodeClient.PTY_RECHECK_MS
	}

	async capabilities(force = false): Promise<Capabilities> {
		if (this.caps && !force && !this.shouldRecheckPty()) return this.caps
		const caps: Capabilities = {
			baseUrl: this.config.baseUrl,
			reachable: false,
			shellApi: "legacy",
			ptyApi: false,
			promptAsync: this.promptAsyncSupported,
			sessionStatusEndpoint: false,
			vcsBase: null,
			detectedAt: new Date().toISOString(),
		}
		try {
			const shell = await this.request("GET", "/api/shell", { timeoutMs: 5_000 })
			caps.reachable = true
			// A 200 alone is not enough: several builds serve the web UI for unknown
			// paths, so the v2 shell API only counts when the body really is JSON.
			if (shell.status !== 404 && shell.status !== 501 && isJsonPayload(shell)) caps.shellApi = "v2"
		} catch (error) {
			caps.error = (error as Error).message
		}
		// The pty route is the only shell that never goes through a model, so it
		// wins whenever the build has one and a WebSocket exists to read it.
		if (socketConstructor()) {
			try {
				const pty = await this.request("GET", "/api/pty", { timeoutMs: 5_000 })
				if (pty.ok && isJsonPayload(pty) && Array.isArray(asRecord(pty.data)?.data)) {
					caps.reachable = true
					caps.ptyApi = true
					if (this.config.shellBackend === "auto" || this.config.shellBackend === "pty") caps.shellApi = "pty"
				}
			} catch {
				// leave ptyApi false and keep whatever the /api/shell probe decided
			}
		}
		if (this.config.shellBackend === "legacy") caps.shellApi = "legacy"
		if (!caps.reachable) {
			try {
				const session = await this.request("GET", "/session", { timeoutMs: 5_000 })
				caps.reachable = session.status < 500
				if (caps.reachable) caps.error = undefined
			} catch (error) {
				caps.error = (error as Error).message
			}
		}
		if (caps.reachable) {
			try {
				const status = await this.request("GET", "/session/status", { timeoutMs: 5_000 })
				caps.sessionStatusEndpoint = status.ok
				this.sessionStatusSupported = status.ok
			} catch {
				caps.sessionStatusEndpoint = false
			}
			for (const base of ["/api/vcs", "/vcs"]) {
				try {
					const vcs = await this.request("GET", base + "/status", { timeoutMs: 5_000 })
					if (vcs.status !== 404) {
						caps.vcsBase = base
						break
					}
				} catch {
					// keep probing
				}
			}
		}
		caps.promptAsync = this.promptAsyncSupported
		this.caps = caps
		this.capsAt = Date.now()
		return caps
	}

	// ---------------------------------------------------------------- sessions

	async createSession(input: { directory?: string; title?: string } = {}): Promise<string> {
		const body: Record<string, unknown> = {}
		if (input.title) body.title = input.title
		const response = await this.request("POST", "/session", {
			body,
			query: { directory: input.directory ?? this.config.defaultDirectory },
		})
		if (!response.ok) throw new OpencodeError("failed to create session (HTTP " + response.status + ")", response.status, response.text)
		const record = asRecord(response.data)
		const id = firstString(record, ["id", "sessionID", "sessionId"]) ?? firstString(asRecord(record?.info), ["id"])
		if (!id) throw new OpencodeError("session id missing in response", response.status, response.text)
		return id
	}

	async listSessions(limit = 20): Promise<Array<Record<string, unknown>>> {
		const data = await this.requireOk("GET", "/session")
		return toArray(data, ["sessions", "items", "data"])
			.slice(0, limit)
			.map((entry) => {
				const record = asRecord(entry) ?? {}
				const info = asRecord(record.info) ?? record
				return {
					id: firstString(info, ["id", "sessionID"]) ?? null,
					title: firstString(info, ["title"]) ?? null,
					directory: firstString(info, ["directory", "cwd"]) ?? null,
					status: firstString(info, ["status"]) ?? null,
				}
			})
	}

	async prompt(
		sessionId: string,
		input: { prompt: string; model?: string; agent?: string; directory?: string },
	): Promise<"async" | "background"> {
		const body: Record<string, unknown> = { parts: [{ type: "text", text: input.prompt }] }
		const agent = input.agent ?? this.config.defaultAgent
		if (agent) body.agent = agent
		const model = input.model ?? this.config.defaultModel
		if (model) {
			const slash = model.indexOf("/")
			body.model = slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : model
		}
		const query = { directory: input.directory ?? this.config.defaultDirectory }
		const encoded = encodeURIComponent(sessionId)
		if (this.promptAsyncSupported) {
			const response = await this.request("POST", "/session/" + encoded + "/prompt_async", { body, query })
			if (response.ok) return "async"
			if (response.status !== 404 && response.status !== 405) {
				throw new OpencodeError("prompt_async failed (HTTP " + response.status + ")", response.status, response.text)
			}
			this.promptAsyncSupported = false
			if (this.caps) this.caps.promptAsync = false
		}
		// Legacy servers only expose the blocking endpoint: start it and never await it,
		// otherwise the MCP client would time out at 60s.
		void this.request("POST", "/session/" + encoded + "/message", {
			body,
			query,
			timeoutMs: this.config.backgroundTimeoutMs,
		}).catch(() => undefined)
		return "background"
	}

	async sessionStatus(sessionId: string): Promise<{ status: string; source: string }> {
		if (this.sessionStatusSupported) {
			const response = await this.request("GET", "/session/status")
			if (response.ok) {
				const status = extractSessionStatus(response.data, sessionId)
				if (status) return { status, source: "/session/status" }
				return { status: "idle", source: "/session/status" }
			}
			if (response.status === 404) this.sessionStatusSupported = false
		}
		const response = await this.request("GET", "/session/" + encodeURIComponent(sessionId))
		if (response.ok) {
			const record = asRecord(response.data)
			const info = asRecord(record?.info) ?? record
			const status = firstString(info, ["status", "state"])
			if (status) return { status, source: "/session/{id}" }
			const busy = info?.busy
			if (typeof busy === "boolean") return { status: busy ? "busy" : "idle", source: "/session/{id}" }
		}
		return { status: "unknown", source: "none" }
	}

	async messages(
		sessionId: string,
		options: { cursor?: number; limit?: number } = {},
	): Promise<{ messages: NormalizedMessage[]; nextCursor: number; total: number }> {
		const data = await this.requireOk("GET", "/session/" + encodeURIComponent(sessionId) + "/message")
		const all = toArray(data).map((entry, index) => normalizeMessage(entry, index))
		const cursor = Math.max(0, Math.min(options.cursor ?? 0, all.length))
		const limit = options.limit && options.limit > 0 ? options.limit : all.length - cursor
		const slice = all.slice(cursor, cursor + limit)
		return { messages: slice, nextCursor: cursor + slice.length, total: all.length }
	}

	async abort(sessionId: string): Promise<boolean> {
		const response = await this.request("POST", "/session/" + encodeURIComponent(sessionId) + "/abort", { body: {} })
		if (!response.ok && response.status !== 404) {
			throw new OpencodeError("abort failed (HTTP " + response.status + ")", response.status, response.text)
		}
		return response.ok
	}

	// ------------------------------------------------------------------- shell

	private async ensureShellSession(directory?: string): Promise<string> {
		if (this.shellSessionId) return this.shellSessionId
		this.shellSessionId = await this.createSession({ directory, title: "opencode-mcp-bridge shell" })
		return this.shellSessionId
	}

	async shellStart(input: {
		command: string
		directory?: string
		timeoutSeconds?: number
		agent?: string
		model?: string
	}): Promise<{ id: string; api: "v2" | "legacy" | "pty"; status: string }> {
		const caps = await this.capabilities()
		const directory = input.directory ?? this.config.defaultDirectory
		const timeout = input.timeoutSeconds ?? this.config.shellDefaultTimeoutSeconds
		if (caps.shellApi === "pty") {
			try {
				return await this.shellStartPty({ command: input.command, directory, timeoutSeconds: timeout })
			} catch {
				// A build that advertises /api/pty but will not start one is not worth
				// retrying on every call: remember that and use the older routes.
				this.ptyRefused = true
				if (this.caps) this.caps.shellApi = "legacy"
			}
		}
		if (caps.shellApi === "v2") {
			const response = await this.request("POST", "/api/shell", {
				body: { command: input.command, timeout, cwd: directory },
				query: { directory },
			})
			if (response.ok && isJsonPayload(response)) {
				const record = asRecord(response.data)
				const id = firstString(record, ["id", "shellID", "shellId"]) ?? firstString(asRecord(record?.shell), ["id"])
				if (id) return { id, api: "v2", status: firstString(record, ["status"]) ?? "running" }
			}
			if (!response.ok && response.status !== 404 && response.status !== 501) {
				throw new OpencodeError("POST /api/shell failed (HTTP " + response.status + ")", response.status, response.text)
			}
			// Reachable, but the answer was not a shell job (404, 501, or the web UI):
			// remember that this build has no usable v2 shell API and use the legacy route.
			if (this.caps) this.caps.shellApi = "legacy"
		}
		return this.shellStartLegacy({ ...input, directory, timeoutSeconds: timeout })
	}

	private async shellStartLegacy(input: {
		command: string
		directory?: string
		timeoutSeconds: number
		agent?: string
		model?: string
	}): Promise<{ id: string; api: "legacy"; status: string }> {
		const sessionId = await this.ensureShellSession(input.directory)
		const job: LocalJob = {
			id: "local-" + randomUUID().slice(0, 8),
			command: input.command,
			sessionId,
			status: "running",
			output: "",
			exitCode: null,
			startedAt: Date.now(),
		}
		this.jobs.set(job.id, job)
		const body: Record<string, unknown> = { agent: input.agent ?? this.config.defaultAgent ?? "build", command: input.command }
		if (input.model ?? this.config.defaultModel) body.model = input.model ?? this.config.defaultModel
		void this.request("POST", "/session/" + encodeURIComponent(sessionId) + "/shell", {
			body,
			query: { directory: input.directory },
			timeoutMs: Math.max(input.timeoutSeconds, 1) * 1_000,
		})
			.then((response) => {
				if (job.status === "killed") return
				if (response.ok) {
					job.output += extractShellText(response.data)
					job.status = "completed"
					job.exitCode = 0
				} else {
					job.status = "failed"
					job.error = "HTTP " + response.status
					job.output += response.text.slice(0, this.config.maxOutputChars)
				}
			})
			.catch((error: unknown) => {
				if (job.status === "killed") return
				job.status = "failed"
				job.error = (error as Error).message
			})
			.finally(() => {
				job.finishedAt = Date.now()
			})
		return { id: job.id, api: "legacy", status: "running" }
	}

	// --------------------------------------------------------------- pty shell

	private ptySocketUrl(ptyId: string): string {
		const url = new URL(this.config.baseUrl + "/api/pty/" + encodeURIComponent(ptyId) + "/connect")
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
		return url.toString()
	}

	/** Attach to the terminal stream. opencode replays its scrollback on connect. */
	private attachPtySocket(job: PtyJob): void {
		const Socket = socketConstructor()
		if (!Socket) {
			job.error = "this Node build has no global WebSocket, so pty output cannot be read"
			return
		}
		const url = this.ptySocketUrl(job.id)
		let socket: MinimalSocket
		try {
			// Undici takes headers as a non-standard option; builds that do not are
			// fine as long as the opencode server needs no credentials.
			socket = new Socket(url, { headers: this.headers() })
		} catch {
			socket = new Socket(url)
		}
		socket.binaryType = "arraybuffer"
		job.socket = socket
		socket.onmessage = (event) => {
			// Text frames carry terminal output. Binary frames are control messages:
			// a NUL byte followed by JSON such as {"cursor":9}.
			if (typeof event.data === "string") this.appendPtyOutput(job, event.data)
		}
		socket.onerror = () => {
			if (job.status === "running" && !job.error) job.error = "pty websocket error"
		}
		socket.onclose = () => {
			job.socket = null
			void this.refreshPty(job).catch(() => undefined)
		}
	}

	private appendPtyOutput(job: PtyJob, chunk: string): void {
		const cleaned = stripTerminalNoise(chunk)
		if (cleaned === "") return
		const room = this.config.ptyBufferChars - job.output.length
		if (room <= 0) {
			job.truncated = true
			return
		}
		job.output += cleaned.length > room ? cleaned.slice(0, room) : cleaned
		if (cleaned.length > room) job.truncated = true
	}

	/** Ask opencode whether the terminal is still alive and pick up its exit code. */
	private async refreshPty(job: PtyJob): Promise<PtyJob> {
		if (job.status !== "running") return job
		const response = await this.request("GET", "/api/pty/" + encodeURIComponent(job.id))
		if (response.status === 404) {
			job.status = job.killRequested ? "killed" : "completed"
			job.finishedAt = job.finishedAt ?? Date.now()
			if (job.timeoutTimer) clearTimeout(job.timeoutTimer)
			return job
		}
		const data = asRecord(asRecord(response.data)?.data)
		const exitCode = firstNumber(data, ["exitCode", "exit", "code"])
		if (exitCode !== undefined) job.exitCode = exitCode
		const status = firstString(data, ["status", "state"])
		if (status !== undefined && status !== "running" && status !== "starting") {
			job.status = job.killRequested ? "killed" : (job.exitCode ?? 0) === 0 ? "completed" : "failed"
			job.finishedAt = job.finishedAt ?? Date.now()
			if (job.timeoutTimer) clearTimeout(job.timeoutTimer)
		}
		return job
	}

	private armPtyTimeout(job: PtyJob, timeoutSeconds: number): NodeJS.Timeout {
		const timer = setTimeout(() => {
			if (job.status !== "running") return
			job.error = "timed out after " + timeoutSeconds + "s"
			void this.shellKill(job.id).catch(() => undefined)
		}, Math.max(timeoutSeconds, 1) * 1_000)
		timer.unref()
		return timer
	}

	private async shellStartPty(input: { command: string; directory?: string; timeoutSeconds: number }): Promise<{
		id: string
		api: "pty"
		status: string
	}> {
		const directory = input.directory ?? this.config.defaultDirectory
		const response = await this.request("POST", "/api/pty", {
			body: {
				command: this.config.ptyShell,
				args: ["-c", input.command],
				cwd: directory,
				title: "opencode-mcp-bridge",
				// A dumb terminal keeps colour codes and cursor games out of output
				// that an MCP client has to read as plain text.
				env: { TERM: "dumb" },
			},
			query: directory ? { directory } : undefined,
		})
		if (!response.ok || !isJsonPayload(response)) {
			throw new OpencodeError("POST /api/pty failed (HTTP " + response.status + ")", response.status, response.text)
		}
		const id = firstString(asRecord(asRecord(response.data)?.data), ["id"])
		if (!id) throw new OpencodeError("pty id missing in /api/pty response", response.status, response.text)
		const job: PtyJob = {
			id,
			command: input.command,
			status: "running",
			output: "",
			exitCode: null,
			startedAt: Date.now(),
			truncated: false,
			killRequested: false,
			socket: null,
		}
		this.ptys.set(id, job)
		this.attachPtySocket(job)
		job.timeoutTimer = this.armPtyTimeout(job, input.timeoutSeconds)
		return { id, api: "pty", status: "running" }
	}

	private ptyRecord(job: PtyJob): Record<string, unknown> {
		return {
			id: job.id,
			api: "pty",
			command: job.command,
			status: job.status,
			exitCode: job.exitCode,
			running: job.status === "running",
			startedAt: new Date(job.startedAt).toISOString(),
			finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
			error: job.error ?? null,
			bufferedChars: job.output.length,
			truncated: job.truncated,
			streaming: job.socket !== null,
		}
	}

	async shellStatus(id: string): Promise<Record<string, unknown>> {
		const pty = this.ptys.get(id)
		if (pty) return this.ptyRecord(await this.refreshPty(pty))
		const job = this.jobs.get(id)
		if (job) {
			return {
				id: job.id,
				api: "legacy",
				command: job.command,
				status: job.status,
				exitCode: job.exitCode,
				running: job.status === "running",
				startedAt: new Date(job.startedAt).toISOString(),
				finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
				error: job.error ?? null,
			}
		}
		const data = await this.requireOk("GET", "/api/shell/" + encodeURIComponent(id))
		const record = asRecord(data) ?? {}
		const exitCode = firstNumber(record, ["exitCode", "exit", "code"])
		const status =
			firstString(record, ["status", "state"]) ??
			(record.running === true ? "running" : exitCode === undefined ? "running" : "completed")
		return {
			id: firstString(record, ["id"]) ?? id,
			api: "v2",
			command: firstString(record, ["command"]) ?? null,
			status,
			exitCode: exitCode ?? null,
			running: status === "running",
			raw: record,
		}
	}

	async shellOutput(id: string, cursor = 0): Promise<{ chunk: string; nextCursor: number; status: string; exitCode: number | null; truncated: boolean }> {
		const pty = this.ptys.get(id)
		if (pty) {
			await this.refreshPty(pty)
			const pending = pty.output.slice(cursor)
			const chunk = pending.slice(0, this.config.maxOutputChars)
			return {
				chunk,
				nextCursor: cursor + chunk.length,
				status: pty.status,
				exitCode: pty.exitCode,
				truncated: pty.truncated || chunk.length < pending.length,
			}
		}
		const job = this.jobs.get(id)
		if (job) {
			const chunk = job.output.slice(cursor)
			const capped = chunk.slice(0, this.config.maxOutputChars)
			return {
				chunk: capped,
				nextCursor: cursor + capped.length,
				status: job.status,
				exitCode: job.exitCode,
				truncated: capped.length < chunk.length,
			}
		}
		const response = await this.request("GET", "/api/shell/" + encodeURIComponent(id) + "/output", { query: { cursor } })
		if (!response.ok) {
			throw new OpencodeError("shell output failed (HTTP " + response.status + ")", response.status, response.text)
		}
		const record = asRecord(response.data)
		const exitCode = firstNumber(record, ["exitCode", "exit", "code"]) ?? null
		const status =
			firstString(record, ["status", "state"]) ??
			(record?.running === true ? "running" : exitCode === null ? "running" : "completed")
		// Some builds return an incremental chunk plus a cursor, others the whole buffer.
		const incremental = firstString(record, ["chunk", "delta"])
		const serverCursor = firstNumber(record, ["nextCursor", "cursor", "offset"])
		if (incremental !== undefined && serverCursor !== undefined) {
			const capped = incremental.slice(0, this.config.maxOutputChars)
			return { chunk: capped, nextCursor: serverCursor, status, exitCode, truncated: capped.length < incremental.length }
		}
		const full = extractShellText(response.data)
		const chunk = full.slice(cursor)
		const capped = chunk.slice(0, this.config.maxOutputChars)
		return { chunk: capped, nextCursor: cursor + capped.length, status, exitCode, truncated: capped.length < chunk.length }
	}

	async shellExtend(id: string, timeoutSeconds: number): Promise<Record<string, unknown>> {
		const pty = this.ptys.get(id)
		if (pty) {
			if (pty.status !== "running") throw new OpencodeError("pty " + id + " is no longer running", 400)
			// A pty has no server side deadline: the only clock is the bridge's own
			// timer, so extending means rearming it.
			if (pty.timeoutTimer) clearTimeout(pty.timeoutTimer)
			pty.timeoutTimer = this.armPtyTimeout(pty, timeoutSeconds)
			return { id, api: "pty", status: pty.status, timeoutSeconds }
		}
		if (this.jobs.has(id)) {
			throw new OpencodeError("legacy shell jobs cannot be extended; the request timeout was fixed at start time", 400)
		}
		const data = await this.requireOk("PATCH", "/api/shell/" + encodeURIComponent(id) + "/timeout", {
			body: { timeout: timeoutSeconds, timeoutSeconds },
		})
		return asRecord(data) ?? { ok: true }
	}

	async shellKill(id: string): Promise<Record<string, unknown>> {
		const pty = this.ptys.get(id)
		if (pty) {
			pty.killRequested = true
			if (pty.timeoutTimer) clearTimeout(pty.timeoutTimer)
			const response = await this.request("DELETE", "/api/pty/" + encodeURIComponent(id))
			if (!response.ok && response.status !== 404) {
				throw new OpencodeError("pty kill failed (HTTP " + response.status + ")", response.status, response.text)
			}
			if (pty.status === "running") {
				pty.status = "killed"
				pty.finishedAt = Date.now()
			}
			try {
				pty.socket?.close()
			} catch {
				// the stream is already gone, which is what we wanted
			}
			pty.socket = null
			return { id, api: "pty", status: pty.status, exitCode: pty.exitCode }
		}
		const job = this.jobs.get(id)
		if (job) {
			job.status = "killed"
			job.finishedAt = Date.now()
			await this.abort(job.sessionId).catch(() => undefined)
			return { id, status: "killed", api: "legacy" }
		}
		const response = await this.request("DELETE", "/api/shell/" + encodeURIComponent(id))
		if (!response.ok && response.status !== 404) {
			throw new OpencodeError("shell kill failed (HTTP " + response.status + ")", response.status, response.text)
		}
		return { id, status: "killed", api: "v2", httpStatus: response.status }
	}

	async shellList(): Promise<Array<Record<string, unknown>>> {
		const local = [...this.jobs.values()].map((job) => ({
			id: job.id,
			api: "legacy",
			command: job.command,
			status: job.status,
		}))
		const caps = await this.capabilities()
		const tracked = [...this.ptys.values()].map((job) => ({
			id: job.id,
			api: "pty",
			command: job.command,
			status: job.status,
			exitCode: job.exitCode,
		}))
		if (caps.ptyApi) {
			const response = await this.request("GET", "/api/pty")
			if (!response.ok || !isJsonPayload(response)) return [...tracked, ...local]
			const remote = toArray(asRecord(response.data)?.data, ["data"]).map((entry) => {
				const record = asRecord(entry) ?? {}
				const id = firstString(record, ["id"])
				const known = id ? this.ptys.get(id) : undefined
				return {
					id: id ?? null,
					api: "pty",
					command: known?.command ?? firstString(record, ["command"]) ?? null,
					status: known?.status ?? firstString(record, ["status", "state"]) ?? null,
					exitCode: known?.exitCode ?? firstNumber(record, ["exitCode"]) ?? null,
				}
			})
			return [...remote, ...local]
		}
		if (caps.shellApi !== "v2") return [...tracked, ...local]
		const response = await this.request("GET", "/api/shell")
		if (!response.ok) return local
		const remote = toArray(response.data, ["shells", "items", "data"]).map((entry) => {
			const record = asRecord(entry) ?? {}
			return {
				id: firstString(record, ["id"]) ?? null,
				api: "v2",
				command: firstString(record, ["command"]) ?? null,
				status: firstString(record, ["status", "state"]) ?? null,
			}
		})
		return [...remote, ...local]
	}

	// ------------------------------------------------------------ files & find

	async readFile(path: string, offset = 0, limit = 0): Promise<{ path: string; content: string; totalLines: number; truncated: boolean }> {
		let response = await this.request("GET", "/file/content", { query: { path } })
		if (response.status === 404) response = await this.request("GET", "/file", { query: { path } })
		if (!response.ok) throw new OpencodeError("read failed (HTTP " + response.status + ")", response.status, response.text)
		const record = asRecord(response.data)
		const content = typeof response.data === "string" ? response.data : firstString(record, ["content", "text", "data"]) ?? ""
		const lines = content.split("\n")
		const start = Math.max(0, offset)
		const sliced = (limit > 0 ? lines.slice(start, start + limit) : lines.slice(start)).join("\n")
		const capped = sliced.slice(0, this.config.maxOutputChars)
		return { path, content: capped, totalLines: lines.length, truncated: capped.length < sliced.length }
	}

	async grep(pattern: string, limit = 50): Promise<unknown[]> {
		const data = await this.requireOk("GET", "/find", { query: { pattern } })
		return toArray(data, ["matches", "results", "items"]).slice(0, limit)
	}

	async findFile(query: string, limit = 50): Promise<unknown[]> {
		const data = await this.requireOk("GET", "/find/file", { query: { query } })
		return toArray(data, ["files", "results", "items"]).slice(0, limit)
	}

	async diff(directory?: string): Promise<string> {
		const caps = await this.capabilities()
		const bases = caps.vcsBase ? [caps.vcsBase] : ["/api/vcs", "/vcs"]
		let lastStatus = 0
		for (const base of bases) {
			const response = await this.request("GET", base + "/diff", { query: { directory: directory ?? this.config.defaultDirectory } })
			if (response.ok) {
				const text = typeof response.data === "string" ? response.data : extractShellText(response.data) || response.text
				return text.slice(0, this.config.maxOutputChars)
			}
			lastStatus = response.status
		}
		throw new OpencodeError("vcs diff unavailable (HTTP " + lastStatus + ")", lastStatus)
	}

	// ------------------------------------------------------------- permissions

	async pendingPermissions(): Promise<Array<Record<string, unknown>>> {
		const response = await this.request("GET", "/permission")
		if (!response.ok) {
			if (response.status === 404) return []
			throw new OpencodeError("GET /permission failed (HTTP " + response.status + ")", response.status, response.text)
		}
		return toArray(response.data, ["permissions", "items", "pending"]).map((entry) => {
			const record = asRecord(entry) ?? {}
			return {
				id: firstString(record, ["id", "requestID", "requestId"]) ?? null,
				sessionID: firstString(record, ["sessionID", "sessionId"]) ?? null,
				tool: firstString(record, ["tool", "type", "action"]) ?? null,
				title: firstString(record, ["title", "pattern", "description"]) ?? null,
				metadata: record.metadata ?? null,
			}
		})
	}

	async replyPermission(requestId: string, reply: "once" | "always" | "reject", sessionId?: string): Promise<Record<string, unknown>> {
		const response = await this.request("POST", "/permission/" + encodeURIComponent(requestId) + "/reply", { body: { reply, response: reply } })
		if (response.ok) return { requestId, reply, endpoint: "/permission/{id}/reply" }
		if (response.status === 404 && sessionId) {
			const legacy = await this.request(
				"POST",
				"/session/" + encodeURIComponent(sessionId) + "/permissions/" + encodeURIComponent(requestId),
				{ body: { response: reply } },
			)
			if (legacy.ok) return { requestId, reply, endpoint: "/session/{id}/permissions/{id}" }
			throw new OpencodeError("permission reply failed (HTTP " + legacy.status + ")", legacy.status, legacy.text)
		}
		throw new OpencodeError("permission reply failed (HTTP " + response.status + ")", response.status, response.text)
	}

	async questions(): Promise<unknown[]> {
		const response = await this.request("GET", "/question")
		if (!response.ok) return []
		return toArray(response.data, ["questions", "items"])
	}

	async replyQuestion(requestId: string, answer: string): Promise<Record<string, unknown>> {
		const response = await this.request("POST", "/question/" + encodeURIComponent(requestId) + "/reply", {
			body: { reply: answer, answer, response: answer },
		})
		if (!response.ok) throw new OpencodeError("question reply failed (HTTP " + response.status + ")", response.status, response.text)
		return { requestId, answer }
	}
}
