import { Effect, Stream } from "effect"
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse"
// Bound decoded response bytes while streaming, not after an unbounded download.
export const boundedBody = (response: HttpClientResponse, maximum: number) => Effect.gen(function* () {
  const chunks: Uint8Array[] = []
  let bytes = 0
  yield* response.stream.pipe(Stream.runForEach((chunk) => Effect.sync(() => {
    bytes += chunk.byteLength
    if (bytes > maximum) throw new Error("Response too large (exceeds 5MB limit)")
    chunks.push(chunk)
  })))
  return Buffer.concat(chunks)
})
