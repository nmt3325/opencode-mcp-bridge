#!/usr/bin/env node
/**
 * Minimal stand-in for `opencode serve`, used by test/e2e.sh.
 *
 * It implements the subset of the opencode HTTP API the bridge talks to:
 *   v2 mode      : /api/shell*, /session/:id/prompt_async, /session/status, /api/vcs/*
 *   --legacy mode: those return 404 so the bridge must fall back to
 *                  POST /session/:id/message and POST /session/:id/shell
 *
 * Shell commands are really executed with bash, so the async job semantics
 * (running -> output chunks -> exit code, timeout, kill) are exercised for real.
 */
import { createServer } from "node:http"
import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
	const index = argv.indexOf(name)
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const LEGACY = argv.includes("--legacy")
// builds that answer /api/shell with the web UI instead of JSON
const HTML_SPA = argv.includes("--html-spa")
const SPA_POST = argv.includes("--spa-post")
const PORT = Number(flag("--port", "4599"))
const ROOT = flag("--root", process.cwd())
const PASSWORD = process.env.MOCK_OPENCODE_PASSWORD ?? ""
const AGENT_DELAY_MS = Number(process.env.MOCK_AGENT_DELAY_MS ?? "3000")

const sessions = new Map()
const shells = new Map()
const permissions = new Map()
const questions = new Map()

const log = (...parts) => console.log("[mock]", ...parts)

function json(res, status, payload) {
	const body = payload === undefined ? "" : JSON.stringify(payload)
	res.writeHead(status, { "content-type": "application/json" })
	res.end(body)
}

function notFound(res) {
	json(res, 404, { error: "not found" })
}

function newSession(title, directory) {
	const id = "ses_" + randomUUID().slice(0, 8)
	const session = { id, title: title ?? "untitled", directory: directory ?? ROOT, status: "idle", messages: [] }
	sessions.set(id, session)
	return session
}

function pushMessage(session, role, text) {
	session.messages.push({
		info: { id: "msg_" + randomUUID().slice(0, 8), role, sessionID: session.id, time: { created: Date.now() } },
		parts: [{ type: "text", text }],
	})
}

/** Fake "the model is working" behaviour, including a permission gate. */
function runPrompt(session, prompt) {
	session.status = "busy"
	pushMessage(session, "user", prompt)
	if (prompt.includes("ask-permission")) {
		const id = "perm_" + randomUUID().slice(0, 8)
		permissions.set(id, {
			id,
			sessionID: session.id,
			tool: "bash",
			title: "git push origin main",
			metadata: { command: "git push origin main" },
		})
		log("permission requested", id)
		return
	}
	const delay = /delay=(\d+)/.exec(prompt)
	const ms = delay ? Number(delay[1]) : AGENT_DELAY_MS
	setTimeout(() => {
		if (session.status !== "busy") return
		session.messages.push({
			info: { id: "msg_" + randomUUID().slice(0, 8), role: "assistant", sessionID: session.id },
			parts: [
				{ type: "tool", tool: "bash", state: { status: "completed", output: "ok" } },
				{ type: "text", text: "done: " + prompt },
			],
		})
		session.status = "idle"
		log("session", session.id, "idle")
	}, ms)
}

function startShell(command, timeoutSeconds, cwd) {
	const id = "sh_" + randomUUID().slice(0, 8)
	const child = spawn("bash", ["-lc", command], { cwd: cwd ?? ROOT })
	const job = { id, command, status: "running", exitCode: null, output: "", child, timeout: timeoutSeconds ?? 120, timer: null }
	const arm = (seconds) => {
		if (job.timer) clearTimeout(job.timer)
		job.timer = setTimeout(() => {
			if (job.status !== "running") return
			job.status = "timeout"
			child.kill("SIGKILL")
		}, Math.max(seconds, 1) * 1000)
	}
	job.arm = arm
	arm(job.timeout)
	child.stdout.on("data", (chunk) => {
		job.output += chunk.toString()
	})
	child.stderr.on("data", (chunk) => {
		job.output += chunk.toString()
	})
	child.on("close", (code, signal) => {
		if (job.timer) clearTimeout(job.timer)
		if (job.status === "running") job.status = code === 0 ? "completed" : "failed"
		job.exitCode = code === null ? (signal ? 137 : null) : code
		log("shell", id, job.status, "exit", job.exitCode)
	})
	shells.set(id, job)
	return job
}

function publicShell(job) {
	return { id: job.id, command: job.command, status: job.status, exitCode: job.exitCode, timeout: job.timeout }
}

