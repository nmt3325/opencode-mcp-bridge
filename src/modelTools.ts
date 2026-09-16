import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { NativeTool } from "./protocol.js"
import { NATIVE_TOOL_IDS } from "./config.js"

// Descriptions AND schemas come from the extracted tool definitions.
// This module contains no filesystem, replacement, regex, HTTP-fetch or shell
// implementation. There is no external OpenCode runtime or fallback.
export function nativeCatalog(tools: NativeTool[]): Tool[] {
  const allowed = new Set<string>(NATIVE_TOOL_IDS)
  if (tools.length !== allowed.size || new Set(tools.map((tool) => tool.name)).size !== allowed.size || tools.some((tool) => !allowed.has(tool.name))) {
    throw new Error("Native tool catalog does not match the pinned execution-only allowlist")
  }
  return tools.map((tool) => ({
    ...tool,
    annotations: {
      readOnlyHint: ["read", "glob", "grep", "webfetch"].includes(tool.name),
      destructiveHint: ["write", "edit", "apply_patch", "bash"].includes(tool.name),
      idempotentHint: ["read", "glob", "grep"].includes(tool.name),
      openWorldHint: ["bash", "webfetch"].includes(tool.name),
    },
  }))
}
