import { Context, Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { Tool } from "./tool.js"

export class Workspace extends Context.Service<Workspace, {
  directory: string; worktree: string; stateDir: string; ripgrep: string
}>()("toolbox/Workspace") {}
export const context = Workspace
export type Fingerprint = { hash: string; mode: number } | null
export interface InvocationState {
  abort: AbortSignal; root: string; savedOutputs: Set<string>; guards: Map<string, Fingerprint>
}
export class Invocation extends Context.Service<Invocation, InvocationState>()("toolbox/Invocation") {}
export function within(root: string, path: string): boolean {
  const diff = relative(root, path)
  return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith("../") && !diff.startsWith("..\\"))
}
export async function canonical(path: string): Promise<string> {
  let current = resolve(path)
  const tail: string[] = []
  while (true) {
    try { return resolve(await realpath(current), ...tail) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const info = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause
        return undefined
      })
      if (info?.isSymbolicLink()) throw new Error("Dangling symlink is outside the supported workspace scope")
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(relative(parent, current)); current = parent
    }
  }
}
export async function fingerprint(path: string): Promise<Fingerprint> {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error("Expected a regular file: " + path)
    return { hash: createHash("sha256").update(await readFile(path)).digest("hex"), mode: info.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
export async function checkPath(root: string, path: string): Promise<string> {
  const target = await canonical(resolve(root, path))
  if (!within(root, target)) throw new Error("Path denied: target is outside OPENCODE_MCP_ROOT")
  return target
}
export const assertExternalDirectoryEffect = (ctx: Tool.Context, path: string, _options?: { bypass?: boolean; kind?: string }) =>
  Effect.gen(function* () {
    const invocation = yield* Invocation
    ctx.abort.throwIfAborted()
    const target = yield* Effect.promise(() => canonical(path))
    if (!within(invocation.root, target) && !invocation.savedOutputs.has(target)) {
      throw new Error("Path denied: target is outside OPENCODE_MCP_ROOT")
    }
  })

// A tool call can still interleave with an external edit. Refuse to commit a
// diff against a different file, and recheck the canonical target immediately
// before the replacement.
export async function verifyGuard(invocation: InvocationState, path: string): Promise<void> {
  invocation.abort.throwIfAborted()
  const target = await checkPath(invocation.root, path)
  if (target !== path || !invocation.guards.has(path)) throw new Error("File target changed; inspect it before retrying")
  const current = await fingerprint(path), expected = invocation.guards.get(path)
  if (current?.hash !== expected?.hash || current?.mode !== expected?.mode || (current === null) !== (expected === null)) {
    throw new Error("File changed during execution; read it and retry explicitly")
  }
}
const writes = new Map<string, Promise<unknown>>()
export async function withWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prior = writes.get(path) ?? Promise.resolve()
  const work = prior.catch(() => {}).then(fn)
  writes.set(path, work)
  try { return await work } finally { if (writes.get(path) === work) writes.delete(path) }
}
export async function checkedWrite(invocation: InvocationState, path: string, content: string | Uint8Array): Promise<void> {
  await withWriteLock(path, async () => {
    await verifyGuard(invocation, path)
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.toolbox-${randomUUID()}.tmp`)
    const handle = await open(temporary, "wx", invocation.guards.get(path)?.mode ?? 0o666)
    try {
      await handle.writeFile(content); await handle.sync(); await handle.close()
      await verifyGuard(invocation, path)
      await rename(temporary, path)
      invocation.guards.set(path, await fingerprint(path))
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  })
}
export * as InstanceState from "./workspace.js"
