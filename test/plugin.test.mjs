import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Journal, exclusiveLock, mcpSecret, saveJson } from "../dist/plugin/storage.js"
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER, AGENT_HEADER } from "../dist/plugin/transport.js"
import { NotionBackend, notionConfig } from "../dist/plugin/notion.js"
import { settings, bundledBun } from "../dist/plugin/config.js"
import { registerConnection } from "../dist/plugin/runtime.js"
import plugin, { providerHooks } from "../dist/plugin.js"
async function fixture(t, send) {
  const dir = await mkdtemp(join(tmpdir(), "notion-plugin-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const calls = [], interrupts = []
  const backend = { send: async input => { calls.push(input); return send ? send(input) : `回答${calls.length}` }, interrupt: async id => { interrupts.push(id) } }
  const journal = new Journal(join(dir, "journal.json")); await journal.load()
  const transport = new NotionTransport(backend, journal, "execution context", text => text.replaceAll("SECRET", "[redacted]"))
  t.after(() => transport.close())
  return { dir, backend, journal, transport, calls, interrupts }
}
function request(transport, { session = "ses_a", message = "msg_a", prompt = "こんにちは", messages, stream = false, model = "chat", agent = "notion", signal } = {}) {
  return transport.fetch("https://opencode-notion.invalid/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", [SESSION_HEADER]: session, [MESSAGE_HEADER]: message, [AGENT_HEADER]: agent }, signal,
    body: JSON.stringify({ model, stream, messages: messages ?? [{ role: "user", content: prompt }] }) })
}
const answer = async response => (await response.json()).choices?.[0]?.message?.content

