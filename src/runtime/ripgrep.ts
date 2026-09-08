// Ripgrep is a standalone executable, never downloaded by this server.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { relative } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Workspace } from "./workspace.js"
const run = promisify(execFile)
interface GlobInput { cwd: string; pattern: string; limit: number }
interface GrepInput { cwd: string; pattern: string; include?: string; file?: string; limit: number }
interface Match { entry: { path: string }; line: number; text: string }
export class Service extends Context.Service<Service, {
  glob: (input: GlobInput) => Effect.Effect<Array<{ path: string }>, Error>
  grep: (input: GrepInput) => Effect.Effect<Match[], Error>
}>()("toolbox/Ripgrep") {}
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const workspace = yield* Workspace
  const execute = (args: string[], cwd: string) => Effect.tryPromise({
    try: async (signal) => {
      try { return (await run(workspace.ripgrep, args, { cwd, signal, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60000 })).stdout }
      catch (error) {
        const cause = error as Error & { code?: string | number; stderr?: string }
        if (cause.code === 1) return ""
        if (cause.code === "ENOENT") throw new Error("ripgrep (rg) is required for glob/grep. Install it or set OPENCODE_MCP_RG; no automatic downloads are performed.")
        throw new Error(`ripgrep failed: ${cause.stderr || cause.message}`)
      }
    }, catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
  const common = ["--hidden", "--no-follow", "--glob", "!.git", "--sortr", "modified"]
  return Service.of({
    glob: ({ cwd, pattern, limit }) => execute(["--files", "--null", ...common, "--glob", pattern, "--", "."], cwd).pipe(
      Effect.map((output) => output.split("\0").filter(Boolean).slice(0, limit).map((path) => ({ path }))),
    ),
    grep: ({ cwd, pattern, include, file, limit }) => execute([
      "--json", ...common, ...(include ? ["--glob", include] : []), "--regexp", pattern, "--", file ?? ".",
    ], cwd).pipe(Effect.map((output) => {
      const rows: Match[] = []
      for (const line of output.split("\n")) {
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.type !== "match") continue
        const data = frame.data
        const path = data.path.text ?? Buffer.from(data.path.bytes, "base64").toString("utf8")
        const text = data.lines.text ?? Buffer.from(data.lines.bytes, "base64").toString("utf8")
        rows.push({ entry: { path: file ? relative(cwd, file) : path }, line: data.line_number, text: text.replace(/\r?\n$/, "") })
        if (rows.length === limit) break
      }
      return rows
    })),
  })
}))
export * as Ripgrep from "./ripgrep.js"
