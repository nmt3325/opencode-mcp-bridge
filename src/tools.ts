import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { checkCommand, type BridgeConfig } from "./config.js"
import { OpencodeError, type OpencodeClient } from "./opencodeClient.js"

/**
 * Never let a tool call approach the 60s ceiling that MCP clients (Notion,
 * Claude Desktop, ChatGPT ...) enforce. Everything long running is turned into
 * a job id plus polling.
 */
export const HARD_CAP_MS = 55_000

export interface ToolResult {
	[key: string]: unknown
	content: Array<{ type: "text"; text: string }>
	isError?: boolean
}

function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

function fail(error: unknown, extra: Record<string, unknown> = {}): ToolResult {
	const message = error instanceof Error ? error.message : String(error)
	const payload: Record<string, unknown> = { ok: false, error: message, ...extra }
	if (error instanceof OpencodeError) {
		payload.http_status = error.status
		if (error.body) payload.upstream_body = error.body.slice(0, 500)
	}
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true }
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

async function withCap<T>(work: Promise<T>, ms = HARD_CAP_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("bridge hard timeout after " + ms + "ms; the job keeps running, poll again")), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function handler(fn: (args: any) => Promise<ToolResult>): (args: any) => Promise<ToolResult> {
	return async (args: any) => {
		try {
			return await withCap(fn(args))
		} catch (error) {
			return fail(error)
		}
	}
}

const BUSY = new Set(["busy", "running", "working", "active", "streaming"])