test("standard provider hooks retain UI and isolate execution", async t => {
  const f = await fixture(t), hooks = providerHooks(f.transport, () => f.transport.close()), config = { provider: { existing: { name: "Keep" } } }
  await hooks.config(config)
  assert.equal(config.provider.existing.name, "Keep"); assert.equal(config.model, "notion-ai/chat"); assert.equal(config.default_agent, "notion")
  assert.equal(config.small_model, "notion-ai/metadata"); assert.equal(config.compaction.auto, false)
  assert.equal(config.provider["notion-ai"].options.fetch, f.transport.fetch)
  assert.equal(config.provider["notion-ai"].models.chat.tool_call, false); assert.equal(config.agent.notion.tools["*"], false)
  assert.ok(!JSON.stringify(config).includes("token_v2"))
  const output = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "notion-ai" }, sessionID: "ses_1", agent: "notion", message: { id: "msg_1" } }, output)
  assert.equal(output.headers[SESSION_HEADER], "ses_1"); assert.equal(output.headers[MESSAGE_HEADER], "msg_1")
  const other = { headers: {} }; await hooks["chat.headers"]({ model: { providerID: "other" } }, other); assert.deepEqual(other.headers, {})
})
test("only newest input is sent; Notion thread survives provider restart", async t => {
  const f = await fixture(t); assert.equal(await answer(await request(f.transport)), "回答1")
  const id = f.calls[0].conversationId, second = new NotionTransport(f.backend, new Journal(f.journal.path), "execution context")
  await second.journal.load(); t.after(() => second.close())
  assert.equal(await answer(await request(second, { message: "msg_b", messages: [{ role: "user", content: "old" }, { role: "assistant", content: "old answer" }, { role: "user", content: "次の入力" }] })), "回答2")
  assert.equal(f.calls[0].fresh, true); assert.equal(f.calls[0].prompt, "execution context\n\nこんにちは")
  assert.equal(f.calls[1].fresh, false); assert.equal(f.calls[1].conversationId, id); assert.equal(f.calls[1].prompt, "次の入力")
  await request(second, { session: "ses_other", message: "msg_c" }); assert.notEqual(f.calls[2].conversationId, id)
  assert.equal((await stat(f.journal.path)).mode & 0o777, 0o600)
})
test("completed requests are idempotent, including after restart", async t => {
  const f = await fixture(t); await request(f.transport); await request(f.transport)
  const second = new NotionTransport(f.backend, new Journal(f.journal.path), "execution context")
  await second.journal.load(); t.after(() => second.close())
  assert.equal(await answer(await request(second)), "回答1"); assert.equal(f.calls.length, 1)
  assert.equal((await request(second, { prompt: "different" })).status, 400); assert.equal(f.calls.length, 1)
})
test("active duplicate joins one turn; other sessions cannot steal it", async t => {
  let release; const wait = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async () => { await wait; return "once" })
  const a = request(f.transport); await delay(10); const b = request(f.transport)
  assert.equal((await request(f.transport, { session: "ses_b", message: "msg_b" })).status, 400)
  assert.equal(await answer(await request(f.transport, { model: "metadata", session: "", message: "", prompt: "Local title" })), "Local title")
  release(); assert.equal(await answer(await a), "once"); assert.equal(await answer(await b), "once"); assert.equal(f.calls.length, 1)
})
test("uncertain dispatches fail closed rather than resending side effects", async t => {
  const f = await fixture(t, async () => { throw new Error("SECRET upstream failed after dispatch") })
  const first = await request(f.transport); assert.equal(first.status, 400); assert.ok(!(await first.text()).includes("SECRET"))
  assert.match(await (await request(f.transport)).text(), /not be automatically resent/); assert.equal(f.calls.length, 1)
})
test("streaming response has standard SSE framing and no tool-call output", async t => {
  const f = await fixture(t), response = await request(f.transport, { stream: true })
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const text = await response.text(); assert.match(text, /回答1/); assert.match(text, /"finish_reason":"stop"/); assert.match(text, /data: \[DONE\]/); assert.ok(!text.includes("tool_calls"))
})
test("stream cancellation interrupts Notion and prevents replay", async t => {
  const f = await fixture(t, async ({ signal }) => { await delay(60000, undefined, { signal }); return "never" })
  const response = await request(f.transport, { stream: true }), reader = response.body.getReader()
  await reader.read(); await delay(20); await reader.cancel(); await f.transport.close()
  assert.equal(f.interrupts.length, 1); assert.equal(f.journal.data.sessions.ses_a.turns.msg_a.status, "interrupted")
})
test("pre-aborted requests, bad IDs, attachments and endpoints do not send", async t => {
  const f = await fixture(t); await request(f.transport, { signal: AbortSignal.abort() }); await request(f.transport, { session: "__proto__" })
  await request(f.transport, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] })
  assert.equal((await f.transport.fetch("https://opencode-notion.invalid/other")).status, 404); assert.equal(f.calls.length, 0)
})
test("auxiliary agents never write to Notion even on the main model", async t => {
  const f = await fixture(t); for (const agent of ["title", "summary", "compaction"]) await request(f.transport, { agent }); assert.equal(f.calls.length, 0)
})
test("lock conflicts fail safely; release and secret persistence work", async t => {
  const f = await fixture(t), path = join(f.dir, "owner.lock"), release = await exclusiveLock(path)
  await assert.rejects(exclusiveLock(path), /Another plugin/); await release(); const again = await exclusiveLock(path); await again()
  const secretPath = join(f.dir, "secret.json"), secret = await mcpSecret(secretPath)
  assert.equal(await mcpSecret(secretPath), secret); assert.ok(secret.length >= 32); assert.equal((await stat(secretPath)).mode & 0o777, 0o600)
  await writeFile(f.journal.path, "{invalid"); await assert.rejects(new Journal(f.journal.path).load(), /refusing to silently reset/)
})
function manager() {
  const items = [], writes = []
  return { items, writes, list: async () => items, status: async () => ({ status: "connected" }),
    add: async input => { writes.push({ operation: "add", ...input }); const item = { ...input, id: randomUUID(), linked: true, enabledToolNames: null }; items.push(item); return item },
    update: async (id, changes) => { writes.push({ operation: "update", id, ...changes }); Object.assign(items.find(x => x.id === id), changes); return items.find(x => x.id === id) } }
}
test("registration is owned, idempotent, auto-allow and updates the URL", async t => {
  const f = await fixture(t), m = manager(), file = join(f.dir, "connection.json"), secret = "dedicated-secret"
  await registerConnection(m, "Owned", "https://example.com/mcp", secret, file)
  assert.equal(m.writes[0].runReadToolsAutomatically, true); assert.equal(m.writes[0].runWriteToolsAutomatically, true); assert.deepEqual(m.writes[0].auth, { type: "bearer", token: secret })
  await registerConnection(m, "Owned", "https://example.com/mcp", secret, file); assert.equal(m.writes.length, 1)
  await registerConnection(m, "Owned", "https://new.example.com/mcp", secret, file); assert.equal(m.items.length, 1); assert.equal(m.writes[1].operation, "update")
  assert.ok(!(await readFile(file, "utf8")).includes(secret))
})
test("registration refuses takeover or ambiguous ownership", async t => {
  const f = await fixture(t), m = manager(), file = join(f.dir, "connection.json")
  m.items.push({ id: "other", name: "Other", linked: true, serverUrl: "https://example.com/mcp" })
  await assert.rejects(registerConnection(m, "Owned", "https://example.com/mcp", "secret", file), /will not take over/)
  await saveJson(file, { id: "other" }); await assert.rejects(registerConnection(m, "Owned", "https://new.example.com/mcp", "secret", file), /ownership changed/); assert.equal(m.writes.length, 0)
})
test("settings use token_v2, require manual HTTPS and keep runtime outside root", async t => {
  const f = await fixture(t), root = join(f.dir, "workspace"); await mkdir(root)
  const opts = { publicUrl: "https://example.com/mcp", stateDir: join(f.dir, "state"), bun: process.execPath }
  const s = await settings(root, opts, { NOTION_TOKEN_V2: "test-cookie" })
  assert.equal(s.tokenV2, "test-cookie"); assert.equal(s.autoSetup, true); assert.equal(s.port, 8787); assert.ok(bundledBun().endsWith("/bin/bun"))
  await assert.rejects(settings(root, { ...opts, publicUrl: "http://localhost/mcp" }, { NOTION_TOKEN_V2: "cookie" }), /HTTPS/)
  await assert.rejects(settings(root, opts, {}), /NOTION_TOKEN_V2/)
  await assert.rejects(settings(root, { ...opts, stateDir: root }, { NOTION_TOKEN_V2: "cookie" }), /outside/)
})
test("real Notion client uses cookie, reuses thread and excludes hidden thinking", async t => {
  const f = await fixture(t), requests = [], s = { model: "default", tokenV2: "TEST_COOKIE", account: {} }, config = notionConfig(s, f.dir)
  config.account = { tokenV2: "TEST_COOKIE", userId: randomUUID(), userName: "Fixture", userEmail: "fixture@example.com", spaceId: randomUUID(), spaceName: "Test", spaceViewId: randomUUID(), timezone: "UTC" }
  const fetcher = async (url, init) => {
    assert.ok(String(url).endsWith("/runInferenceTranscript")); assert.match(new Headers(init.headers).get("cookie"), /token_v2=TEST_COOKIE/); requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ type: "agent-inference", id: "answer", finishedAt: 1, value: [{ type: "thinking", content: "HIDDEN" }, { type: "text", content: "visible" }] })+"\n", { headers: { "content-type": "application/x-ndjson" } })
  }
  const backend = new NotionBackend(config, fetcher), id = randomUUID()
  assert.equal(await backend.send({ prompt: "first", conversationId: id, fresh: true, signal: new AbortController().signal }), "visible")
  const reloaded = new NotionBackend(config, fetcher)
  assert.equal(await reloaded.send({ prompt: "second", conversationId: id, fresh: false, signal: new AbortController().signal }), "visible")
  assert.equal(requests.length, 2); assert.equal(requests[0].threadId, id); assert.equal(requests[1].threadId, id)
  assert.equal(requests[0].createThread, true); assert.equal(requests[1].createThread, false)
  assert.equal(requests[1].transcript.filter(step => step.type === "user").length, 1)
  assert.deepEqual(requests[1].transcript.find(step => step.type === "user").value, [["second"]]); assert.equal(config.maxWorkspaceRetries, 0); assert.equal(config.keepAwake.enabled, false)
})

