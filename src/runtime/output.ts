import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tail } from "../vendor/opencode/shell-output.js"
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export interface Interface {
  write: (text: string) => Effect.Effect<string>
  output: (text: string) => Effect.Effect<{ content: string; truncated: boolean; outputPath?: string }>
}
export class Service extends Context.Service<Service, Interface>()("toolbox/Output") {}
export function layer(directory: string) {
  const write = (text: string) => Effect.promise(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `tool_${randomUUID()}.txt`)
    await writeFile(path, text, { mode: 0o600, flag: "wx" })
    return path
  })
  return Layer.succeed(Service, Service.of({ write, output: (text) => Effect.gen(function* () {
    const preview = tail(text, MAX_LINES, MAX_BYTES)
    if (!preview.cut) return { content: text, truncated: false }
    const outputPath = yield* write(text)
    return { content: `...output truncated...\n\nFull output saved to: ${outputPath}\nUse read with offset/limit to inspect this file.\n\n${preview.text}`, truncated: true, outputPath }
  }) }))
}
export * as Output from "./output.js"
