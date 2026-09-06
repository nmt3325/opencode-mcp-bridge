import assert from "node:assert/strict"
import {mkdtemp,mkdir,writeFile,readdir,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join,resolve} from "node:path"
import {pathToFileURL} from "node:url"
import {execFile} from "node:child_process"
import {promisify} from "node:util"
import {createServer} from "node:http"
import {randomUUID} from "node:crypto"
const execute=promisify(execFile),project=resolve(import.meta.dirname,".."),temp=await mkdtemp(join(tmpdir(),"notion-package-smoke-"))
let runtime
async function run(file,args,cwd){const pending=execute(file,args,{cwd,timeout:15*60*1000,maxBuffer:4*1024*1024});pending.child.stdin.end();return pending}
try {
 await run("npm",["pack","--pack-destination",temp],project)
 const archive=(await readdir(temp)).find(file=>file.endsWith(".tgz"));assert.ok(archive)
 const consumer=join(temp,"consumer");await mkdir(consumer)
 await run("npm",["install","--ignore-scripts","--omit=dev",join(temp,archive)],consumer)
 const installed=join(consumer,"node_modules/opencode-mcp-bridge"),entry=await import(pathToFileURL(join(installed,"dist/plugin.js")))
 assert.equal(entry.default.id,"opencode-notion-bridge");assert.equal(typeof entry.default.server,"function")
 const {bundledBun}=await import(pathToFileURL(join(installed,"dist/plugin/config.js")))
 assert.equal((await run(bundledBun(),["--version"],consumer)).stdout.trim(),"1.3.14")
 const {startRuntime}=await import(pathToFileURL(join(installed,"dist/plugin/runtime.js")))
 const root=join(temp,"workspace"),accountFile=join(temp,"account.json");await mkdir(root);await writeFile(accountFile,JSON.stringify({token_v2:"fixture-cookie"}),{mode:0o600})
 const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));const port=listener.address().port;await new Promise(r=>listener.close(r))
 const account={tokenV2:"fixture-cookie",userId:randomUUID(),spaceId:randomUUID(),spaceViewId:randomUUID(),userName:"Fixture",userEmail:"fixture@example.com",spaceName:"Fixture"},records=[]
 const backend=()=>({withTimeout:async(_ms,action)=>action(),client:{account:async()=>account,mcp:()=>({list:async()=>records,add:async input=>{assert.equal(input.runWriteToolsAutomatically,true);const item={...input,id:randomUUID(),linked:true};records.push(item);return item}})},send:async()=>"package reply",interrupt:async()=>{}})
 // A fresh runtime exercises automatic setup from packaged code, not postinstall.
 runtime=await startRuntime(root,{publicUrl:"https://manual-endpoint.example/mcp",accountFile,stateDir:join(temp,"state"),runtimeDir:join(temp,"fresh-runtime"),port},backend)
 assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);assert.equal(records.length,1)
 const response=await runtime.transport.fetch("https://opencode-notion.invalid/v1/chat/completions",{method:"POST",headers:{"x-opencode-notion-session":"ses_package","x-opencode-notion-message":"msg_package"},body:JSON.stringify({model:"chat",messages:[{role:"user",content:"package check"}]})})
 assert.equal((await response.json()).choices[0].message.content,"package reply");await runtime.close();runtime=undefined
 console.log("PASS: packed plugin, ignore-scripts production install, bundled Bun, automatic native setup, MCP startup and shutdown")
} finally {await runtime?.close();await rm(temp,{recursive:true,force:true})}
