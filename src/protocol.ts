import type { Tool } from "@modelcontextprotocol/sdk/types.js"
export type NativeTool = Pick<Tool, "name" | "description" | "inputSchema">
export interface NativeResult {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: Array<{ type: "file"; mime: string; url: string; filename?: string }>
}
// There is no awaiting_permission state: execution is never gated on a reply.
export type JobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled"
export interface JobView {
  job_id: string
  tool: string
  status: JobStatus
  created_at: string
  updated_at: string
  result?: NativeResult
  progress?: { title?: string; metadata?: Record<string, unknown> }
  error?: string
}
export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}
