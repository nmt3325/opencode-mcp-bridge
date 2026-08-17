import type { Dirent } from "node:fs"
import { promises as fs } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { checkCommand, type BridgeConfig } from "./config.js"
import type { OpencodeClient } from "./opencodeClient.js"
import { clamp, fail, handler, ok, sleep } from "./result.js"

/**
 * Model facing tools, exposed over MCP.
 *
 * opencode hands a model a fixed set of tools and then executes whatever the
 * model asks for. `GET /experimental/tool/ids` lists them and
 * `GET /experimental/tool?provider=&model=` returns the exact JSON Schema each
 * one is advertised with. There is no HTTP route that *runs* one of them, so
 * the bridge mirrors the schemas verbatim and performs the work itself.
 *
 * The point: an MCP client that cannot do tool calling (Notion AI) becomes the
 * model. It sees the same tool names and arguments a real model would see, so
 * no provider credential is ever needed.
 */

/** Tools mirrored 1:1 from opencode's model tool list. */
export const MIRRORED_TOOL_IDS = ["bash", "read", "write", "edit", "glob", "grep", "webfetch", "todowrite"] as const

/** Tools opencode offers a model that deliberately have no MCP mirror, and why. */
export const UNMIRRORED_TOOLS: Record<string, string> = {
	task: "spawns a sub agent, which needs a model credential. The MCP client is the model here, so it runs the sub task itself.",
	skill: "only injects prompt text into a model context window, which means nothing without a model in the loop. Use opencode_skills to read them.",
	question: "asks the operator something. Here the MCP client is the operator, so it should just ask its user.",
	websearch: "needs a provider credential that opencode only has when a model is configured.",
	invalid: "opencode's placeholder for a malformed tool call.",
	apply_patch: "only advertised to some providers. edit and write cover the same ground deterministically.",
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", ".turbo", ".pytest_cache"])
const WALK_FILE_LIMIT = 20_000
const READ_DEFAULT_LIMIT = 2_000

/** Resolve a tool path the way opencode does: absolute wins, relative hangs off the project directory. */
function resolveTarget(config: BridgeConfig, input: string): string {
	const base = config.defaultDirectory ?? process.cwd()
	return isAbsolute(input) ? resolve(input) : resolve(base, input)
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false }
	return { text: text.slice(0, max), truncated: true }
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Minimal glob compiler: supports `**`, `*`, `?` and `{a,b}` against a POSIX style relative path. */
export function globToRegExp(pattern: string): RegExp {
	let out = ""
	let i = 0
	while (i < pattern.length) {
		const char = pattern[i]
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					out += "(?:[^/]+/)*"
					i += 3
					continue
				}
				out += ".*"
				i += 2
				continue
			}
			out += "[^/]*"
			i += 1
			continue
		}
		if (char === "?") {
			out += "[^/]"
			i += 1
			continue
		}
		if (char === "{") {
			const close = pattern.indexOf("}", i)
			if (close > i) {
				const options = pattern.slice(i + 1, close).split(",").map(escapeRegExp)
				out += "(?:" + options.join("|") + ")"
				i = close + 1
				continue
			}
		}
		out += escapeRegExp(char)
		i += 1
	}
	return new RegExp("^" + out + "$")
}

async function* walkFiles(root: string): AsyncGenerator<{ path: string; mtimeMs: number }> {
	const stack: string[] = [root]
	let seen = 0
	while (stack.length > 0) {
		const dir = stack.pop() as string
		let entries: Dirent[]
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) stack.push(full)
				continue
			}
			if (!entry.isFile()) continue
			seen += 1
			if (seen > WALK_FILE_LIMIT) return
			let mtimeMs = 0
			try {
				mtimeMs = (await fs.stat(full)).mtimeMs
			} catch {
				/* raced with a delete, skip the timestamp */
			}
			yield { path: full, mtimeMs }
		}
	}
}