export function registerTools(server: McpServer, client: OpencodeClient, config: BridgeConfig): void {
	const graceMs = Number(process.env.OPENCODE_MCP_WAIT_GRACE_MS ?? 2_500)

	server.registerTool(
		"opencode_health",
		{
			title: "Check the opencode server",
			description: "Ping the configured opencode server and report which API flavour the bridge detected (pty, v2 /api/shell or legacy shell route, prompt_async support, VCS base path).",
			inputSchema: { refresh: z.boolean().optional().describe("Re-probe instead of using the cached capability snapshot.") },
		},
		handler(async (args) => ok({ ok: true, capabilities: await client.capabilities(args?.refresh === true) })),
	)

	server.registerTool(
		"opencode_sessions",
		{
			title: "List opencode sessions",
			description: "List existing opencode sessions so a follow-up prompt can reuse one instead of starting from scratch.",
			inputSchema: { limit: z.number().int().positive().max(100).optional() },
		},
		handler(async (args) => ok({ ok: true, sessions: await client.listSessions(args?.limit ?? 20) })),
	)

	server.registerTool(
		"opencode_start",
		{
			title: "Start an opencode task (non blocking)",
			description:
				"Send a prompt to opencode and return immediately with a session_id. The model keeps working in the background; call opencode_wait to follow it. Never blocks, so it is safe under a 60s MCP timeout.",
			inputSchema: {
				prompt: z.string().min(1).describe("Instruction for the opencode agent."),
				session_id: z.string().optional().describe("Continue an existing session instead of creating one."),
				directory: z.string().optional().describe("Project directory opencode should work in."),
				agent: z.string().optional().describe("Agent name, e.g. build, plan, general."),
				model: z.string().optional().describe("provider/model, e.g. anthropic/claude-sonnet-4-5."),
				title: z.string().optional().describe("Title for a newly created session."),
			},
		},
		handler(async (args) => {
			const sessionId: string =
				args.session_id ?? (await client.createSession({ directory: args.directory, title: args.title ?? "mcp: " + String(args.prompt).slice(0, 60) }))
			const mode = await client.prompt(sessionId, {
				prompt: args.prompt,
				model: args.model,
				agent: args.agent,
				directory: args.directory,
			})
			return ok({
				ok: true,
				session_id: sessionId,
				dispatch: mode,
				status: "running",
				next_action: 'call opencode_wait with session_id="' + sessionId + '" (timeout_seconds<=' + config.waitMaxSeconds + ")",
			})
		}),
	)

	server.registerTool(
		"opencode_wait",
		{
			title: "Wait for an opencode task (self terminating long poll)",
			description:
				"Poll a session until it goes idle or the timeout elapses, then return new messages plus a cursor. Always returns before the MCP client timeout; if status is still running just call it again with the returned cursor.",
			inputSchema: {
				session_id: z.string(),
				timeout_seconds: z.number().int().positive().optional().describe("Clamped to OPENCODE_MCP_WAIT_MAX_SECONDS (default 45)."),
				cursor: z.number().int().min(0).optional().describe("Message cursor returned by a previous call."),
			},
		},
		handler(async (args) => {
			const timeoutSeconds = clamp(args.timeout_seconds ?? config.waitMaxSeconds, 1, config.waitMaxSeconds)
			const started = Date.now()
			const deadline = started + timeoutSeconds * 1_000
			let status = "unknown"
			let finished = false
			while (Date.now() < deadline) {
				status = (await client.sessionStatus(args.session_id)).status
				if (!BUSY.has(status) && Date.now() - started >= graceMs) {
					finished = true
					break
				}
				await sleep(Math.min(config.pollIntervalMs, Math.max(deadline - Date.now(), 50)))
			}
			const cursor = args.cursor ?? 0
			const page = await client.messages(args.session_id, { cursor })
			const pending = await client.pendingPermissions().catch(() => [])
			let budget = config.maxOutputChars
			const messages = page.messages.map((message) => {
				const text = message.text.slice(0, Math.max(budget, 0))
				budget -= text.length
				return { ...message, text, truncated: text.length < message.text.length }
			})
			return ok({
				ok: true,
				session_id: args.session_id,
				status: finished ? "idle" : status,
				finished,
				waited_seconds: Math.round((Date.now() - started) / 100) / 10,
				cursor: page.nextCursor,
				total_messages: page.total,
				messages,
				pending_permissions: pending,
				next_action: finished
					? "done; use opencode_result for the full transcript"
					: pending.length > 0
						? "agent is waiting for approval: call opencode_permission_reply"
						: "still running: call opencode_wait again with cursor=" + page.nextCursor,
			})
		}),
	)

	server.registerTool(
		"opencode_result",
		{
			title: "Read messages of a session",
			description: "Return session messages from a cursor, paginated so a large transcript never blows up a single MCP response.",
			inputSchema: {
				session_id: z.string(),
				cursor: z.number().int().min(0).optional(),
				limit: z.number().int().positive().max(100).optional(),
			},
		},
		handler(async (args) => {
			const page = await client.messages(args.session_id, { cursor: args.cursor ?? 0, limit: args.limit ?? 0 })
			let budget = config.maxOutputChars
			const messages = page.messages.map((message) => {
				const text = message.text.slice(0, Math.max(budget, 0))
				budget -= text.length
				return { ...message, text, truncated: text.length < message.text.length }
			})
			return ok({
				ok: true,
				session_id: args.session_id,
				cursor: page.nextCursor,
				total_messages: page.total,
				has_more: page.nextCursor < page.total,
				messages,
			})
		}),
	)

	server.registerTool(
		"opencode_abort",
		{
			title: "Abort a session",
			description: "Stop whatever the agent is currently doing in that session. Idempotent.",
			inputSchema: { session_id: z.string() },
		},
		handler(async (args) => ok({ ok: true, aborted: await client.abort(args.session_id), session_id: args.session_id })),
	)

	// ---------------------------------------------------------------- shell

	server.registerTool(
		"opencode_shell",
		{
			title: "Run a shell command (async job)",
			description:
				"Run a shell command in a real terminal through opencode's pty API, with no model in the loop. Older builds fall back to the v2 shell API and then to the agent driven legacy route. Returns a shell_id immediately and, if the command finishes quickly, its first output chunk. Guarded by the bridge deny/allow patterns.",
			inputSchema: {
				command: z.string().min(1),
				directory: z.string().optional(),
				timeout_seconds: z.number().int().positive().max(86_400).optional().describe("Server side command timeout (default 120s)."),
				wait_seconds: z.number().int().min(0).max(50).optional().describe("How long to wait inline for fast commands (default 5s)."),
			},
		},
		handler(async (args) => {
			const guard = checkCommand(args.command, config)
			if (!guard.allowed) {
				return fail("command rejected by the bridge guard: " + guard.reason, { command: args.command, matched_pattern: guard.matched ?? null })
			}
			const started = await client.shellStart({
				command: args.command,
				directory: args.directory,
				timeoutSeconds: args.timeout_seconds,
			})
			const waitMs = clamp(args.wait_seconds ?? 5, 0, 50) * 1_000
			const deadline = Date.now() + waitMs
			let cursor = 0
			let chunk = ""
			let status = started.status
			let exitCode: number | null = null
			while (Date.now() <= deadline) {
				const output = await client.shellOutput(started.id, cursor)
				chunk += output.chunk
				cursor = output.nextCursor
				status = output.status
				exitCode = output.exitCode
				if (status !== "running" && status !== "pending") break
				if (waitMs === 0) break
				await sleep(Math.min(500, Math.max(deadline - Date.now(), 50)))
			}
			const done = status !== "running" && status !== "pending"
			return ok({
				ok: true,
				shell_id: started.id,
				api: started.api,
				status,
				exit_code: exitCode,
				cursor,
				output: chunk,
				next_action: done ? "finished" : 'call opencode_shell_output with shell_id="' + started.id + '" and cursor=' + cursor,
			})
		}),
	)

	server.registerTool(
		"opencode_shell_output",
		{
			title: "Read incremental shell output",
			description: "Fetch output produced since the given cursor. Optionally waits a few seconds for new output so polling loops stay cheap.",
			inputSchema: {
				shell_id: z.string(),
				cursor: z.number().int().min(0).optional(),
				wait_seconds: z.number().int().min(0).max(50).optional(),
			},
		},
		handler(async (args) => {
			const waitMs = clamp(args.wait_seconds ?? 0, 0, 50) * 1_000
			const deadline = Date.now() + waitMs
			let cursor = args.cursor ?? 0
			let chunk = ""
			let result = await client.shellOutput(args.shell_id, cursor)
			chunk += result.chunk
			cursor = result.nextCursor
			while (waitMs > 0 && chunk === "" && (result.status === "running" || result.status === "pending") && Date.now() < deadline) {
				await sleep(Math.min(500, Math.max(deadline - Date.now(), 50)))
				result = await client.shellOutput(args.shell_id, cursor)
				chunk += result.chunk
				cursor = result.nextCursor
			}
			const running = result.status === "running" || result.status === "pending"
			return ok({
				ok: true,
				shell_id: args.shell_id,
				status: result.status,
				exit_code: result.exitCode,
				cursor,
				output: chunk,
				truncated: result.truncated,
				next_action: running ? "still running: poll again with cursor=" + cursor : "finished",
			})
		}),
	)

	server.registerTool(
		"opencode_shell_status",
		{
			title: "Inspect a shell job",
			description: "Return status metadata for one shell job without transferring its output.",
			inputSchema: { shell_id: z.string() },
		},
		handler(async (args) => ok({ ok: true, shell: await client.shellStatus(args.shell_id) })),
	)

	server.registerTool(
		"opencode_shell_list",
		{
			title: "List shell jobs",
			description: "List shell jobs known to the opencode server plus legacy jobs tracked inside the bridge.",
			inputSchema: {},
		},
		handler(async () => ok({ ok: true, shells: await client.shellList() })),
	)

	server.registerTool(
		"opencode_shell_extend",
		{
			title: "Extend a shell job timeout",
			description: "Give a long running command more time before the server kills it.",
			inputSchema: { shell_id: z.string(), timeout_seconds: z.number().int().positive().max(86_400) },
		},
		handler(async (args) => ok({ ok: true, result: await client.shellExtend(args.shell_id, args.timeout_seconds) })),
	)

	server.registerTool(
		"opencode_shell_kill",
		{
			title: "Kill a shell job",
			description: "Terminate a running shell job.",
			inputSchema: { shell_id: z.string() },
		},
		handler(async (args) => ok({ ok: true, result: await client.shellKill(args.shell_id) })),
	)

	// ------------------------------------------------------------ files / vcs

	server.registerTool(
		"opencode_read",
		{
			title: "Read a file",
			description: "Read a file through the opencode server, with line offset/limit so big files stay inside one MCP response.",
			inputSchema: {
				path: z.string(),
				offset: z.number().int().min(0).optional().describe("First line to return (0 based)."),
				limit: z.number().int().positive().optional().describe("Number of lines to return."),
			},
		},
		handler(async (args) => ok({ ok: true, ...(await client.readFile(args.path, args.offset ?? 0, args.limit ?? 0)) })),
	)

	server.registerTool(
		"opencode_grep",
		{
			title: "Search file contents",
			description: "ripgrep style content search through the opencode server.",
			inputSchema: { pattern: z.string().min(1), limit: z.number().int().positive().max(200).optional() },
		},
		handler(async (args) => ok({ ok: true, matches: await client.grep(args.pattern, args.limit ?? 50) })),
	)

	server.registerTool(
		"opencode_find_file",
		{
			title: "Find files by name",
			description: "Fuzzy file name search through the opencode server.",
			inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(200).optional() },
		},
		handler(async (args) => ok({ ok: true, files: await client.findFile(args.query, args.limit ?? 50) })),
	)

	server.registerTool(
		"opencode_diff",
		{
			title: "Show the working tree diff",
			description: "Return the VCS diff of the project so a chat client can review what the agent changed.",
			inputSchema: { directory: z.string().optional() },
		},
		handler(async (args) => ok({ ok: true, diff: await client.diff(args?.directory) })),
	)

	// ------------------------------------------------------------ permissions

	server.registerTool(
		"opencode_permissions_pending",
		{
			title: "List pending approvals",
			description: "List permission requests the agent is blocked on (bash commands, edits ...). Lets a chat client act as the approver.",
			inputSchema: {},
		},
		handler(async () => {
			const permissions = await client.pendingPermissions()
			return ok({
				ok: true,
				count: permissions.length,
				permissions,
				next_action: permissions.length === 0 ? "nothing to approve" : "reply with opencode_permission_reply",
			})
		}),
	)

	server.registerTool(
		"opencode_permission_reply",
		{
			title: "Approve or reject a permission request",
			description: 'Answer a pending permission request: "once" approves it a single time, "always" whitelists it for the session, "reject" denies it.',
			inputSchema: {
				request_id: z.string(),
				reply: z.enum(["once", "always", "reject"]),
				session_id: z.string().optional().describe("Only needed for old servers that scope permissions under a session."),
			},
		},
		handler(async (args) => ok({ ok: true, result: await client.replyPermission(args.request_id, args.reply, args.session_id) })),
	)

	server.registerTool(
		"opencode_questions_pending",
		{
			title: "List questions asked by the agent",
			description: "List questions raised by the opencode `question` tool, which would otherwise hang a headless run forever.",
			inputSchema: {},
		},
		handler(async () => {
			const questions = await client.questions()
			return ok({ ok: true, count: questions.length, questions })
		}),
	)

	server.registerTool(
		"opencode_question_reply",
		{
			title: "Answer a question from the agent",
			description: "Send an answer back to a pending `question` request so the agent can continue.",
			inputSchema: { request_id: z.string(), answer: z.string() },
		},
		handler(async (args) => ok({ ok: true, result: await client.replyQuestion(args.request_id, args.answer) })),
	)
}
