#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { writeFile, access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runtime = resolve(process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(root, ".opencode-runtime"))
const pkg = join(runtime, "packages/opencode")
const config = join(pkg, ".mcp-toolbox/tsconfig.json")
// The filtered upstream install leaves two type-only imports unlinked in core.
// Point to the original SDK source and the exact typings in the frozen lock;
// do not patch upstream implementations or use any-typed declaration shims.
const mime = join(runtime, "node_modules/.bun/@types+mime-types@3.0.1/node_modules/@types/mime-types/index.d.ts")
await access(mime)
await writeFile(config, JSON.stringify({
  extends: join(pkg, "tsconfig.json"),
  include: [join(pkg, ".mcp-toolbox/*.ts"), join(pkg, "src/**/*.d.ts"), join(pkg, "sst-env.d.ts")],
  compilerOptions: { paths: {
    "@/*": [join(pkg, "src/*")],
    "@opencode-ai/sdk/v2/types": [join(runtime, "packages/sdk/js/src/v2/gen/types.gen.ts")],
    "mime-types": [mime],
  } },
}, null, 2))
const result = spawnSync(process.env.OPENCODE_MCP_BUN ?? "bun", ["run", "typecheck", "--project", config], { cwd: pkg, stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
