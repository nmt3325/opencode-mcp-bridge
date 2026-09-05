import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { JobView } from "./protocol.js"

export function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError }
}
export function jobResult(job: JobView): CallToolResult {
  const response = jsonResult({ ...job }, job.status === "failed" || job.status === "cancelled")
  // Forward upstream image/PDF attachments instead of silently discarding them.
  for (const [index, attachment] of (job.result?.attachments ?? []).entries()) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(attachment.url)
    if (!match) continue
    const mimeType = match[1]!
    const data = match[2]!.replace(/[\r\n]/g, "")
    if (mimeType.startsWith("image/")) response.content.push({ type: "image", data, mimeType })
    else response.content.push({ type: "resource", resource: { uri: `opencode-mcp://attachment/${job.job_id}/${index}`, mimeType, blob: data } })
  }
  return response
}
export function errorResult(error: unknown): CallToolResult {
  return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true)
}
