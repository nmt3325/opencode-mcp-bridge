// The parser and hunk matching are extracted unchanged from OpenCode core.
// This adapter supplies workspace checks and per-file atomic writes.
import { Effect, Schema } from "effect"
import { readFile, unlink } from "node:fs/promises"
import { relative } from "node:path"
import { createTwoFilesPatch, diffLines } from "diff"
import { Patch } from "../vendor/opencode/patch.js"
import { trimDiff } from "../vendor/opencode/edit.js"
import { Tool } from "./tool.js"
import { Invocation, checkPath, checkedWrite, fingerprint, verifyGuard, withWriteLock } from "./workspace.js"
const Parameters = Schema.Struct({ patchText: Schema.String.annotate({ description: "The patch to apply, using *** Begin Patch / *** End Patch with Add, Update, Delete and optional Move to hunks." }) })
interface Change { source: string; target: string; kind: string; before: string; after?: string; diff: string }
export const ApplyPatchTool = Tool.define("apply_patch", Effect.succeed({
  description: "Apply an OpenCode patch to add, update, delete or move files. All paths and hunks are validated before any file is touched. Changes are atomic per file, not a multi-file transaction. Inspect progress after a cancellation or failure; never retry a partially applied patch blindly.",
  parameters: Parameters,
  execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => Effect.gen(function* () {
    const invocation = yield* Invocation
    const hunks = Patch.parse(params.patchText)
    if (!hunks.length) throw new Error("No files to modify")
    const changes = yield* Effect.promise(async () => {
      const result: Change[] = [], seen = new Set<string>()
      for (const hunk of hunks) {
        ctx.abort.throwIfAborted()
        const source = await checkPath(invocation.root, hunk.path)
        const target = hunk.type === "update" && hunk.movePath ? await checkPath(invocation.root, hunk.movePath) : source
        for (const path of new Set([source, target])) {
          if (seen.has(path)) throw new Error("Patch mentions a file more than once: " + path)
          seen.add(path); invocation.guards.set(path, await fingerprint(path))
        }
        const existed = invocation.guards.get(source) !== null
        if (hunk.type === "add" && existed) throw new Error("Add File target already exists: " + source)
        if (hunk.type !== "add" && !existed) throw new Error("Patch source does not exist: " + source)
        if (target !== source && invocation.guards.get(target) !== null) throw new Error("Move target already exists: " + target)
        const before = existed ? await readFile(source, "utf8") : ""
        const update = hunk.type === "update" ? Patch.derive(source, hunk.chunks, before) : undefined
        const after = hunk.type === "delete" ? undefined : hunk.type === "add" ? hunk.contents : Patch.joinBom(update!.content, update!.bom)
        result.push({ source, target, kind: hunk.type, before, after, diff: trimDiff(createTwoFilesPatch(source, target, before, after ?? "")) })
      }
      return result
    })
    const files = changes.map((change) => {
      const parts = diffLines(change.before, change.after ?? "")
      return { file: change.source, ...(change.target !== change.source ? { movePath: change.target } : {}), type: change.kind, diff: change.diff,
        additions: parts.filter((part) => part.added).reduce((n, part) => n + part.count, 0),
        deletions: parts.filter((part) => part.removed).reduce((n, part) => n + part.count, 0),
      }
    })
    yield* ctx.ask({ permission: "edit", patterns: [...invocation.guards.keys()].map((path) => relative(invocation.root, path)), always: ["*"], metadata: { files } })
    yield* Effect.promise(async () => { for (const path of invocation.guards.keys()) await verifyGuard(invocation, path) })
    const completed: string[] = [], written: string[] = [], deleted: string[] = []
    const progress = () => Effect.runSync(ctx.metadata({ metadata: { completedFiles: [...completed], writtenFiles: [...written], deletedFiles: [...deleted] } }))
    for (const change of changes) {
      yield* Effect.promise(async () => {
        try {
          if (change.after !== undefined) {
            await checkedWrite(invocation, change.target, change.after)
            written.push(change.target); progress()
          }
          if (change.after === undefined || change.target !== change.source) {
            await withWriteLock(change.source, async () => { await verifyGuard(invocation, change.source); await unlink(change.source); invocation.guards.set(change.source, null) })
            deleted.push(change.source); progress()
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(written.length || deleted.length ? `Patch partially applied (written: ${written.join(", ")}; deleted: ${deleted.join(", ")}). Inspect progress/files before retrying. ${detail}` : detail, { cause: error })
        }
      })
      completed.push(change.target)
      yield* Effect.sync(progress)
    }
    return { title: "Patch applied", output: "Success. Updated the following files:\n" + changes.map((change) => `${change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M"} ${relative(invocation.root, change.target)}`).join("\n"), metadata: { files, completedFiles: completed } }
  }),
}))
