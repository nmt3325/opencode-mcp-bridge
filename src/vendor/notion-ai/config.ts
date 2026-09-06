import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountContext } from "./types.js";
import { defaultStateFilePath } from "./chat-jobs.js";
import { DEFAULT_CONFIRM_GRACE_MS, DEFAULT_STEP_LIMIT_STEPS, DEFAULT_CONTINUE_COOLDOWN_MS, DEFAULT_MAX_CONTINUES, parseConfirmationPatterns, type KeepAwakeDefaults } from "./keep-awake.js";

export interface NotionConfig {
  apiBase: string;
  defaultModel: string;
  requestTimeoutMs: number;
  account: Partial<AccountContext> & Pick<AccountContext, "tokenV2">;
  accountFilePath?: string|undefined;
  maxWorkspaceRetries?: number;
  mcpRegistryPath?: string | undefined;
  attachmentRoot?: string | undefined;
  maxAttachmentBytes?: number | undefined;
  /** Resume cache for background chat jobs and chat sessions. Undefined disables persistence. */
  stateFilePath?: string | undefined;
  /** How long notion_ai_chat waits inline before it hands back a pending job (MCP clients abandon a call after ~60s). */
  chatWaitMs?: number | undefined;
  /** Allow rebuilding a chat session for a conversation this process never started. */
  allowSessionRehydrate?: boolean | undefined;
  /** Web search for a new chat when the caller does not pass webSearch. */
  defaultWebSearch: boolean;
  /** Workspace search for a new chat when the caller does not pass workspaceSearch. */
  defaultWorkspaceSearch: boolean;
  /** Ask/read-only mode for a new chat when the caller does not pass readOnly. */
  defaultReadOnly: boolean;
  /** Registry of keep-awake watchdogs. Undefined disables persistence. */
  keepAliveFilePath?: string | undefined;
  /** Defaults for keep_me_awake. */
  keepAwake: KeepAwakeDefaults;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean such as 1/0, true/false, on/off`);
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be a safe integer between ${min} and ${max}`);
  return value;
}

