/**
 * Configuration for the opencode MCP bridge.
 *
 * Every value can be supplied through environment variables so the bridge can
 * run as a systemd unit without a config file.
 */
export interface BridgeConfig {
	/** Base URL of `opencode serve`, e.g. http://127.0.0.1:4096 */
	baseUrl: string
	basicUser?: string
	basicPassword?: string
	bearerToken?: string
	/** Hard timeout for a single upstream HTTP call. */
	requestTimeoutMs: number
	/** Timeout for fire-and-forget calls that intentionally outlive a tool call. */
	backgroundTimeoutMs: number
	/** Upper bound for `opencode_wait`, always kept below the MCP client timeout. */
	waitMaxSeconds: number
	pollIntervalMs: number
	maxOutputChars: number
	defaultDirectory?: string
	defaultAgent?: string
	defaultModel?: string
	denyPatterns: string[]
	allowPatterns: string[]
	httpHost: string
	httpPort: number
	/** Optional bearer token required by the bridge's own HTTP endpoint. */
	mcpToken?: string
	shellDefaultTimeoutSeconds: number
}

/**
 * Conservative defaults. Anything matching these never reaches opencode.
 * Override with OPENCODE_MCP_DENY_PATTERNS (comma separated or JSON array).
 */
export const DEFAULT_DENY_PATTERNS = [
	"rm -rf /",
	"rm -rf /*",
	"rm -fr /",
	"rm -fr /*",
	"rm -rf ~",
	"rm -rf ~/*",
	"mkfs*",
	"dd if=* of=/dev/*",
	"shutdown*",
	"reboot*",
	"halt*",
	"init 0",
	"chmod -R 777 /*",
	":(){:|:&};:",
]

function num(value: string | undefined, fallback: number): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function list(value: string | undefined, fallback: string[]): string[] {
	if (value === undefined) return fallback
	const trimmed = value.trim()
	if (trimmed === "") return []
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (Array.isArray(parsed)) return parsed.map((item) => String(item))
		} catch {
			// fall through to comma separated parsing
		}
	}
	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
	const password = env.OPENCODE_SERVER_PASSWORD
	return {
		baseUrl: (env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096").replace(/\/+$/, ""),
		basicUser: env.OPENCODE_SERVER_USERNAME ?? (password ? "opencode" : undefined),
		basicPassword: password,
		bearerToken: env.OPENCODE_API_TOKEN,
		requestTimeoutMs: num(env.OPENCODE_MCP_REQUEST_TIMEOUT_MS, 20_000),
		backgroundTimeoutMs: num(env.OPENCODE_MCP_BACKGROUND_TIMEOUT_MS, 900_000),
		waitMaxSeconds: Math.min(num(env.OPENCODE_MCP_WAIT_MAX_SECONDS, 45), 50),
		pollIntervalMs: num(env.OPENCODE_MCP_POLL_INTERVAL_MS, 1_000),
		maxOutputChars: num(env.OPENCODE_MCP_MAX_OUTPUT_CHARS, 20_000),
		defaultDirectory: env.OPENCODE_MCP_DEFAULT_DIRECTORY,
		defaultAgent: env.OPENCODE_MCP_DEFAULT_AGENT,
		defaultModel: env.OPENCODE_MCP_DEFAULT_MODEL,
		denyPatterns: list(env.OPENCODE_MCP_DENY_PATTERNS, DEFAULT_DENY_PATTERNS),
		allowPatterns: list(env.OPENCODE_MCP_ALLOW_PATTERNS, []),
		httpHost: env.OPENCODE_MCP_HOST ?? "127.0.0.1",
		httpPort: num(env.OPENCODE_MCP_PORT, 8787),
		mcpToken: env.OPENCODE_MCP_TOKEN,
		shellDefaultTimeoutSeconds: num(env.OPENCODE_MCP_SHELL_TIMEOUT_SECONDS, 120),
	}
}

const REGEXP_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "/"])

/** Glob-ish matcher used for the shell guard (`*` and `?` wildcards, case insensitive). */
export function wildcardToRegExp(pattern: string): RegExp {
	let out = "^"
	for (const ch of pattern) {
		if (ch === "*") {
			out += "[\\s\\S]*"
			continue
		}
		if (ch === "?") {
			out += "[\\s\\S]"
			continue
		}
		if (ch === "\\") {
			out += "\\\\"
			continue
		}
		out += REGEXP_SPECIAL.has(ch) ? "\\" + ch : ch
	}
	return new RegExp(out + "$", "i")
}

export function wildcardMatch(pattern: string, value: string): boolean {
	return wildcardToRegExp(pattern).test(value)
}

export interface GuardResult {
	allowed: boolean
	reason?: string
	matched?: string
}

/**
 * Bridge side guard. This is a second line of defence: opencode's own
 * `permission` config still applies on the server.
 */
export function checkCommand(command: string, config: BridgeConfig): GuardResult {
	const normalized = command.trim().replace(/\s+/g, " ")
	if (normalized === "") return { allowed: false, reason: "empty command" }
	for (const pattern of config.denyPatterns) {
		if (wildcardMatch(pattern, normalized)) {
			return { allowed: false, reason: "blocked by OPENCODE_MCP_DENY_PATTERNS", matched: pattern }
		}
	}
	if (config.allowPatterns.length > 0) {
		const hit = config.allowPatterns.find((pattern) => wildcardMatch(pattern, normalized))
		if (!hit) {
			return { allowed: false, reason: "command does not match OPENCODE_MCP_ALLOW_PATTERNS" }
		}
		return { allowed: true, matched: hit }
	}
	return { allowed: true }
}
