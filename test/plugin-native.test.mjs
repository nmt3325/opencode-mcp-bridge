import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startRuntime } from "../dist/plugin/runtime.js"
import { SESSION_HEADER, MESSAGE_HEADER } from "../dist/plugin/transport.js"
const runtimeDir = process.env.OPENCODE_MCP_RUNTIME_DIR ?? resolve(".opencode-runtime")
const require = createRequire(join(runtimeDir, "packages/opencode/package.json"))
const { createOpenAICompatible } = await import(pathToFileURL(require.resolve("@ai-sdk/openai-compatible")))
const { streamText } = await import(pathToFileURL(require.resolve("ai")))
async function freePort() {
  const s=createServer(); await new Promise(r=>s.listen(0,"127.0.0.1",r)); const port=s.address().port; await new Promise(r=>s.close(r)); return port
}
test("plugin startup → SDK → simulated Notion → real HTTP MCP → native edits, without approvals", async t => {
  const temp=await mkdtemp(join(tmpdir(),"notion-native-integration-")), root=join(temp,"workspace"), port=await freePort()
  await mkdir(root); let runtime, mcp
  t.after(async()=>{ await mcp?.close(); await runtime?.close(); await rm(temp,{recursive:true,force:true}) })
  const account={tokenV2:"fixture-cookie", userId:randomUUID(), userName:"Fixture", userEmail:"fixture@example.com", spaceId:randomUUID(), spaceName:"Fixture", spaceViewId:randomUUID()}
  const accountFile=join(temp,"account.json"); await writeFile(accountFile,JSON.stringify({token_v2:"fixture-cookie"}),{mode:0o600})
  const records=[], changes=[], calls=[]
  const manager={list:async()=>records,status:async()=>({status:"connected"}),
    add:async input=>{const record={...input,id:randomUUID(),linked:true,enabledToolNames:null};records.push(record);changes.push(input);return record},
    update:async(id,input)=>{changes.push(input);Object.assign(records.find(x=>x.id===id),input);return records.find(x=>x.id===id)}}
  async function tool(name,args){
    const unpack=result=>result.structuredContent ?? JSON.parse(result.content.find(x=>x.type==="text").text)
    let job=unpack(await mcp.callTool({name,arguments:args}))
    for(let i=0;i<30&&job.status==="running";i++) job=unpack(await mcp.callTool({name:"opencode_job_result",arguments:{job_id:job.job_id,wait_seconds:1}}))
    assert.equal(job.status,"completed",JSON.stringify(job));return job
  }
  const factory=()=>({withTimeout:async(_ms,action)=>action(),client:{account:async()=>account,mcp:()=>manager},interrupt:async()=>{},send:async input=>{
    calls.push(input)
    if(calls.length===1) await tool("write",{filePath:join(root,"result.txt"),content:"version one\n"})
    else {await tool("read",{filePath:join(root,"result.txt")});await tool("edit",{filePath:join(root,"result.txt"),oldString:"version one",newString:"version two"})}
    await tool("bash",{command:"test -z \"$NOTION_TOKEN_V2\" && printf x >> counter.txt",description:"Verify worker isolation and record one execution",timeout:10000})
    return "Notion fixture completed the edit"
  }})
  const options={publicUrl:"https://manual-endpoint.example/mcp",accountFile,stateDir:join(temp,"state"),runtimeDir,port,autoSetup:false}
  runtime=await startRuntime(root,options,factory)
  assert.equal(changes.length,1);assert.equal(changes[0].runWriteToolsAutomatically,true);assert.equal(changes[0].runReadToolsAutomatically,true)
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`)).status,401)
  mcp=new Client({name:"simulated-notion",version:"1"})
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${changes[0].auth.token}`}}}))
  const provider=createOpenAICompatible({name:"notion-ai",baseURL:"https://opencode-notion.invalid/v1",fetch:runtime.transport.fetch,includeUsage:false})
  async function chat(message,prompt){const result=streamText({model:provider.chatModel("chat"),prompt,headers:{[SESSION_HEADER]:"ses_real",[MESSAGE_HEADER]:message},maxRetries:0});assert.equal(await result.text,"Notion fixture completed the edit");assert.equal(await result.finishReason,"stop")}
  await chat("msg_one","create file");assert.equal(await readFile(join(root,"result.txt"),"utf8"),"version one\n")
  await chat("msg_two","edit file");assert.equal(await readFile(join(root,"result.txt"),"utf8"),"version two\n")
  await chat("msg_two","edit file");assert.equal(await readFile(join(root,"counter.txt"),"utf8"),"xx")
  assert.equal(calls.length,2);assert.equal(calls[0].conversationId,calls[1].conversationId)
  await mcp.close();mcp=undefined;await runtime.close();await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`))
  runtime=await startRuntime(root,options,factory);assert.equal(changes.length,1)
  const response=await runtime.transport.fetch("https://opencode-notion.invalid/v1/chat/completions",{method:"POST",headers:{[SESSION_HEADER]:"ses_real",[MESSAGE_HEADER]:"msg_two"},body:JSON.stringify({model:"chat",messages:[{role:"user",content:"edit file"}]})})
  assert.equal((await response.json()).choices[0].message.content,"Notion fixture completed the edit");assert.equal(calls.length,2)
})
