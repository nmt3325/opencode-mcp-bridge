// Execution-only adaptation of upstream Tool.define: schema decoding and output
// bounding remain; model, agent, message history and session services do not.
import { Effect, Schema } from "effect"
import type { NativeResult } from "../protocol.js"
import type { Invocation, Workspace } from "./workspace.js"
import { Output } from "./output.js"
export type Context<M extends Record<string, unknown> = Record<string, unknown>> = {
  sessionID: string
  abort: AbortSignal
  extra?: Record<string, unknown>
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: { permission: string; patterns: string[]; always?: string[]; metadata: Record<string, unknown> }): Effect.Effect<void>
}
export interface DefWithoutID<P extends Schema.Decoder<unknown> = Schema.Decoder<unknown>, M extends Record<string, unknown> = Record<string, unknown>> {
  description: string
  parameters: P
  execute(args: Schema.Schema.Type<P>, ctx: Context): Effect.Effect<NativeResult & { metadata: M }, unknown, Invocation | Workspace>
}
export interface Def {
  id: string
  description: string
  parameters: Schema.Decoder<unknown>
  jsonSchema?: boolean | Record<string, unknown>
  execute(args: unknown, ctx: Context): Effect.Effect<NativeResult, never, Invocation | Workspace>
}
export function define<P extends Schema.Decoder<unknown>, M extends Record<string, unknown>, R>(
  id: string, initial: Effect.Effect<DefWithoutID<P, M>, never, R>,
): Effect.Effect<Def, never, R | Output.Service> {
  return Effect.gen(function* () {
    const tool = yield* initial
    const output = yield* Output.Service
    const decode = Schema.decodeUnknownEffect(tool.parameters)
    return {
      id, description: tool.description, parameters: tool.parameters,
      execute: (args: unknown, ctx: Context) => Effect.gen(function* () {
        const decoded = yield* decode(args).pipe(Effect.mapError((error) => new Error(`The ${id} tool was called with invalid arguments: ${String(error)}`)))
        ctx.abort.throwIfAborted()
        const result = yield* tool.execute(decoded as Schema.Schema.Type<P>, ctx)
        if (result.metadata.truncated !== undefined) return result
        const truncated = yield* output.output(result.output)
        return { ...result, output: truncated.content, metadata: {
          ...result.metadata, truncated: truncated.truncated,
          ...(truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
        } }
      }).pipe(Effect.orDie),
    }
  })
}
export * as Tool from "./tool.js"
