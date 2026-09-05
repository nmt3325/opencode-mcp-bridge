#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, readFile, copyFile, access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { UPSTREAM } from "../dist/config.js"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = resolve(process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(root, ".opencode-runtime"))
const bun = process.env.OPENCODE_MCP_BUN ?? "bun"
const version = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim()
if (version !== UPSTREAM.bun) throw new Error(`Install Bun ${UPSTREAM.bun}; found ${version}. A standalone opencode executable cannot supply the internal tool modules.`)
const exists = await access(join(target, ".git")).then(() => true, () => false)
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, HUSKY: "0" } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}
if (!exists) {
  await mkdir(dirname(target), { recursive: true })
  run("git", ["clone", "--depth", "1", "--branch", `v${UPSTREAM.version}`, UPSTREAM.repository, target])
}
const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (head !== UPSTREAM.commit) throw new Error("Existing checkout has a different commit. Use a separate runtime directory; setup will not overwrite it.")
run("git", ["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], target)
run(bun, ["install", "--frozen-lockfile", "--filter", "./packages/opencode", "--ignore-scripts"], target)
const adapter = join(target, "packages/opencode/.mcp-toolbox")
await mkdir(adapter, { recursive: true })
for (const file of ["entry.ts", "native-worker.ts"]) {
  await copyFile(join(root, "runtime", file), join(adapter, file))
  if (!(await readFile(join(adapter, file))).equals(await readFile(join(root, "runtime", file)))) throw new Error("Adapter copy verification failed")
}
console.log(`Prepared unchanged OpenCode ${UPSTREAM.version} (${UPSTREAM.commit}) in ${target}`)
console.log("Tool-only context installed. No opencode serve process, provider login, or model API key is required.")