function accountFile(): { path: string; data: Record<string, unknown> } {
  const path = optional("NOTION_ACCOUNT_FILE");
  if (!path) return { path: "", data: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    // switch_workspace(pin) creates this file lazily, so a path that does not exist yet is not a startup failure.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { path, data: {} };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read NOTION_ACCOUNT_FILE: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NOTION_ACCOUNT_FILE must contain a JSON object");
  return { path, data: parsed as Record<string, unknown> };
}

function fileString(file: Record<string, unknown>, key: string): string { const value = file[key]; return typeof value === "string" ? value.trim() : ""; }

export function loadConfig(): NotionConfig {
  const { path: accountPath, data: file } = accountFile();
  const timeout = Number(optional("NOTION_REQUEST_TIMEOUT_MS", "300000"));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("NOTION_REQUEST_TIMEOUT_MS must be a positive number");
  const tokenV2 = optional("NOTION_TOKEN_V2", fileString(file, "token_v2"));
  if (!tokenV2) throw new Error("NOTION_TOKEN_V2 or NOTION_ACCOUNT_FILE with token_v2 is required");
  const fullCookie = optional("NOTION_FULL_COOKIE", fileString(file, "full_cookie"));
  const pinnedSpaceId = optional("NOTION_PINNED_SPACE_ID", fileString(file, "pinned_space_id"));
  const maxRetries = Number(optional("NOTION_MAX_WORKSPACE_RETRIES", "5"));
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("NOTION_MAX_WORKSPACE_RETRIES must be a non-negative safe integer");
  }
  const chatWaitMs = Number(optional("NOTION_CHAT_WAIT_MS", "45000"));
  // 60s is the point where MCP clients give up, so the inline wait has to stay below it.
  if (!Number.isSafeInteger(chatWaitMs) || chatWaitMs < 1000 || chatWaitMs > 55000) throw new Error("NOTION_CHAT_WAIT_MS must be a safe integer between 1000 and 55000");
  const stateFile = optional("NOTION_STATE_FILE", defaultStateFilePath());
  const persistState = !["off", "none", "0", "false", "disabled"].includes(stateFile.toLowerCase());
  const rehydrate = optional("NOTION_SESSION_REHYDRATE", "1").toLowerCase();
  const maxAttachmentBytes = Number(optional("NOTION_MAX_ATTACHMENT_BYTES", String(20 * 1024 * 1024)));
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes <= 0) throw new Error("NOTION_MAX_ATTACHMENT_BYTES must be a positive safe integer");
  const keepAwake = {
    // A healthy turn goes quiet for 10-20s between steps, so the floor is a minute: anything shorter
    // reports stalls that are really just a slow tool call.
    idleMs: integer("NOTION_KEEP_AWAKE_IDLE_MS", 120_000, 60_000, 900_000),
    pollMs: integer("NOTION_KEEP_AWAKE_POLL_MS", 30_000, 5_000, 300_000),
    cooldownMs: integer("NOTION_KEEP_AWAKE_COOLDOWN_MS", 60_000, 0, 1_800_000),
    // Every nudge is a real turn and costs credits, so the budget and the deadline are not optional.
    maxNudges: integer("NOTION_KEEP_AWAKE_MAX_NUDGES", 40, 1, 500),
    deadlineMs: integer("NOTION_KEEP_AWAKE_DEADLINE_MS", 3 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    enabled: flag("NOTION_KEEP_AWAKE", true),
    interrupt: flag("NOTION_KEEP_AWAKE_INTERRUPT", true),
    // Notion pauses a long agent turn with "This task is taking a lot of steps" and waits for a
    // Continue click. Answering it is the same continuation the watchdog already does for a dead
    // turn, so it is on by default and capped separately from nudges.
    autoContinue: flag("NOTION_KEEP_AWAKE_AUTO_CONTINUE", true),
    maxContinues: integer("NOTION_KEEP_AWAKE_MAX_CONTINUES", DEFAULT_MAX_CONTINUES, 0, 100),
    continueCooldownMs: integer("NOTION_KEEP_AWAKE_CONTINUE_COOLDOWN_MS", DEFAULT_CONTINUE_COOLDOWN_MS, 0, 600_000),
    confirmGraceMs: integer("NOTION_KEEP_AWAKE_CONFIRM_GRACE_MS", DEFAULT_CONFIRM_GRACE_MS, 0, 600_000),
    continuePatterns: parseConfirmationPatterns(process.env.NOTION_KEEP_AWAKE_CONTINUE_PATTERNS),
    // The step-limit stop closes the turn as completed, so the step count is what separates it from
    // a turn that died early: on a live thread the prompt landed at 2992 steps.
    stepLimitSteps: integer("NOTION_KEEP_AWAKE_STEP_LIMIT_STEPS", DEFAULT_STEP_LIMIT_STEPS, 1, 1_000_000)
  };
  return {
    apiBase: optional("NOTION_API_BASE", "https://www.notion.so/api/v3").replace(/\/$/, ""),
    defaultModel: optional("NOTION_DEFAULT_MODEL", "almond-croissant-low"),
    requestTimeoutMs: timeout,
    accountFilePath: accountPath || undefined,
    mcpRegistryPath: optional("NOTION_MCP_REGISTRY_FILE") || undefined,
    attachmentRoot: optional("NOTION_ATTACHMENT_ROOT", process.cwd()),
    maxAttachmentBytes,
    maxWorkspaceRetries: maxRetries,
    chatWaitMs,
    allowSessionRehydrate: !["0", "false", "off", "no"].includes(rehydrate),
    // A chat started through MCP used to be web-off and Ask-only, unlike the same chat in the Notion app.
    defaultWebSearch: flag("NOTION_DEFAULT_WEB_SEARCH", true),
    defaultWorkspaceSearch: flag("NOTION_DEFAULT_WORKSPACE_SEARCH", true),
    defaultReadOnly: flag("NOTION_DEFAULT_READ_ONLY", false),
    keepAwake,
    ...(persistState && stateFile ? { stateFilePath: stateFile, keepAliveFilePath: join(dirname(stateFile), "keep-alives.json") } : {}),
    account: {
      tokenV2,
      userId: optional("NOTION_USER_ID", fileString(file, "user_id")),
      userName: optional("NOTION_USER_NAME", fileString(file, "user_name")),
      userEmail: optional("NOTION_USER_EMAIL", fileString(file, "user_email")),
      spaceId: optional("NOTION_SPACE_ID", fileString(file, "space_id")),
      spaceName: optional("NOTION_SPACE_NAME", fileString(file, "space_name")),
      spaceViewId: optional("NOTION_SPACE_VIEW_ID", fileString(file, "space_view_id")),
      timezone: optional("NOTION_TIMEZONE", fileString(file, "timezone") || "UTC"),
      clientVersion: optional("NOTION_CLIENT_VERSION", fileString(file, "client_version") || "23.13.20260313.1423"),
      browserId: optional("NOTION_BROWSER_ID", fileString(file, "browser_id") || randomUUID()),
      deviceId: optional("NOTION_DEVICE_ID", fileString(file, "device_id") || randomUUID()),
      ...(fullCookie ? { fullCookie } : {}),
      ...(pinnedSpaceId ? { pinnedSpaceId } : {})
    }
  };
}
