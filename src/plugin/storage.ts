import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { readFileSync, unlinkSync } from "node:fs"
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o077)) throw new Error("Plugin state directory must have mode 0700")
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw new Error("Cannot read plugin state; refusing to silently reset conversation mappings") }
}
export async function saveJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path))
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, "wx", 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  try { await rename(temp, path) } catch (error) { await unlink(temp).catch(() => {}); throw error }
}
export async function exclusiveLock(path: string): Promise<() => Promise<void>> {
  await privateDirectory(dirname(path))
  const nonce = randomUUID()
  // Never unlink a competing lock: a live owner may still be writing it.
  let file
  try { file = await open(path, "wx", 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another plugin owns this workspace/endpoint. If it crashed, verify that no OpenCode process is running before removing the lock: ${path}`)
    throw error
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })) } finally { await file.close() }
  // Some hosts call process.exit rather than awaiting dispose. SIGKILL and
  // power-loss locks intentionally require inspection, never automatic theft.
  const onExit = () => { try { if (JSON.parse(readFileSync(path, "utf8")).nonce === nonce) unlinkSync(path) } catch {} }
  process.once("exit", onExit)
  return async () => { try { const owner = await readJson<{ nonce?: string }>(path, {}); if (owner.nonce === nonce) await unlink(path) } finally { process.off("exit", onExit) } }
}
export async function mcpSecret(path: string): Promise<string> {
  let value = await readJson<{ token?: string }>(path, {})
  if (!value.token) { value = { token: randomBytes(32).toString("hex") }; await saveJson(path, value) }
  if (typeof value.token !== "string" || value.token.length < 32) throw new Error("Invalid execution MCP credential")
  return value.token
}
export interface Turn { promptHash: string; conversationId: string; status: "sending" | "complete" | "uncertain" | "interrupted"; text?: string }
export interface ConversationState { conversationId: string; turns: Record<string, Turn> }
export interface JournalData { version: 1; sessions: Record<string, ConversationState> }
export class Journal {
  data: JournalData = { version: 1, sessions: {} }
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    const data = await readJson<JournalData>(this.path, this.data)
    if (!data || data.version !== 1 || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) throw new Error("Unsupported conversation journal")
    const validId = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !["__proto__", "prototype", "constructor"].includes(id)
    const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
    for (const [id, session] of Object.entries(data.sessions)) {
      if (!validId(id) || !record(session) || typeof session.conversationId !== "string" || !record(session.turns)) throw new Error("Corrupt conversation journal")
      for (const [message, turn] of Object.entries(session.turns)) {
        if (!validId(message) || !record(turn) || turn.conversationId !== session.conversationId || typeof turn.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(turn.promptHash) || !["sending", "complete", "uncertain", "interrupted"].includes(String(turn.status)) || (turn.status === "complete" && typeof turn.text !== "string")) throw new Error("Corrupt conversation turn")
      }
    }
    this.data = data
  }
  async save(): Promise<void> { await saveJson(this.path, this.data) }
}
