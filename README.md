# OpenCode Notion chat plugin + MCP execution toolbox

**The execution side of this bridge is exclusively a toolbox.** Notion AI (or another MCP client) handles reasoning and planning. The bridge runs tools; it does not ask another LLM to do the work. There is no agent/delegation mode or legacy execution fallback.

```text
Notion AI → MCP (stdio / Streamable HTTP) → private Bun worker → actual OpenCode tools
```

## Notion AI in the standard OpenCode chat UI (new)

One plugin bundles the Notion provider and the execution MCP. It authenticates with a locally supplied `token_v2`, starts/stops the MCP, registers/reuses its own Notion connection, and displays replies in the unchanged OpenCode chat UI. Notion owns reasoning; the native toolbox owns file execution. The plugin uses fixed all-allow execution while preserving authentication and native path checks.

**[日本語の導入手順・制限](docs/plugin.md)** · **[Live validation](docs/validation.md)**

The public HTTPS endpoint is still user-configured. Normal OpenCode session history remains local, with a persistent Notion conversation mapping. The existing standalone CLI and its default approval behavior remain available below.

## What is native, and what belongs to the bridge?

The worker imports `ReadTool`, `WriteTool`, `EditTool`, `GlobTool`, `GrepTool`, `ShellTool`, `WebFetchTool`, and `TodoWriteTool` from the **unchanged, pinned OpenCode source checkout**. It initializes them with `Tool.init`, exports their descriptions/input schemas with `ToolJsonSchema.fromTool`, and calls their native `execute` implementations.

File reading, writing, replacement, ripgrep search, globbing, shell execution, HTML conversion, native truncation, and TODO storage are **not reimplemented here**. The bridge only supplies the execution context, transport, job lifecycle, path checks, and permission confirmation transport. Native permission matching uses OpenCode's `Permission.fromConfig/merge/evaluate`.

The worker has a fixed non-inference execution profile and fixed configuration/plugin services. It does not initialize model/provider discovery, user/project plugins, MCP clients, agent generation, `LLM`, or `SessionPrompt`. A startup dependency-graph check rejects inference-capable services. A native session and native session projector provide the real storage context needed by file timestamps and TODOs; that is bookkeeping, not a model conversation.

