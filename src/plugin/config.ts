import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createRequire } from "node:module"
import { hash } from "./storage.js"
import { UPSTREAM } from "../config.js"
export interface PluginOptions { publicUrl?: string; accountFile?: string; spaceId?: string; model?: string; stateDir?: string; runtimeDir?: string; bun?: string; port?: number; autoSetup?: boolean }
export interface Settings {
  root: string; publicUrl: string; tokenV2: string; account: Record<string, string>
  model: string; stateBase: string; runtimeDir: string; bun: string; port: number
  autoSetup: boolean; connectionName: string
}
export function outside(root: string, target: string): boolean {
  const p = relative(root, target)
  return isAbsolute(p) || p === ".." || p.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
}
export function bundledBun(): string {
  const require = createRequire(import.meta.url)
  const arch = process.arch === "arm64" ? "aarch64" : process.arch
  const os = process.platform === "win32" ? "windows" : process.platform
  if (!["linux", "darwin", "windows"].includes(os) || !["aarch64", "x64"].includes(arch)) throw new Error("Set OPENCODE_MCP_BUN to a supported Bun 1.3.14 executable")
  let suffix = arch === "x64" ? "-baseline" : ""
  if (os === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    if (!report?.header?.glibcVersionRuntime) suffix = `-musl${suffix}`
  }
  return join(dirname(require.resolve(`@oven/bun-${os}-${arch}${suffix}/package.json`)), "bin", os === "windows" ? "bun.exe" : "bun")
}
export async function settings(directory: string, options: PluginOptions = {}, env = process.env): Promise<Settings> {
  const root = await realpath(directory)
  if (dirname(root) === root) throw new Error("A filesystem root cannot be the execution workspace")
  const raw = options.publicUrl ?? env.OPENCODE_NOTION_MCP_URL
  if (!raw) throw new Error("Set OPENCODE_NOTION_MCP_URL to the manually configured public HTTPS /mcp endpoint")
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error("The MCP endpoint must be an HTTPS URL without credentials, query, or fragment")
  const accountPath = options.accountFile ?? env.NOTION_ACCOUNT_FILE
  let account: Record<string, string> = {}
  if (accountPath) {
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(resolve(accountPath), "utf8")) }
    catch { throw new Error("Cannot read Notion account file; check its JSON format and permissions") }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Notion account file must contain a JSON object")
    account = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  }
  const tokenV2 = (env.NOTION_TOKEN_V2 ?? account.token_v2 ?? "").trim()
  if (!tokenV2 || /[\r\n;]/.test(tokenV2)) throw new Error("Set NOTION_TOKEN_V2 or a token_v2 in NOTION_ACCOUNT_FILE; never put it in project config")
  account.space_id = options.spaceId ?? env.NOTION_SPACE_ID ?? account.space_id ?? ""
  const stateBase = resolve(options.stateDir ?? env.OPENCODE_NOTION_STATE_DIR ?? join(homedir(), ".local/state/opencode-notion"))
  const runtimeDir = resolve(options.runtimeDir ?? env.OPENCODE_MCP_RUNTIME_DIR ?? join(stateBase, "runtime", UPSTREAM.version))
  if (!outside(root, stateBase) || !outside(root, runtimeDir)) throw new Error("Plugin state and runtime must be outside the editable workspace")
  const port = options.port ?? Number(env.OPENCODE_MCP_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP port must be between 1 and 65535")
  return { root, publicUrl: url.href, tokenV2, account, stateBase, runtimeDir,
    model: options.model ?? env.NOTION_DEFAULT_MODEL ?? "default",
    bun: options.bun ?? env.OPENCODE_MCP_BUN ?? bundledBun(), port, autoSetup: options.autoSetup !== false,
    connectionName: `OpenCode ${basename(root)} [${hash(root).slice(0, 10)}]` }
}
