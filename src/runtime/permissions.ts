import type { PermissionConfig } from "../config.js"
import { Wildcard } from "../vendor/opencode/wildcard.js"
type Action = "allow" | "ask" | "deny"
const defaults: PermissionConfig = {
  "*": "deny", read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  glob: "allow", grep: "allow", todowrite: "allow", edit: "ask", bash: "ask", webfetch: "ask",
}
export function decision(permission: string, pattern: string, overrides: PermissionConfig): Action {
  if (["external_directory", "task", "question"].includes(permission)) return "deny"
  let result: Action = "deny"
  for (const config of [defaults, overrides]) for (const [name, rule] of Object.entries(config)) {
    if (!Wildcard.match(permission, name)) continue
    if (typeof rule === "string") result = rule
    else for (const [match, action] of Object.entries(rule)) if (Wildcard.match(pattern, match)) result = action
  }
  // Without OpenCode's tree-sitter application pipeline, never silently treat a
  // compound command as one harmless prefix. Only explicit blanket shell allow
  // can bypass confirmation for shell syntax; object/pattern rules ask again.
  if (permission === "bash" && result === "allow" && /[;&|<>\n\r`$(){}]/.test(pattern) && overrides.bash !== "allow") return "ask"
  return result
}