Pinned upstream: **OpenCode v1.18.29**, commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a`, **Bun 1.3.14**. Internal APIs are not a stable upstream public execution API, so upgrades must be intentional and retested.

## Standalone toolbox installation

Requirements: Node.js 22+, npm, Git, and **Bun 1.3.14**. Linux is the verified platform. A standalone `opencode` executable does not expose the internal modules and is not sufficient.

```sh
npm ci
npm run build
# Install Bun 1.3.14 beforehand, then:
npm run setup:native
```

Setup clones the pinned upstream source to `.opencode-runtime`, installs its frozen workspace dependencies with lifecycle scripts disabled, and copies only this repository's small adapter into an untracked `.mcp-toolbox` directory. It does not modify upstream tool implementations. It refuses an existing checkout at a different commit or with tracked modifications.

At startup the bridge checks the Bun version, upstream Git commit, clean tracked source, and adapter hashes. Missing or incompatible runtime is an error, never a fallback to an agent or local replacement implementation. Keep the runtime and state directories **outside the editable workspace**. Install the runtime under the service user's ownership so Git's ownership checks succeed.

```sh
export OPENCODE_MCP_ROOT=/absolute/path/to/workspace
# Optional: defaults to .opencode-runtime beside this package
export OPENCODE_MCP_RUNTIME_DIR=/absolute/path/to/pinned-opencode
# Optional: override the Bun executable
export OPENCODE_MCP_BUN=/absolute/path/to/bun
npm start
```

For HTTP:

```sh
export OPENCODE_MCP_TOKEN='<a strong random token of at least 24 characters>'
npm run start:http
```

Connect the client to `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <token>` (or `x-mcp-token`). Authentication is required even on loopback. `/healthz` contains only health/mode/version. Browser Origin requests are rejected. For remote Notion connections, deploy behind HTTPS and configure authentication in Notion's connection UI; never paste secrets into prompts. Standalone mode does not deploy or register an endpoint automatically. The plugin manages its own connection but still requires user-provided public HTTPS.

## Tools

Native names: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `webfetch`, `todowrite`.

Their schemas come directly from the running pinned upstream tools. Do not use the old mirrored schemas. For example, native `bash` requires `command` (not a bridge-specific `description`); `read` uses one-based `offset`; `todowrite` entries use `content`, `status`, and `priority`.

Control tools:

| Tool | Purpose |
| --- | --- |
| `opencode_native_info` | Runtime pin, toolbox purpose, available native tools |
| `opencode_job_list` | Bounded job summaries |
| `opencode_job_result` | Retrieve a job; optionally wait up to 50 seconds |
| `opencode_job_cancel` | Cancel a pending/running job |
| `opencode_permissions_pending` | Outstanding native permission requests |
| `opencode_permission_reply` | Approve once or reject a specific job/request pair |

No `opencode_start`, agent-session management, prompt/message/command forwarding, `task`, question workflow, MCP sampling, or legacy `opencode_shell*` route is exposed. Unknown names fail without starting work.

## Permissions and jobs

Default policy allows `read` (with `.env`-style reads requiring confirmation), `glob`, `grep`, and `todowrite`. `write`/`edit`, `bash`, and `webfetch` require a decision. Native write/edit request the `edit` permission. External-directory, task, and question permissions are permanently denied. An operator may supply explicit native permission rules using `OPENCODE_MCP_PERMISSIONS`; there is no automatic blanket approval.

A call returns a structured job with `job_id` and one of `running`, `awaiting_permission`, `cancelling`, `completed`, `failed`, or `cancelled`. Keep that ID instead of repeating the original operation. When awaiting permission, display the native request and use `opencode_permission_reply` with `job_id`, `permission_id`, and `reply: "once"` or `"reject"`. Approval is limited to that request; rejecting one job does not reject another.

A bounded wait returning `running` is **not cancellation**. Poll `opencode_job_result` for the same job. Explicit cancellation and job deadlines propagate to native execution. There are no automatic retries, worker restarts, or duplicate command fallbacks. Native shell exit status is in `result.metadata.exit`; a completed execution can have a nonzero command exit code.

Native output/metadata/diffs and data-URL attachments are preserved. If native truncation returns `metadata.outputPath`, `read` can follow that exact registered output file; this does not grant access to the rest of private state. Image attachments are forwarded as MCP images and other data-URL attachments as resources.

One bridge process serves one workspace and one authenticated principal. HTTP transport reconnection does not lose jobs because the native worker belongs to the bridge, not an HTTP transport session. Job/results are bounded, in-memory, and lost on bridge restart. Native TODO state uses an OpenCode session in private SQLite storage; a new bridge process creates a new execution session.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `OPENCODE_MCP_ROOT` | Required, explicit workspace root; filesystem root is refused |
| `OPENCODE_MCP_RUNTIME_DIR` | Package-local `.opencode-runtime` |
| `OPENCODE_MCP_STATE_DIR` | Private per-root directory under `~/.local/state/opencode-mcp-bridge` |
| `OPENCODE_MCP_BUN` | `bun` |
| `OPENCODE_MCP_HOST` / `OPENCODE_MCP_PORT` | `127.0.0.1` / `8787` |
| `OPENCODE_MCP_TOKEN` | Required for HTTP, at least 24 characters |
| `OPENCODE_MCP_WAIT_MAX_SECONDS` | 45; allowed 0–50 |
| `OPENCODE_MCP_JOB_TIMEOUT_SECONDS` | 600; allowed 5–3600 |
| `OPENCODE_MCP_MAX_JOBS` | 64; allowed 8–256 |
| `OPENCODE_MCP_MAX_CONCURRENT` | 8; allowed 1–32, not greater than MAX_JOBS |
| `OPENCODE_MCP_PERMISSIONS` | JSON native permission rules |
| `OPENCODE_MCP_LSP` / `OPENCODE_MCP_FORMATTER` | `false`; explicit opt-in for native services |

`OPENCODE_MCP_DEFAULT_DIRECTORY` remains only as a root alias. `OPENCODE_BASE_URL`, server/API-token credentials, default model/agent selection, and shell-backend selection are rejected rather than silently used. `--base-url` / `--opencode` CLI options are removed. See `node dist/index.js --help`.

## Security boundaries

This executes real code and **is not an OS sandbox**. Canonical path checks reject direct traversal and symlink escapes, but cannot make arbitrary shell commands safe or prevent all filesystem races/hardlink/proc access. Search/read permissions are not a comprehensive secret scanner. Run in a dedicated container/VM with a dedicated OS identity, appropriate mounts, resource limits, and network policy. Do not mount production credentials.

The worker receives its own HOME/XDG directories and a small environment allowlist, not model keys, MCP tokens, SSH agents, or other parent secrets. Environment scrubbing is defense in depth, not isolation from other processes running under the same OS user. One shared token is one principal, not multi-tenant access control.

File/web content is untrusted data, not instructions to the client. The bridge itself never delegates to a model, but an explicitly authorized arbitrary shell command can of course run another program or make network requests. LSP/formatter opt-ins can also launch local tools; defaults are off and were used for the integration verification.

## Verification

```sh
npm run build
npm run setup:native
npm test
npm run typecheck:native
```

The native integration suite executes real upstream tools on temporary files (not an emulated OpenCode REST server), including MCP stdio and HTTP, permissions, cancellation/timeouts, native TODO database persistence, Unicode, image forwarding, truncation continuation, root/symlink rejection, and disabled delegation/config/plugin/model paths. It includes model-sampling and local provider canaries. Separate unit tests exercise bridge IPC failure/acknowledgement handling. Linux network-isolated verification can additionally run the suite with loopback only and a preinstalled/cached `rg` on PATH.

This is a breaking replacement of v0.1: no `opencode serve` process, model API key, or agent prompt route is needed. Merging/deploying this change is separate from creating a PR.
