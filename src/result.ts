import { OpencodeError } from "./opencodeClient.js"

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

export function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

export function fail(error: unknown, extra: Record<string, unknown> = {}): ToolResult {
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

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

export async function withCap<T>(work: Promise<T>, ms = HARD_CAP_MS): Promise<T> {
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

/** Wrap a tool body so every failure becomes a readable result instead of a transport error. */
export function handler(fn: (args: any) => Promise<ToolResult>): (args: any) => Promise<ToolResult> {
	return async (args: any) => {
		try {
			return await withCap(fn(args))
		} catch (error) {
			return fail(error)
		}
	}
}