async function walk(dir, out, depth = 0) {
	if (depth > 4 || out.length > 2000) return out
	let entries = []
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue
		const full = join(dir, entry.name)
		if (entry.isDirectory()) await walk(full, out, depth + 1)
		else out.push(full)
	}
	return out
}

async function readRequestBody(req) {
	const chunks = []
	for await (const chunk of req) chunks.push(chunk)
	if (chunks.length === 0) return {}
	const raw = Buffer.concat(chunks).toString("utf8")
	if (!raw.trim()) return {}
	try {
		return JSON.parse(raw)
	} catch {
		return {}
	}
}

const server = createServer((req, res) => {
	void (async () => {
		const url = new URL(req.url, "http://localhost")
		const path = url.pathname
		const method = req.method ?? "GET"
		if (PASSWORD) {
			const header = req.headers.authorization ?? ""
			const expected = "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
			if (header !== expected) {
				json(res, 401, { error: "unauthorized" })
				return
			}
		}
		const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readRequestBody(req) : {}
		log(method, path)

		// ------------------------------------------------------------ sessions
		if (path === "/session" && method === "POST") {
			const session = newSession(body.title, url.searchParams.get("directory"))
			json(res, 200, { id: session.id, title: session.title, directory: session.directory })
			return
		}
		if (path === "/session" && method === "GET") {
			json(res, 200, [...sessions.values()].map((s) => ({ id: s.id, title: s.title, directory: s.directory, status: s.status })))
			return
		}
		if (path === "/session/status" && method === "GET") {
			if (LEGACY) return notFound(res)
			json(res, 200, [...sessions.values()].map((s) => ({ sessionID: s.id, status: s.status })))
			return
		}
		const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(path)
		if (sessionMatch) {
			const session = sessions.get(sessionMatch[1])
			const suffix = sessionMatch[2] ?? ""
			if (!session) return notFound(res)
			if (suffix === "" && method === "GET") {
				json(res, 200, { id: session.id, title: session.title, status: session.status })
				return
			}
			if (suffix === "/prompt_async" && method === "POST") {
				if (LEGACY) return notFound(res)
				const text = (body.parts ?? []).map((part) => part.text ?? "").join(" ")
				runPrompt(session, text)
				res.writeHead(204).end()
				return
			}
			if (suffix === "/message" && method === "POST") {
				// blocking endpoint: answers only once the fake agent is done
				const text = (body.parts ?? []).map((part) => part.text ?? "").join(" ")
				runPrompt(session, text)
				const waitForIdle = setInterval(() => {
					if (session.status === "idle") {
						clearInterval(waitForIdle)
						json(res, 200, session.messages[session.messages.length - 1] ?? {})
					}
				}, 200)
				return
			}
			if (suffix === "/message" && method === "GET") {
				json(res, 200, session.messages)
				return
			}
			if (suffix === "/abort" && method === "POST") {
				session.status = "idle"
				json(res, 200, { ok: true })
				return
			}
			if (suffix === "/shell" && method === "POST") {
				// legacy blocking shell: run to completion, then answer
				const job = startShell(body.command, 120, session.directory)
				const waitForExit = setInterval(() => {
					if (job.status !== "running") {
						clearInterval(waitForExit)
						json(res, 200, {
							info: { id: "msg_" + randomUUID().slice(0, 8), role: "assistant", sessionID: session.id },
							parts: [{ type: "tool", tool: "bash", state: { status: job.status, output: job.output } }],
						})
					}
				}, 150)
				return
			}
			return notFound(res)
		}

		// --------------------------------------------------------------- shell
		if (path.startsWith("/api/shell")) {
			if (LEGACY) return notFound(res)
			if (HTML_SPA || (SPA_POST && method === "POST")) {
				res.writeHead(200, { "content-type": "text/html" })
				res.end("<!doctype html><html><head><title>OpenCode</title></head><body>web ui</body></html>")
				return
			}
			if (path === "/api/shell" && method === "GET") {
				json(res, 200, [...shells.values()].map(publicShell))
				return
			}
			if (path === "/api/shell" && method === "POST") {
				if (!body.command) {
					json(res, 400, { error: "command is required" })
					return
				}
				const job = startShell(body.command, body.timeout, body.cwd ?? url.searchParams.get("directory"))
				json(res, 200, publicShell(job))
				return
			}
			const shellMatch = /^\/api\/shell\/([^/]+)(\/.*)?$/.exec(path)
			if (shellMatch) {
				const job = shells.get(shellMatch[1])
				const suffix = shellMatch[2] ?? ""
				if (!job) return notFound(res)
				if (suffix === "" && method === "GET") {
					json(res, 200, publicShell(job))
					return
				}
				if (suffix === "/output" && method === "GET") {
					const cursor = Number(url.searchParams.get("cursor") ?? "0")
					const chunk = job.output.slice(Number.isFinite(cursor) ? cursor : 0)
					json(res, 200, { id: job.id, chunk, nextCursor: job.output.length, status: job.status, exitCode: job.exitCode })
					return
				}
				if (suffix === "/timeout" && method === "PATCH") {
					const seconds = Number(body.timeout ?? body.timeoutSeconds ?? 60)
					job.timeout = seconds
					job.arm(seconds)
					json(res, 200, publicShell(job))
					return
				}
				if (suffix === "" && method === "DELETE") {
					if (job.status === "running") {
						job.status = "killed"
						job.child.kill("SIGKILL")
					}
					json(res, 200, publicShell(job))
					return
				}
			}
			return notFound(res)
		}

		// --------------------------------------------------------- files/search
		if ((path === "/file/content" || path === "/file") && method === "GET") {
			const target = url.searchParams.get("path") ?? ""
			try {
				const content = await readFile(target.startsWith("/") ? target : join(ROOT, target), "utf8")
				json(res, 200, { path: target, content })
			} catch (error) {
				json(res, 404, { error: String(error.message ?? error) })
			}
			return
		}
		if (path === "/find" && method === "GET") {
			const pattern = url.searchParams.get("pattern") ?? ""
			const files = await walk(ROOT, [])
			const matches = []
			for (const file of files.slice(0, 400)) {
				let content = ""
				try {
					content = await readFile(file, "utf8")
				} catch {
					continue
				}
				content.split("\n").forEach((line, index) => {
					if (pattern && line.includes(pattern) && matches.length < 100) {
						matches.push({ path: relative(ROOT, file), line: index + 1, text: line.trim().slice(0, 200) })
					}
				})
			}
			json(res, 200, matches)
			return
		}
		if (path === "/find/file" && method === "GET") {
			const query = (url.searchParams.get("query") ?? "").toLowerCase()
			const files = await walk(ROOT, [])
			json(
				res,
				200,
				files.map((file) => relative(ROOT, file)).filter((file) => file.toLowerCase().includes(query)).slice(0, 100),
			)
			return
		}

		// ----------------------------------------------------------------- vcs
		const vcsBase = LEGACY ? "/vcs" : "/api/vcs"
		if (path === vcsBase + "/status" && method === "GET") {
			json(res, 200, { branch: "main", dirty: true })
			return
		}
		if (path === vcsBase + "/diff" && method === "GET") {
			execFile("git", ["diff"], { cwd: ROOT, maxBuffer: 4_000_000 }, (error, stdout) => {
				json(res, 200, { diff: error ? "diff unavailable" : stdout || "(no changes)" })
			})
			return
		}
		if (path.startsWith("/api/vcs") || path.startsWith("/vcs")) return notFound(res)

		// --------------------------------------------------------- permissions
		if (path === "/permission" && method === "GET") {
			json(res, 200, [...permissions.values()])
			return
		}
		const permissionMatch = /^\/permission\/([^/]+)\/reply$/.exec(path)
		if (permissionMatch && method === "POST") {
			const permission = permissions.get(permissionMatch[1])
			if (!permission) return notFound(res)
			permissions.delete(permission.id)
			const session = sessions.get(permission.sessionID)
			const reply = body.reply ?? body.response ?? "once"
			if (session) {
				pushMessage(session, "assistant", reply === "reject" ? "permission rejected, stopping" : "permission " + reply + ", command executed")
				session.status = "idle"
			}
			json(res, 200, { ok: true, reply })
			return
		}

		// ----------------------------------------------------------- questions
		if (path === "/question" && method === "GET") {
			json(res, 200, [...questions.values()])
			return
		}
		const questionMatch = /^\/question\/([^/]+)\/reply$/.exec(path)
		if (questionMatch && method === "POST") {
			questions.delete(questionMatch[1])
			json(res, 200, { ok: true })
			return
		}

		if (path === "/doc") {
			json(res, 200, { openapi: "3.0.0", info: { title: "mock opencode", version: LEGACY ? "legacy" : "v2" } })
			return
		}
		notFound(res)
	})().catch((error) => {
		log("handler error", error)
		if (!res.headersSent) json(res, 500, { error: String(error.message ?? error) })
	})
})

server.listen(PORT, "127.0.0.1", () => {
	log("listening on http://127.0.0.1:" + PORT + (LEGACY ? " (legacy mode)" : " (v2 mode)") + " root=" + ROOT)
})
