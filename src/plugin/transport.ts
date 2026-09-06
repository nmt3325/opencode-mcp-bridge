import { randomUUID } from "node:crypto"
import { Journal, hash } from "./storage.js"
import type { ChatBackend } from "./notion.js"
export const PROVIDER = "notion-ai"
export const CHAT_MODEL = "chat"
export const META_MODEL = "metadata"
export const SESSION_HEADER = "x-opencode-notion-session"
export const MESSAGE_HEADER = "x-opencode-notion-message"
export const AGENT_HEADER = "x-opencode-notion-agent"
const AUXILIARY = new Set(["title", "summary", "compaction"])
function newestText(messages: unknown): string {
  if (!Array.isArray(messages)) throw new Error("Missing chat messages")
  const message = [...messages].reverse().find(m => m?.role === "user")
  if (!message) throw new Error("Missing user message")
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) throw new Error("Unsupported user message")
  if (message.content.some((part: any) => part?.type !== "text")) throw new Error("This first plugin version accepts text only; attachments are not silently discarded")
  return message.content.map((part: any) => String(part.text ?? "")).join("\n")
}
function responseError(message: string, status = 400): Response {
  return Response.json({ error: { message, type: "notion_plugin_error" } }, { status })
}
export class NotionTransport {
  private busy?: { session: string; message: string; promise: Promise<string>; controller: AbortController }
  private closed = false
  constructor(private readonly backend: ChatBackend, readonly journal: Journal,
    private readonly context: string, private readonly redact: (text: string) => string = text => text,
    private readonly cancelTools: () => Promise<void> = async () => {}) {}
  private async turn(session: string, message: string, prompt: string, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("Plugin is shutting down")
    signal.throwIfAborted()
    const promptHash = hash(prompt)
    const known = this.journal.data.sessions[session]?.turns[message]
    if (known && known.promptHash !== promptHash) throw new Error("Message ID was reused with different content; start a new message")
    if (known?.status === "complete") return known.text ?? ""
    if (this.busy) {
      if (this.busy.session === session && this.busy.message === message) return this.busy.promise
      throw new Error("Another Notion turn is active in this workspace. Wait for it to finish or stop it before sending another message")
    }
    if (known) throw new Error("This message was already dispatched. Its result is uncertain or it was interrupted; it will not be automatically resent. Inspect the Notion conversation, then send a new message")
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    // Reserve synchronously, before any persistence or network await.
    const promise = this.execute(session, message, prompt, promptHash, combined)
    const busy = { session, message, promise, controller }; this.busy = busy
    try { return await promise } finally { if (this.busy === busy) this.busy = undefined }
  }
  private async execute(session: string, message: string, prompt: string, promptHash: string, signal: AbortSignal): Promise<string> {
    let conversation = this.journal.data.sessions[session]
    const fresh = !conversation
    if (!conversation) { conversation = { conversationId: randomUUID(), turns: {} }; this.journal.data.sessions[session] = conversation }
    const turn = { promptHash, conversationId: conversation.conversationId, status: "sending" as const }
    conversation.turns[message] = turn
    // Durable intent precedes side effects. A retry never re-executes a turn.
    await this.journal.save()
    try {
      const text = await this.backend.send({ prompt: fresh ? `${this.context}\n\n${prompt}` : prompt,
        conversationId: conversation.conversationId, fresh, signal })
      conversation.turns[message] = { ...turn, status: "complete", text }
      await this.journal.save(); return text
    } catch (error) {
      conversation.turns[message] = { ...turn, status: signal.aborted ? "interrupted" : "uncertain" }
      try { await this.journal.save() }
      finally { if (signal.aborted) await Promise.allSettled([this.backend.interrupt(conversation.conversationId), this.cancelTools()]) }
      throw error
    }
  }
  fetch: typeof fetch = async (input, init) => {
    let request: Request
    try { request = new Request(input, init) } catch { return responseError("Invalid provider request") }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") return responseError("Unsupported Notion provider endpoint", 404)
    try {
      const body = await request.json() as Record<string, any>
      const auxiliary = body.model === META_MODEL || AUXILIARY.has(request.headers.get(AGENT_HEADER) ?? "")
      if (body.model !== CHAT_MODEL && body.model !== META_MODEL) return responseError("Unknown Notion provider model")
      const prompt = newestText(body.messages)
      const session = request.headers.get(SESSION_HEADER) ?? ""
      const message = request.headers.get(MESSAGE_HEADER) ?? ""
      const valid = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id)
      if (!auxiliary && (!valid(session) || !valid(message))) return responseError("OpenCode session/message headers are missing or invalid. Use the supported plugin and OpenCode version")
      const abort = new AbortController(); const signal = AbortSignal.any([request.signal, abort.signal])
      // Metadata stays local, even if OpenCode explicitly uses the main model.
      const run = () => auxiliary ? Promise.resolve(prompt.trim().split(/\n/)[0].slice(0, 72) || "Notion conversation") : this.turn(session, message, prompt, signal)
      if (!body.stream) {
        const text = await run()
        return Response.json({ id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now()/1000), model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] })
      }
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now()/1000), encode = new TextEncoder(), self = this
      let heartbeat: ReturnType<typeof setInterval> | undefined, ended = false
      let controller: ReadableStreamDefaultController<Uint8Array>
      const send = (value: unknown) => { if (!ended) controller.enqueue(encode.encode(`data: ${JSON.stringify(value)}\n\n`)) }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c; send(chunk({ role: "assistant", content: "" }))
          heartbeat = setInterval(() => { if (!ended) c.enqueue(encode.encode(": waiting for Notion\n\n")) }, 10000)
          void run().then(text => {
            send(chunk({ content: text })); send(chunk({}, "stop"))
            if (!ended) { c.enqueue(encode.encode("data: [DONE]\n\n")); ended = true; c.close() }
          }, error => {
            send({ error: { message: self.redact(error instanceof Error ? error.message : String(error)), type: "notion_plugin_error" } })
            if (!ended) { ended = true; c.close() }
          }).finally(() => clearInterval(heartbeat))
        },
        cancel() { ended = true; clearInterval(heartbeat); abort.abort(new Error("OpenCode stopped the response")) },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
    } catch (error) { return responseError(this.redact(error instanceof Error ? error.message : String(error))) }
  }
  async close(): Promise<void> {
    this.closed = true; const busy = this.busy
    busy?.controller.abort(new Error("Plugin disposed"))
    if (busy) await busy.promise.catch(() => {})
  }
}
