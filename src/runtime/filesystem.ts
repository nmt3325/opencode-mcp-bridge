// Only the filesystem capabilities consumed by the extracted tool leaves.
// Node adapters avoid importing the rest of OpenCode or a platform service graph.
import { Context, Effect, Layer, Option, Scope, Stream } from "effect"
import { createReadStream } from "node:fs"
import { open, readFile, readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { lookup } from "mime-types"
import { checkedWrite, Invocation } from "./workspace.js"
class FileError extends Error {
  readonly reason: { _tag: "NotFound" | "Other" }
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.reason = { _tag: (cause as NodeJS.ErrnoException)?.code === "ENOENT" ? "NotFound" : "Other" }
  }
}
interface DirEntry { name: string; type: "file" | "directory" | "symlink" | "other" }
interface Reader { readAlloc: (size: number) => Effect.Effect<Option.Option<Uint8Array>, FileError> }
export interface Interface {
  stat: (path: string) => Effect.Effect<{ type: "Directory" | "File" | "Other"; size: number }, FileError>
  existsSafe: (path: string) => Effect.Effect<boolean>
  readFile: (path: string) => Effect.Effect<Uint8Array, FileError>
  readDirectory: (path: string) => Effect.Effect<string[], FileError>
  readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], FileError>
  open: (path: string, options: { flag: string }) => Effect.Effect<Reader, FileError, Scope.Scope>
  stream: (path: string) => Stream.Stream<Uint8Array, FileError>
  writeWithDirs: (path: string, content: string | Uint8Array) => Effect.Effect<void, never, Invocation>
}
const io = <T>(fn: (signal: AbortSignal) => Promise<T>) => Effect.tryPromise({ try: fn, catch: (cause) => new FileError(cause) })
export class Service extends Context.Service<Service, Interface>()("toolbox/Filesystem") {}
export const layer = Layer.succeed(Service, Service.of({
  stat: (path) => io(async () => { const info = await stat(path); return { type: info.isDirectory() ? "Directory" : info.isFile() ? "File" : "Other", size: info.size } }),
  existsSafe: (path) => io(async () => { await stat(path); return true }).pipe(Effect.orElseSucceed(() => false)),
  readFile: (path) => io((signal) => readFile(path, { signal })),
  readDirectory: (path) => io(() => readdir(path)),
  readDirectoryEntries: (path) => io(async () => (await readdir(path, { withFileTypes: true })).map((item): DirEntry => ({
    name: item.name, type: item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : item.isFile() ? "file" : "other",
  }))),
  open: (path, options) => Effect.acquireRelease(io(() => open(path, options.flag)), (handle) => Effect.promise(() => handle.close())).pipe(
    Effect.map((handle): Reader => ({ readAlloc: (size) => io(async () => {
      const bytes = Buffer.alloc(size)
      const result = await handle.read(bytes, 0, size, null)
      return result.bytesRead ? Option.some(bytes.subarray(0, result.bytesRead)) : Option.none()
    }) })),
  ),
  stream: (path) => Stream.fromAsyncIterable(createReadStream(path), (error) => new FileError(error)),
  writeWithDirs: (path, content) => Effect.gen(function* () {
    const invocation = yield* Invocation
    yield* Effect.promise(() => checkedWrite(invocation, path, content))
  }),
}))
export function normalizePath(path: string): string { return resolve(path) }
export function mimeType(path: string): string { return lookup(path) || "application/octet-stream" }
export { resolve }
export * as FSUtil from "./filesystem.js"
