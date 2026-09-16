import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const UPSTREAM = {
  repository: "https://github.com/anomalyco/opencode.git",
  version: "1.18.29",
  commit: "16747470f976aca3d362ad730bcd3fe82ecc2c9a",
  distribution: "vendored-tools",
} as const
export const VERSION = "0.4.0"
export const NATIVE_TOOL_IDS = ["read", "write", "edit", "glob", "grep", "bash", "webfetch", "todowrite", "apply_patch"] as const

export interface BridgeConfig {
  root: string
  stateDir: string
  ripgrep: string
  httpHost: string
  httpPort: number
  mcpToken?: string
  waitMs: number
  jobTimeoutMs: number
  maxJobs: number
  maxConcurrent: number
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key])
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  for (const key of ["OPENCODE_BASE_URL", "OPENCODE_SERVER_PASSWORD", "OPENCODE_API_TOKEN", "OPENCODE_MCP_DEFAULT_MODEL", "OPENCODE_MCP_DEFAULT_AGENT", "OPENCODE_MCP_SHELL_BACKEND", "OPENCODE_MCP_RUNTIME_DIR", "OPENCODE_MCP_BUN"]) {
    if (env[key]) throw new Error(`${key} was removed: this bridge executes native tools only. See README migration instructions.`)
  }
  if (env.OPENCODE_MCP_PERMISSIONS) {
    throw new Error("OPENCODE_MCP_PERMISSIONS was removed: there is no pre-execution approval, so every tool call from an authenticated client runs immediately. See README migration instructions.")
  }
  for (const key of ["OPENCODE_MCP_LSP", "OPENCODE_MCP_FORMATTER"]) {
    if (env[key] && !["false", "0"].includes(env[key]!)) throw new Error(`${key} was removed: application services are not included in the standalone toolbox`)
  }
  const directory = env.OPENCODE_MCP_ROOT ?? env.OPENCODE_MCP_DEFAULT_DIRECTORY
  if (!directory) throw new Error("Set OPENCODE_MCP_ROOT to the workspace directory; implicit filesystem-wide access is not allowed.")
  const root = resolve(directory)
  if (dirname(root) === root) throw new Error("The filesystem root cannot be the toolbox workspace")
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20)
  const maxJobs = integer(env, "OPENCODE_MCP_MAX_JOBS", 64, 8, 256)
  const maxConcurrent = integer(env, "OPENCODE_MCP_MAX_CONCURRENT", 8, 1, 32)
  if (maxConcurrent > maxJobs) throw new Error("OPENCODE_MCP_MAX_CONCURRENT must not exceed OPENCODE_MCP_MAX_JOBS")
  return {
    root,
    stateDir: resolve(env.OPENCODE_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "opencode-mcp-bridge", key)),
    ripgrep: env.OPENCODE_MCP_RG ?? "rg",
    httpHost: env.OPENCODE_MCP_HOST ?? "127.0.0.1",
    httpPort: integer(env, "OPENCODE_MCP_PORT", 8787, 1, 65535),
    mcpToken: env.OPENCODE_MCP_TOKEN,
    waitMs: integer(env, "OPENCODE_MCP_WAIT_MAX_SECONDS", 45, 0, 50) * 1000,
    jobTimeoutMs: integer(env, "OPENCODE_MCP_JOB_TIMEOUT_SECONDS", 600, 5, 3600) * 1000,
    maxJobs, maxConcurrent,
  }
}

// Do not give the execution worker the MCP token, provider keys, GitHub tokens,
// SSH agent, NODE_OPTIONS, BUN_OPTIONS, or the caller's existing OpenCode home.
export function workerEnvironment(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (env[key]) result[key] = env[key]
  }
  const home = join(config.stateDir, "home")
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    APPDATA: join(home, "config"),
    LOCALAPPDATA: join(home, "data"),
    TMPDIR: join(home, "tmp"), TEMP: join(home, "tmp"), TMP: join(home, "tmp"),

  }
}
