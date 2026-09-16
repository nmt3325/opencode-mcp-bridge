// Pre-execution approval was removed in 0.4.0: a call from an authenticated
// client runs immediately. What remains is a fixed deny list for capabilities
// this toolbox does not implement, so an extracted tool can never negotiate a
// way out of the workspace or reach a delegation path.
export const DENIED = ["external_directory", "task", "question"] as const
export function denied(permission: string): boolean {
  return (DENIED as readonly string[]).includes(permission)
}