function numberLines(lines: string[], startLine: number): string {
	return lines.map((line, index) => String(startLine + index).padStart(5, "0") + "| " + line).join("\n")
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0
	let count = 0
	let from = 0
	while (true) {
		const at = haystack.indexOf(needle, from)
		if (at === -1) return count
		count += 1
		from = at + needle.length
	}
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim()
}

interface TodoItem {
	content: string
	status: string
	priority: string
}

/** todowrite is a scratchpad in opencode too, so the bridge keeps it in memory. */
const todoState: { todos: TodoItem[] } = { todos: [] }

export function registerModelTools(server: McpServer, client: OpencodeClient, config: BridgeConfig): void {
	server.registerTool(
		"bash",
		{
			title: "bash (opencode model tool)",
			description:
				"Execute a bash command, mirroring opencode's `bash` tool. Runs in a real terminal through opencode's pty API with no model in the loop, and returns stdout, stderr and the exit code. Long commands keep running: if the wait window closes first you get a shell_id and cursor to poll with opencode_shell_output. Guarded by the bridge deny/allow patterns.",
			inputSchema: {
				command: z.string().min(1).describe("The command to execute"),
				timeout: z.number().int().positive().optional().describe("Optional timeout in milliseconds"),
				workdir: z.string().optional().describe("The working directory to run the command in. Defaults to the project directory. Use this instead of 'cd' commands."),
			},
		},
		handler(async (args) => {
			const guard = checkCommand(args.command, config)
			if (!guard.allowed) {
				return fail("command rejected by the bridge guard: " + guard.reason, { tool: "bash", command: args.command, matched_pattern: guard.matched ?? null })
			}
			const timeoutSeconds = args.timeout ? Math.max(1, Math.ceil(args.timeout / 1_000)) : undefined
			const started = await client.shellStart({ command: args.command, directory: args.workdir, timeoutSeconds })
			const waitMs = clamp(timeoutSeconds ?? 40, 1, 40) * 1_000
			const deadline = Date.now() + waitMs
			let cursor = 0
			let output = ""
			let status = started.status
			let exitCode: number | null = null
			let truncated = false
			while (true) {
				const chunk = await client.shellOutput(started.id, cursor)
				output += chunk.chunk
				cursor = chunk.nextCursor
				status = chunk.status
				exitCode = chunk.exitCode
				truncated = truncated || chunk.truncated
				if (status !== "running" && status !== "pending") break
				if (Date.now() >= deadline) break
				await sleep(Math.min(400, Math.max(deadline - Date.now(), 50)))
			}
			const done = status !== "running" && status !== "pending"
			const capped = cap(output, config.maxOutputChars)
			return ok({
				ok: true,
				tool: "bash",
				command: args.command,
				workdir: args.workdir ?? config.defaultDirectory ?? null,
				status,
				exit_code: exitCode,
				output: capped.text,
				truncated: truncated || capped.truncated,
				shell_id: started.id,
				cursor,
				api: started.api,
				next_action: done ? null : "still running: call opencode_shell_output with shell_id " + started.id + " and cursor " + cursor,
			})
		}),
	)

	server.registerTool(
		"read",
		{
			title: "read (opencode model tool)",
			description:
				"Read a file or directory from the filesystem opencode is working on, mirroring opencode's `read` tool. Output is line numbered so edit can be aimed precisely. Reads 2000 lines from the top by default; use offset and limit for long files.",
			inputSchema: {
				filePath: z.string().min(1).describe("The absolute path to the file or directory to read"),
				offset: z.number().int().min(1).optional().describe("The line number to start reading from (1-indexed)"),
				limit: z.number().int().positive().optional().describe("The maximum number of lines to read (defaults to 2000)"),
			},
		},
		handler(async (args) => {
			const target = resolveTarget(config, args.filePath)
			const stat = await fs.stat(target).catch(() => null)
			if (!stat) return fail("no such file or directory: " + target, { tool: "read" })
			if (stat.isDirectory()) {
				const entries = await fs.readdir(target, { withFileTypes: true })
				return ok({
					ok: true,
					tool: "read",
					path: target,
					type: "directory",
					entries: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })),
				})
			}
			const raw = await fs.readFile(target, "utf8")
			const lines = raw.split("\n")
			const start = args.offset ?? 1
			const limit = args.limit ?? READ_DEFAULT_LIMIT
			const slice = lines.slice(start - 1, start - 1 + limit)
			const capped = cap(numberLines(slice, start), config.maxOutputChars)
			return ok({
				ok: true,
				tool: "read",
				path: target,
				type: "file",
				total_lines: lines.length,
				start_line: start,
				end_line: start + slice.length - 1,
				bytes: stat.size,
				truncated: capped.truncated || start + slice.length - 1 < lines.length,
				content: capped.text,
			})
		}),
	)

	server.registerTool(
		"write",
		{
			title: "write (opencode model tool)",
			description:
				"Write a file, mirroring opencode's `write` tool. Overwrites an existing file completely and creates missing parent directories. Prefer edit for small changes to an existing file.",
			inputSchema: {
				filePath: z.string().min(1).describe("The absolute path to the file to write"),
				content: z.string().describe("The content to write to the file"),
			},
		},
		handler(async (args) => {
			const target = resolveTarget(config, args.filePath)
			const existing = await fs.stat(target).catch(() => null)
			if (existing?.isDirectory()) return fail("path is a directory: " + target, { tool: "write" })
			await fs.mkdir(dirname(target), { recursive: true })
			await fs.writeFile(target, args.content, "utf8")
			return ok({
				ok: true,
				tool: "write",
				path: target,
				created: existing === null,
				overwrote_bytes: existing?.size ?? 0,
				bytes: Buffer.byteLength(args.content, "utf8"),
				lines: args.content === "" ? 0 : args.content.split("\n").length,
			})
		}),
	)

	server.registerTool(
		"edit",
		{
			title: "edit (opencode model tool)",
			description:
				"Exact string replacement in a file, mirroring opencode's `edit` tool. oldString must appear exactly once unless replaceAll is true, so include enough surrounding context to be unique. Read the file first: whitespace and indentation must match byte for byte.",
			inputSchema: {
				filePath: z.string().min(1).describe("The absolute path to the file to modify"),
				oldString: z.string().describe("The text to replace"),
				newString: z.string().describe("The text to replace it with (must be different from oldString)"),
				replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
			},
		},
		handler(async (args) => {
			const target = resolveTarget(config, args.filePath)
			if (args.oldString === args.newString) return fail("oldString and newString are identical, nothing to do", { tool: "edit", path: target })
			if (args.oldString === "") return fail("oldString is empty; use the write tool to create or replace a whole file", { tool: "edit", path: target })
			const stat = await fs.stat(target).catch(() => null)
			if (!stat?.isFile()) return fail("no such file: " + target, { tool: "edit" })
			const before = await fs.readFile(target, "utf8")
			const occurrences = countOccurrences(before, args.oldString)
			if (occurrences === 0) {
				return fail("oldString was not found in the file; read it again and copy the exact text", { tool: "edit", path: target })
			}
			if (occurrences > 1 && args.replaceAll !== true) {
				return fail("oldString appears " + occurrences + " times; add surrounding context to make it unique or pass replaceAll: true", { tool: "edit", path: target, occurrences })
			}
			const after = args.replaceAll === true ? before.split(args.oldString).join(args.newString) : before.replace(args.oldString, args.newString)
			await fs.writeFile(target, after, "utf8")
			const changedLine = before.slice(0, before.indexOf(args.oldString)).split("\n").length
			const afterLines = after.split("\n")
			const from = Math.max(1, changedLine - 2)
			const snippet = numberLines(afterLines.slice(from - 1, from + 8), from)
			return ok({
				ok: true,
				tool: "edit",
				path: target,
				replacements: args.replaceAll === true ? occurrences : 1,
				first_change_line: changedLine,
				lines_before: before.split("\n").length,
				lines_after: afterLines.length,
				snippet_after: cap(snippet, config.maxOutputChars).text,
			})
		}),
	)

	server.registerTool(
		"glob",
		{
			title: "glob (opencode model tool)",
			description:
				"Find files by path pattern, mirroring opencode's `glob` tool. Supports `**`, `*`, `?` and `{a,b}` and matches against the path relative to the search directory, so use `**/*.ts` rather than `*.ts` to recurse. Results are newest first; .git, node_modules and build output are skipped.",
			inputSchema: {
				pattern: z.string().min(1).describe("The glob pattern to match files against"),
				path: z.string().optional().describe("The directory to search in. Omit for the project directory."),
				limit: z.number().int().positive().max(1_000).optional().describe("Maximum matches to return (default 100)."),
			},
		},
		handler(async (args) => {
			const root = resolveTarget(config, args.path ?? ".")
			const stat = await fs.stat(root).catch(() => null)
			if (!stat?.isDirectory()) return fail("not a directory: " + root, { tool: "glob" })
			const regexp = globToRegExp(args.pattern)
			const limit = args.limit ?? 100
			const matches: Array<{ path: string; mtimeMs: number }> = []
			for await (const file of walkFiles(root)) {
				const rel = relative(root, file.path).split(/[\\/]/).join("/")
				if (!regexp.test(rel)) continue
				matches.push({ path: file.path, mtimeMs: file.mtimeMs })
			}
			matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
			return ok({
				ok: true,
				tool: "glob",
				pattern: args.pattern,
				search_root: root,
				count: matches.length,
				truncated: matches.length > limit,
				files: matches.slice(0, limit).map((match) => match.path),
			})
		}),
	)

	server.registerTool(
		"grep",
		{
			title: "grep (opencode model tool)",
			description:
				"Search file contents with a JavaScript regular expression, mirroring opencode's `grep` tool. Returns matching files with line numbers and the matching line. Narrow the sweep with include, for example \"*.ts\" or \"*.{ts,tsx}\".",
			inputSchema: {
				pattern: z.string().min(1).describe("The regex pattern to search for in file contents"),
				path: z.string().optional().describe("The directory to search in. Defaults to the project directory."),
				include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
				limit: z.number().int().positive().max(1_000).optional().describe("Maximum matching lines to return (default 100)."),
			},
		},
		handler(async (args) => {
			const root = resolveTarget(config, args.path ?? ".")
			const stat = await fs.stat(root).catch(() => null)
			if (!stat) return fail("no such path: " + root, { tool: "grep" })
			let regexp: RegExp
			try {
				regexp = new RegExp(args.pattern)
			} catch (error) {
				return fail("invalid regular expression: " + (error instanceof Error ? error.message : String(error)), { tool: "grep" })
			}
			const includeRe = args.include ? globToRegExp(args.include) : null
			const limit = args.limit ?? 100
			const matches: Array<{ path: string; line: number; text: string }> = []
			let filesScanned = 0
			let truncated = false
			const files: Array<{ path: string; mtimeMs: number }> = []
			if (stat.isFile()) files.push({ path: root, mtimeMs: stat.mtimeMs })
			else for await (const file of walkFiles(root)) files.push(file)
			files.sort((a, b) => b.mtimeMs - a.mtimeMs)
			for (const file of files) {
				const rel = relative(root, file.path).split(/[\\/]/).join("/")
				const name = rel.split("/").pop() ?? rel
				if (includeRe && !includeRe.test(name) && !includeRe.test(rel)) continue
				let content: string
				try {
					content = await fs.readFile(file.path, "utf8")
				} catch {
					continue
				}
				if (content.includes("\u0000")) continue
				filesScanned += 1
				const lines = content.split("\n")
				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index] as string
					if (!regexp.test(line)) continue
					if (matches.length >= limit) {
						truncated = true
						break
					}
					matches.push({ path: file.path, line: index + 1, text: cap(line.trim(), 400).text })
				}
				if (truncated) break
			}
			return ok({
				ok: true,
				tool: "grep",
				pattern: args.pattern,
				search_root: root,
				include: args.include ?? null,
				files_scanned: filesScanned,
				match_count: matches.length,
				truncated,
				matches,
			})
		}),
	)

	server.registerTool(
		"webfetch",
		{
			title: "webfetch (opencode model tool)",
			description: "Fetch a URL and return its content as text, markdown or html, mirroring opencode's `webfetch` tool. Needs no provider credential.",
			inputSchema: {
				url: z.string().url().describe("The URL to fetch content from"),
				format: z.enum(["text", "markdown", "html"]).optional().describe("The format to return the content in. Defaults to markdown."),
				timeout: z.number().positive().max(40).optional().describe("Optional timeout in seconds (max 40 here, the bridge must answer inside the MCP window)"),
			},
		},
		handler(async (args) => {
			const timeoutMs = clamp(args.timeout ?? 20, 1, 40) * 1_000
			const response = await fetch(args.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" })
			const body = await response.text()
			const format = args.format ?? "markdown"
			const text = format === "html" ? body : htmlToText(body)
			const capped = cap(text, config.maxOutputChars)
			return ok({
				ok: response.ok,
				tool: "webfetch",
				url: response.url,
				http_status: response.status,
				content_type: response.headers.get("content-type"),
				format,
				truncated: capped.truncated,
				content: capped.text,
			})
		}),
	)

	server.registerTool(
		"todowrite",
		{
			title: "todowrite (opencode model tool)",
			description: "Record the task list for the current coding session, mirroring opencode's `todowrite` tool. Send the whole list every time; it replaces the previous one.",
			inputSchema: {
				todos: z
					.array(
						z.object({
							content: z.string().min(1).describe("Brief description of the task"),
							status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status of the task"),
							priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task"),
						}),
					)
					.describe("The updated todo list"),
			},
		},
		handler(async (args) => {
			todoState.todos = args.todos as TodoItem[]
			const counts: Record<string, number> = {}
			for (const todo of todoState.todos) counts[todo.status] = (counts[todo.status] ?? 0) + 1
			return ok({ ok: true, tool: "todowrite", total: todoState.todos.length, by_status: counts, todos: todoState.todos })
		}),
	)

	server.registerTool(
		"opencode_model_tools",
		{
			title: "Compare opencode's model tools with the MCP mirror",
			description:
				"Ask opencode which tools it would hand a model (GET /experimental/tool/ids and /experimental/tool) and report which of them this bridge mirrors as MCP tools. Use it to detect drift after an opencode upgrade. provider and model only shape the advertised schemas; no credential is used.",
			inputSchema: {
				provider: z.string().optional().describe("Provider id to ask about, e.g. anthropic. Needed to get full schemas."),
				model: z.string().optional().describe("Model id to ask about, e.g. claude-sonnet-4-5."),
				include_schemas: z.boolean().optional().describe("Include the raw JSON Schema opencode advertises for each tool."),
			},
		},
		handler(async (args) => {
			const idsResponse = await client.request("GET", "/experimental/tool/ids")
			const ids = Array.isArray(idsResponse.data) ? idsResponse.data.map((id) => String(id)) : []
			const mirrored = new Set<string>(MIRRORED_TOOL_IDS)
			let advertised: unknown = null
			if (args.provider && args.model) {
				const toolResponse = await client.request("GET", "/experimental/tool", { query: { provider: args.provider, model: args.model } })
				advertised = toolResponse.data
			}
			const advertisedList = Array.isArray(advertised) ? advertised : []
			return ok({
				ok: true,
				opencode_tool_ids: ids,
				mirrored_as_mcp_tools: ids.filter((id) => mirrored.has(id)),
				not_mirrored: ids.filter((id) => !mirrored.has(id)).map((id) => ({ tool: id, reason: UNMIRRORED_TOOLS[id] ?? "new in this opencode build, no mirror yet" })),
				mirrored_but_missing_upstream: [...mirrored].filter((id) => ids.length > 0 && !ids.includes(id)),
				advertised_for: args.provider && args.model ? args.provider + "/" + args.model : null,
				advertised_count: advertisedList.length,
				advertised_schemas: args.include_schemas === true ? advertisedList : undefined,
			})
		}),
	)
}