test("failed setup keeps Notion selected instead of falling back to a local model", async t => {
  const f=await fixture(t),hooks=await plugin.server({directory:f.dir},{publicUrl:"http://invalid.example/mcp"}),config={}
  await hooks.config(config);assert.equal(config.model,"notion-ai/chat")
  const response=await config.provider["notion-ai"].options.fetch("https://opencode-notion.invalid/v1/chat/completions")
  assert.equal(response.status,400);assert.match(await response.text(),/HTTPS/);await hooks.dispose()
})
test("malformed credential JSON never echoes its contents", async t => {
  const f=await fixture(t),path=join(f.dir,"account.json");await writeFile(path,'{"token_v2":"DO_NOT_ECHO_SECRET",broken}')
  await assert.rejects(settings(f.dir,{publicUrl:"https://example.com/mcp",accountFile:path},{}),error=>error.message.includes("JSON format")&&!error.message.includes("DO_NOT_ECHO_SECRET"))
})
test("nested journal corruption is not accepted as a completed turn", async t => {
  const f=await fixture(t);await saveJson(f.journal.path,{version:1,sessions:{ses_x:{conversationId:"bad",turns:{msg_x:{status:"complete"}}}}})
  await assert.rejects(new Journal(f.journal.path).load(),/Corrupt/)
})
test("cancellation still interrupts and cancels tools after a journal persistence failure", async t => {
  const f=await fixture(t,async({signal})=>{await delay(60000,undefined,{signal});return "never"})
  let saves=0,cancels=0;const save=f.journal.save.bind(f.journal)
  f.journal.save=async()=>{if(++saves>1)throw new Error("disk unavailable");await save()}
  const transport=new NotionTransport(f.backend,f.journal,"context",text=>text,async()=>{cancels++})
  const response=await request(transport,{stream:true}),reader=response.body.getReader()
  await reader.read();await delay(20);await reader.cancel();await transport.close();assert.equal(f.interrupts.length,1);assert.equal(cancels,1)
})
test("owned policy repair does not reconnect or change unrelated records", async t => {
  const f=await fixture(t),m=manager(),file=join(f.dir,"connection.json")
  await registerConnection(m,"Owned","https://example.com/mcp","secret",file)
  m.items[0].runWriteToolsAutomatically=false;m.items[0].enabledToolNames=["read"]
  const other={id:"other",name:"Other",serverUrl:"https://other.example/mcp",linked:true,runWriteToolsAutomatically:false};m.items.push(other)
  await registerConnection(m,"Owned","https://example.com/mcp","secret",file)
  assert.equal(m.writes.length,2);assert.equal(m.writes[1].auth,undefined);assert.equal(m.items[0].runWriteToolsAutomatically,true);assert.equal(m.items[0].enabledToolNames,null);assert.equal(other.runWriteToolsAutomatically,false)
})
