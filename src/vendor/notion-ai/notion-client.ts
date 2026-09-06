import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { isIP } from "node:net";
import type { FinalStepShape, AccountContext, AgentUploadedFile, AttachmentDownloadResult, AttachmentUploadResult, ChatAttachment, ChatJob, ChatJobLookup, ChatJobStatus, ChatResult, ChatSession, ChatStartResult, ChatWaitResult, Conversation, ConversationMessage, ConversationSummary, LegacyAttachmentDownloadInput, ListConversationsResult, ParsedInferenceStream, ThreadSignals, TurnOutcome } from "./types.js";
import type { NotionConfig } from "./config.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { ChatStateStore } from "./chat-jobs.js";
import { normalizeModelName, normalizeReasoningEffort } from "./models.js";
import { McpConnectionManager } from "./mcp-connections.js";
import { prepareAttachmentInput, readResponseBuffer, writeAttachmentOutput, type AttachmentInput, type PreparedAttachment } from "./attachments.js";
import { agentTranscriptError, applyAgentTranscriptPatches, createAgentTranscriptState, isAgentTranscriptTurnComplete, latestAgentTranscriptText } from "./agent-transcript.js";
import type { InterruptResult } from "./types.js";
import type { KeepAwakeDefaults } from "./keep-awake.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"';

const DEFAULT_CHAT_WAIT_MS = 45000;
const NOTION_ORIGIN = ["https:", "", "www.notion.so"].join("/");
const NOTION_FILE_PROXY_ORIGIN = ["https:", "", "app.notion.com"].join("/");

type JsonObject = Record<string, unknown>;

interface TranscriptPage { transcripts?: Array<Record<string, unknown>>; threadIds?: string[]; unreadThreadIds?: string[]; nextCursor?: string | null; hasMore?: boolean; recordMap?: { thread?: Record<string, unknown> } }
interface RecoveredThreadSteps { configId?: string; contextId?: string; updatedConfigIds: string[]; model?: string; reasoningEffort?: string }
interface ThreadLookup { page: TranscriptPage; transcript: Record<string, unknown> | null; thread: Record<string, unknown> }

interface ChatOptions {
  prompt: string;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  conversationId?: string | undefined;
  /** Thread UUID for a brand new conversation so the caller can learn the ID before generation finishes. */
  newConversationId?: string | undefined;
  webSearch?: boolean | undefined;
  workspaceSearch?: boolean | undefined;
  readOnly?: boolean | undefined;
  attachments?: ChatAttachment[] | undefined;
  fileIds?: string[] | undefined;
  _retryCount?: number | undefined;
}

type AgentUploadTarget = { type: "user" } | { type: "thread"; threadId: string };
type AttachmentTransport = "auto" | "agent_service" | "inference_transcript";

interface ProcessedTranscriptAttachment {
  contentType: string;
  metadata: JsonObject;
}

interface TranscriptUploadRecord {
  handleId: string;
  stepId: string;
  threadId: string;
  spaceId: string;
  fileUrl: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  usedInChat: boolean;
  processed?: ProcessedTranscriptAttachment | undefined;
}

function signedHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const entry = object(raw);
      const name = asString(entry.name).trim();
      const headerValue = asString(entry.value);
      if (name) headers.set(name, headerValue);
    }
  } else {
    for (const [name, headerValue] of Object.entries(object(value))) {
      if (typeof headerValue === "string") headers.set(name, headerValue);
    }
  }
  return headers;
}

function parseUploadedFile(value: unknown): AgentUploadedFile {
  const outer = object(value);
  const nested = object(outer.file);
  const file = Object.keys(nested).length > 0 ? nested : outer;
  const id = asString(file.id).trim();
  const filename = asString(file.filename).trim();
  const mediaType = asString(file.media_type).trim();
  const sizeBytes = file.size_bytes;
  if (!id || !filename || !mediaType || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Notion returned an invalid uploaded-file object");
  }
  const sha256 = asString(file.sha256).trim();
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Notion returned an invalid uploaded-file object");
  return { id, filename, media_type: mediaType, size_bytes: sizeBytes, ...(sha256 ? { sha256 } : {}) };
}

function normalizedFileIds(value: string[] | undefined): string[] {
  const ids = [...new Set((value ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 19) throw new Error("Notion AI supports at most 19 files with one text block");
  return ids;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_FILE_HANDLE_PREFIX = "transcript-file-";

function isUnsafeSignedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["127.0.0.1", "localhost", "::1"].includes(host)) return false;
  if (host === "0.0.0.0" || host === "metadata.google.internal" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
  }
  if (isIP(host) === 6) return host === "::" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  return false;
}

function validateSignedUrl(value: unknown, label: string): string {
  const raw = asString(value).trim();
  if (!raw || raw.length > 16_384 || /[\r\n]/.test(raw)) throw new Error(`${label} returned an invalid URL`);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} returned an invalid URL`); }
  const normalizedHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(normalizedHost);
  if (parsed.protocol !== "https:" && !localHttp) throw new Error(`${label} URL must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${label} URL must not contain userinfo`);
  if (isUnsafeSignedHost(parsed.hostname)) throw new Error(`${label} URL uses an unsafe host`);
  return raw;
}

function validateTranscriptFileUrl(value: unknown): string {
  const raw = asString(value).trim();
  if (!raw || raw.length > 8_192 || /[\0\r\n]/.test(raw)) throw new Error("Transcript upload returned an invalid file URL");
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try { if (new URL(raw).protocol === "https:") return raw; } catch { /* not an absolute URL */ }
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{1,2047}$/.test(raw) && raw.includes(":")) return raw;
  throw new Error("Transcript upload returned an invalid file URL");
}

function signedFileProxyUrl(
  sourceUrl: string,
  fileName: string,
  permissionRecord: { table: string; id: string; spaceId: string },
  currentUserId: string
): string {
  const query = new URLSearchParams({
    table: permissionRecord.table,
    id: permissionRecord.id,
    spaceId: permissionRecord.spaceId,
    name: fileName,
    download: "true",
    userId: currentUserId,
    cache: "v2",
    imgBuildSrc: "getSignedFileProxyUrl"
  });
  return `${NOTION_FILE_PROXY_ORIGIN}/signed/${encodeURIComponent(sourceUrl)}?${query.toString()}`;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  for (const segment of (cookieHeader ?? "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1 || segment.slice(0, separator).trim() !== name) continue;
    const value = segment.slice(separator + 1).trim();
    return value && !/[\r\n]/.test(value) ? value : undefined;
  }
  return undefined;
}

function validateTranscriptHeaders(value: unknown): Headers {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Transcript upload returned invalid postHeaders");
  const headers = new Headers();
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = object(raw);
    const name = asString(entry.name).trim();
    const headerValue = asString(entry.value);
    const lower = name.toLowerCase();
    if (!name || name.length > 128 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || headerValue.length > 8_192 || /[\0\r\n]/.test(headerValue) || seen.has(lower) || ["connection", "content-length", "host", "transfer-encoding"].includes(lower)) {
      throw new Error("Transcript upload returned invalid postHeaders");
    }
    seen.add(lower);
    headers.append(name, headerValue);
  }
  return headers;
}

function validateTranscriptFields(value: unknown): Array<[string, string]> {
  const entries = Object.entries(object(value));
  if (entries.length === 0 || entries.length > 64) throw new Error("Transcript upload returned invalid form fields");
  let totalBytes = 0;
  const output: Array<[string, string]> = [];
  for (const [name, rawValue] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || typeof rawValue !== "string" || /[\0\r\n]/.test(rawValue)) {
      throw new Error("Transcript upload returned invalid form fields");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue);
    if (Buffer.byteLength(rawValue) > 64 * 1024 || totalBytes > 256 * 1024) throw new Error("Transcript upload returned oversized form fields");
    output.push([name, rawValue]);
  }
  return output;
}

function transcriptServerFileName(fileName: string): string {
  const extension = extname(fileName);
  const safeExtension = /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : "";
  return `${randomUUID()}${safeExtension}`;
}

function canFallbackToTranscriptUpload(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^createAgentServiceFileUploadURL returned HTTP (400|404|500|501):/.test(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function promptWithLegacyAttachments(prompt: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return prompt;
  const sections = attachments.map((attachment) => {
    const heading = `--- Attachment context: ${attachment.name} ---`;
    if (attachment.text) return `${heading}\n${attachment.text}`;
    if (attachment.url) return `${heading}\n${attachment.url}`;
    return heading;
  });
  return `${prompt}\n\n${sections.join("\n\n")}`;
}

function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}; }
export function unwrapRecord(value: unknown): JsonObject { let current = object(value); for (let i = 0; i < 3; i += 1) { const nested = current.value; if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break; current = object(nested); } return current; }
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function asNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function formatRichTextSegment(value: unknown): string {
  if (!Array.isArray(value)) return ""; const text = asString(value[0]); if (!text) return "";
  const annotations = Array.isArray(value[1]) ? value[1] : []; let result = text; let href = "";
  for (const rawAnnotation of annotations) { const annotation = Array.isArray(rawAnnotation) ? rawAnnotation : [rawAnnotation]; const kind = annotation[0]; const data = annotation[1]; if (kind === "a" && typeof data === "string") href = data; else if (kind === "b") result = `**${result}**`; else if (kind === "i") result = `*${result}*`; else if (kind === "s") result = `~~${result}~~`; else if (kind === "c") result = `\`${result}\``; }
  return href ? `[${result}](${href})` : result;
}

export function notionRichTextToMarkdown(value: unknown): string {
  if (value === null || value === undefined) return ""; if (typeof value === "string") return value;
  if (Array.isArray(value)) { if (typeof value[0] === "string") return formatRichTextSegment(value); return value.map(notionRichTextToMarkdown).join(""); }
  const record = object(value); return asString(record.content) || asString(record.text) || asString(record.plain_text);
}

function agentInferenceText(value: unknown): string {
  if (typeof value === "string") return value; if (!Array.isArray(value)) return "";
  return value.map((item) => object(item)).filter((item) => item.type === "text" && typeof item.content === "string").map((item) => asString(item.content).trim()).filter(Boolean).join("\n\n").trim();
}

const ASSISTANT_STEP_TYPES = new Set(["agent-inference", "assistant", "agent", "inference", "agent-response"]);

function conversationMessageRole(step: JsonObject, record: JsonObject): "user" | "assistant" | null {
  const type = asString(step.type) || asString(record.type);
  if (type === "user" || type === "human") return "user";
  if (ASSISTANT_STEP_TYPES.has(type)) return "assistant";
  const role = asString(step.role) || asString(record.role);
  if (role === "user") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  return null;
}

// Answers are stored as rich text, as a typed content array, or nested inside inference steps, and an
// answer whose tool call timed out has to stay readable whichever shape the thread kept.
function conversationStepText(step: JsonObject): string {
  const inference = agentInferenceText(step.value);
  if (inference) return inference;
  // Genuine Notion rich text is an array of [text, annotations] tuples; other shapes must not be run through it.
  const value = step.value;
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => Array.isArray(entry))) {
    const rich = notionRichTextToMarkdown(value).trim();
    if (rich) return rich;
  }
  return collectStepText(value ?? step.content ?? step.steps);
}

// Thinking, tool and search chatter is internal: the Notion UI never shows it, so a recovered answer must not either.
const HIDDEN_STEP_CONTENT_TYPES = new Set(["thinking", "reasoning", "tool-call", "tool_use", "tool-result", "tool_result", "search", "agent-search", "citation", "status", "progress", "debug"]);

function collectStepText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => collectStepText(item, depth + 1)).filter(Boolean).join("\n\n").trim();
  if (!value || typeof value !== "object") return "";
  const item = object(value);
  if (typeof item.type === "string" && HIDDEN_STEP_CONTENT_TYPES.has(item.type)) return "";
  if (item.type === "text" && typeof item.content === "string") return item.content.trim();
  for (const candidate of [item.content, item.text, item.markdown, item.value, item.steps]) {
    if (candidate === undefined || candidate === null) continue;
    const text = collectStepText(candidate, depth + 1);
    if (text) return text;
  }
  return "";
}

function jobLookupOf(job: ChatJob): ChatJobLookup {
  return {
    status: job.status, source: "job", conversationId: job.conversationId, jobId: job.jobId, model: job.model,
    ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
    ...(job.text ? { text: job.text } : {}), ...(job.error ? { error: job.error } : {}),
    ...(job.usage ? { usage: job.usage } : {}),
    startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt
  };
}

export function parseConversationMessages(messageIds: string[], recordMap: Record<string, unknown>): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const id of messageIds) {
    const record = unwrapRecord(recordMap[id]);
    const step = object(record.step ?? object(record.data).step ?? record.data);
    const role = conversationMessageRole(step, record);
    if (!role) continue;
    const text = conversationStepText(step);
    if (!text) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) { previous.text = `${previous.text}\n\n${text}`; continue; }
    messages.push({ id, role, text, createdAt: asNumber(record.created_time) });
  }
  return messages;
}

function cleanLangTags(text: string): string { return text.replace(/<lang\b[^>]*\/>/g, "").replace(/<lang[^>]*$/, ""); }

function normalizeStreamLine(line: string): string { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith(":")) return ""; if (trimmed.startsWith("data:")) { const data = trimmed.slice(5).trim(); return data === "[DONE]" ? "" : data; } return trimmed; }

export function parseInferenceLines(lines: string[]): ParsedInferenceStream {
  let text = ""; let inputTokens = 0; let outputTokens = 0; const eventTypes: Record<string, number> = {}; const patchTypes = new Map<string, string>(); const patchCounts = new Map<string, number>();
  for (const rawLine of lines) { const line = normalizeStreamLine(rawLine); if (!line) continue; let event: JsonObject; try { event = object(JSON.parse(line)); } catch { continue; } const type = asString(event.type, "unknown"); eventTypes[type] = (eventTypes[type] ?? 0) + 1; if (type === "error") throw new Error(`Notion AI error: ${asString(event.message, "unknown error")}`); if (type === "premium-feature-unavailable") { const availability = object(event.featureAvailability); const limit = object(availability.limit); const current = limit.current; const total = limit.total; const detail = typeof current === "number" && typeof total === "number" ? ` (AI credit limit reached: ${current}/${total})` : ""; throw new Error(`Notion AI premium feature unavailable${detail}`); } if (type === "agent-inference") { for (const rawEntry of Array.isArray(event.value) ? event.value : []) { const entry = object(rawEntry); if (entry.type === "text" && typeof entry.content === "string") { text = entry.content; } } if (typeof event.inputTokens === "number") inputTokens += event.inputTokens; if (typeof event.outputTokens === "number") outputTokens += event.outputTokens; continue; } if (type !== "patch") continue; for (const rawOperation of Array.isArray(event.v) ? event.v : []) { const operation = object(rawOperation); const op = asString(operation.o); const path = asString(operation.p); if (op === "a" && path.includes("/value/-")) { const entry = object(operation.v); const statePrefix = path.slice(0, path.indexOf("/value/")); const count = patchCounts.get(statePrefix) ?? 0; patchTypes.set(`${statePrefix}/value/${count}`, asString(entry.type)); patchCounts.set(statePrefix, count + 1); } if (op === "a" && path.endsWith("/inputTokens") && typeof operation.v === "number") { inputTokens += operation.v; } if (op === "a" && path.endsWith("/outputTokens") && typeof operation.v === "number") { outputTokens += operation.v; } if (!path.includes("content") || typeof operation.v !== "string") continue; const contentIndex = path.lastIndexOf("/content"); const entryType = contentIndex >= 0 ? patchTypes.get(path.slice(0, contentIndex)) : "text"; if (entryType === "thinking" || entryType === "tool_use") continue; if (op === "x") text += operation.v; else if (op === "p") text = text.replace(/<lang[^>]*\/>/g, "").replace(operation.v.includes("<lang") ? /<lang[^>]*\/>/g : /$/, operation.v); } }
  return { text: cleanLangTags(text), inputTokens, outputTokens, eventTypes };
}

/** Explains a text-less inference stream instead of reporting a bare "empty response". */
export function emptyAnswerMessage(spaceId: string, session: { rehydrated?: boolean | undefined }, eventTypes: Record<string, number>): string {
  const seen = Object.entries(eventTypes).map(([type, count]) => `${type}=${count}`).join(", ") || "no events";
  const hint = session.rehydrated
    ? "Notion rejected the resumed thread state because the thread still holds an inference lease. Call interrupt_conversation for this conversationId and send again, or start a new chat without conversationId."
    : "The workspace may be out of AI credits or the turn was dropped before generation; check list_workspaces, switch_workspace, then retry.";
  return `Notion AI streamed no answer text (workspace ${spaceId}; stream events: ${seen}). ${hint}`;
}

function applyPatchReplacement(current: string, replacement: string): string { const langIndex = current.lastIndexOf("<lang"); return langIndex >= 0 ? current.slice(0, langIndex) + replacement : current + replacement; }

export async function parseInferenceStream(stream: ReadableStream<Uint8Array>): Promise<ParsedInferenceStream> { const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = ""; const lines: string[] = []; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let newline = buffer.indexOf("\n"); while (newline >= 0) { lines.push(buffer.slice(0, newline).trimEnd()); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); } } buffer += decoder.decode(); if (buffer.trim()) lines.push(buffer.trim()); return parseInferenceLines(lines); }

function buildCookie(account: AccountContext): string { if (account.fullCookie) return account.fullCookie; const userIdNoDash = account.userId.replaceAll("-", ""); return [`notion_browser_id=${account.browserId}`, `device_id=${account.deviceId}`, `notion_user_id=${account.userId}`, "notion_locale=en-US/legacy", `notion_users=[%22${account.userId}%22]`, "notion_check_cookie_consent=false", "notion_cookie_sync_completed=%7B%22completed%22%3Atrue%2C%22version%22%3A4%7D", `_cioid=${userIdNoDash}`, `token_v2=${account.tokenV2}`].join("; "); }

/** Mirrors the config step the Notion web client sends, so server-side gating behaves the same. */
export const UI_CONFIG_DEFAULTS: JsonObject = {
  type: "workflow",
  enableAgentAutomations: true,
  enableAgentDiffs: true,
  enableAgentIntegrations: true,
  enableAgentAskSurvey: true,
  enableCreateAndRunThread: true,
  enableCsvAttachmentSupport: true,
  enableCustomAgents: true,
  enableScriptAgent: true,
  enableScriptAgentAdvanced: false,
  enableScriptAgentMcpServers: true,
  enableScriptAgentSlack: true,
  useRulePrioritization: true,
  internetAccess: false,
  isCustomAgent: false,
  isCustomAgentBuilder: false,
  writerMode: false
};

function buildConfigValue(model: string, webSearch: boolean, workspaceSearch: boolean, readOnly: boolean, subsequent: boolean, reasoningEffort?: string | undefined): JsonObject {
  const integrations = webSearch || workspaceSearch;
  return {
    ...UI_CONFIG_DEFAULTS,
    model,
    modelFromUser: true,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    useWebSearch: webSearch,
    useReadOnlyMode: readOnly,
    ...(integrations ? { searchScopes: [{ type: "everything" }] } : {}),
    ...(subsequent ? { isThreadStartedByAdmin: true } : {})
  };
}

interface ConversationCursor { notionCursor?: string; offset: number }

function decodeConversationCursor(cursor?: string): ConversationCursor { if (!cursor) return { offset: 0 }; if (!cursor.startsWith("mcpv1.")) throw new Error("Invalid list_conversations cursor; pass the nextCursor returned by a previous list_conversations call"); try { const value = object(JSON.parse(Buffer.from(cursor.slice(6), "base64url").toString("utf8"))); const offset = typeof value.offset === "number" && Number.isInteger(value.offset) && value.offset >= 0 ? value.offset : 0; const notionCursor = asString(value.notionCursor); return notionCursor ? { notionCursor, offset } : { offset }; } catch { throw new Error("Invalid list_conversations cursor"); } }

function encodeConversationCursor(value: ConversationCursor): string { return `mcpv1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`; }

function parseTurnOutcome(value: unknown): TurnOutcome | null {
  const raw = object(value);
  const status = asString(raw.status);
  if (!status) return null;
  return {
    status,
    completedTime: asNumber(raw.completed_time),
    stepCount: asNumber(raw.step_count),
    inferenceId: asString(raw.inference_id),
    finalStepId: asString(raw.final_step_id)
  };
}

export class NotionClient {
  private accountPromise: Promise<AccountContext> | null = null;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly state: ChatStateStore;
  private readonly transcriptUploads = new Map<string, TranscriptUploadRecord>();
  private workspaceManager: WorkspaceManager | null = null;
  private mcpManager: McpConnectionManager | null = null;

  constructor(private readonly config: NotionConfig, private readonly fetchImpl: typeof fetch = fetch) {
    // Sessions and jobs are cached on disk, so a restart cannot orphan a conversation that is still generating.
    this.state = new ChatStateStore(config.stateFilePath ?? null);
    for (const session of this.state.sessions()) this.rememberSession(session);
    if (config.account.tokenV2) {
      const sharedAccount = config.account as AccountContext;
      Object.assign(sharedAccount, {
        userId: sharedAccount.userId || "",
        userName: sharedAccount.userName || "",
        userEmail: sharedAccount.userEmail || "",
        spaceId: sharedAccount.spaceId || "",
        spaceName: sharedAccount.spaceName || "",
        spaceViewId: sharedAccount.spaceViewId || "",
        timezone: sharedAccount.timezone || "UTC",
        clientVersion: sharedAccount.clientVersion || "23.13.20260313.1423",
        browserId: sharedAccount.browserId || randomUUID(),
        deviceId: sharedAccount.deviceId || randomUUID()
      });
      this.workspaceManager = new WorkspaceManager(
        sharedAccount,
        config.apiBase,
        fetchImpl,
        config.accountFilePath,
        { requestTimeoutMs: config.requestTimeoutMs }
      );
    }
  }

  async account(): Promise<AccountContext> { this.accountPromise ??= this.resolveAccount(); return this.accountPromise; }

  private async resolveAccount(): Promise<AccountContext> {
    const configured = this.config.account; if (configured.userId && configured.spaceId && configured.spaceViewId && configured.userName && configured.userEmail && configured.spaceName) return configured as AccountContext;
    const response = await this.fetchJson("loadUserContent", {}); const recordMap = object(response.recordMap); const users = object(recordMap.notion_user); const roots = object(recordMap.user_root); const userIds = Object.keys(users); const configuredUserId = asString(configured.userId); const userId = (configuredUserId && (users[configuredUserId] !== undefined || roots[configuredUserId] !== undefined) ? configuredUserId : undefined) ?? userIds.find((id) => roots[id] !== undefined) ?? userIds[0] ?? ""; if (!userId) throw new Error("loadUserContent did not return a Notion user");
    const user = unwrapRecord(users[userId]); const userRoot = unwrapRecord(object(recordMap.user_root)[userId]); const pointers = Array.isArray(userRoot.space_view_pointers) ? userRoot.space_view_pointers : []; if (pointers.length === 0) throw new Error("loadUserContent did not return a workspace");
    const spaces = object(recordMap.space);
    const reachable = (candidate: JsonObject): boolean => { const record = spaces[asString(candidate.spaceId)]; if (record === undefined || record === null) return false; const cs = unwrapRecord(record); if (cs.deleted === true || cs.alive === false) return false; return asString(cs.name) !== "" || asString(cs.plan_type) !== "" || asString(cs.id) !== ""; };
    const candidates = pointers.map((p) => object(p)).filter((c) => asString(c.spaceId) !== ""); const joinable = candidates.filter(reachable);
    const ranked = (joinable.length > 0 ? joinable : candidates).sort((a, b) => { const sc = (c: JsonObject): number => { const cs = unwrapRecord(spaces[asString(c.spaceId)]); const csS = object(cs.settings); return (csS.disable_ai_feature !== true ? 2 : 0) + (asString(cs.plan_type) !== "free" ? 1 : 0); }; return sc(b) - sc(a); });
    const preferredSpaceId = asString(configured.spaceId); const pinnedSpaceId = asString(configured.pinnedSpaceId); const pointerFor = (target: string): JsonObject | undefined => target ? ranked.find((c) => asString(c.spaceId) === target) : undefined;
    const pointer = preferredSpaceId ? (pointerFor(preferredSpaceId) ?? {}) : (pointerFor(pinnedSpaceId) ?? ranked[0] ?? {});
    const spaceId = preferredSpaceId || asString(pointer.spaceId); const space = unwrapRecord(spaces[spaceId]); const settings = unwrapRecord(object(recordMap.user_settings)[userId]); const userSettings = object(settings.settings);
    const resolved: AccountContext = { tokenV2: configured.tokenV2, userId, userName: configured.userName || asString(user.name), userEmail: configured.userEmail || asString(user.email), spaceId, spaceName: configured.spaceName || asString(space.name), spaceViewId: configured.spaceViewId || asString(pointer.id), timezone: configured.timezone || asString(userSettings.time_zone, "UTC"), clientVersion: configured.clientVersion || "23.13.20260313.1423", browserId: configured.browserId || randomUUID(), deviceId: configured.deviceId || randomUUID(), ...(configured.fullCookie ? { fullCookie: configured.fullCookie } : {}), ...(configured.pinnedSpaceId ? { pinnedSpaceId: configured.pinnedSpaceId } : {}) };
    Object.assign(configured, resolved);
    return configured as AccountContext;
  }

  private headers(account: AccountContext, stream: boolean): HeadersInit { return { accept: stream ? "application/x-ndjson" : "application/json", "accept-language": "en-US,en;q=0.9", "content-type": "application/json", "notion-audit-log-platform": "web", "notion-client-version": account.clientVersion, origin: NOTION_ORIGIN, referer: `${NOTION_ORIGIN}/${account.spaceId}`, "sec-ch-ua": SEC_CH_UA, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", "user-agent": USER_AGENT, "x-notion-active-user-header": account.userId, "x-notion-space-id": account.spaceId, cookie: buildCookie(account) }; }

  private async request(endpoint: string, body: unknown, stream: boolean): Promise<Response> { const account = endpoint === "loadUserContent" ? ({ ...this.config.account, userId: this.config.account.userId || "", spaceId: this.config.account.spaceId || "", userName: "", userEmail: "", spaceName: "", spaceViewId: "", timezone: this.config.account.timezone || "UTC", clientVersion: this.config.account.clientVersion || "23.13.20260313.1423", browserId: this.config.account.browserId || randomUUID(), deviceId: this.config.account.deviceId || randomUUID() } as AccountContext) : await this.account(); const response = await this.fetchImpl(`${this.config.apiBase}/${endpoint}`, { method: "POST", headers: endpoint === "loadUserContent" ? { accept: "application/json", "content-type": "application/json", cookie: `token_v2=${account.tokenV2}`, "user-agent": USER_AGENT } : this.headers(account, stream), body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.requestTimeoutMs) }); if (!response.ok) { const errorBody = (await response.text()).slice(0, 500); throw new Error(`${endpoint} returned HTTP ${response.status}: ${errorBody}`); } return response; }

  private async fetchJson(endpoint: string, body: unknown): Promise<JsonObject> { const response = await this.request(endpoint, body, false); return object(await response.json()); }

  private async transcriptPage(cursor?: string): Promise<TranscriptPage> { const account = await this.account(); const body: JsonObject = { threadParentPointer: { table: "space", id: account.spaceId, spaceId: account.spaceId }, includeWorkflowThreads: true, includeWriterChats: false, ...(cursor ? { cursor } : {}) }; return (await this.fetchJson("getInferenceTranscriptsForUser", body)) as TranscriptPage; }

  async listConversations(options: { limit?: number; cursor?: string; maxPages?: number } = {}): Promise<ListConversationsResult> { const limit = Math.min(Math.max(options.limit ?? 20, 1), 100); const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50); const state = decodeConversationCursor(options.cursor); const conversations: ConversationSummary[] = []; let notionCursor = state.notionCursor; let offset = state.offset; let nextCursor: string | null = null; let hasMore = false; for (let pi = 0; pi < maxPages && conversations.length < limit; pi += 1) { const page = await this.transcriptPage(notionCursor); const unread = new Set(page.unreadThreadIds ?? []); const threads = page.recordMap?.thread ?? {}; const pts = page.transcripts ?? []; let idx = offset; for (; idx < pts.length; idx += 1) { const r = pts[idx]; const t = object(r); const id = asString(t.id); if (!id) continue; const th = unwrapRecord(threads[id]); conversations.push({ id, title: asString(t.title) || asString(object(th.data).title) || "Untitled", type: asString(t.type) || asString(th.type, "workflow"), createdAt: asNumber(t.created_at) ?? asNumber(th.created_time), updatedAt: asNumber(t.updated_at) ?? asNumber(th.updated_time), messageCount: arrayOfStrings(th.messages).length, unread: unread.has(id) }); if (conversations.length >= limit) { const no = idx + 1; if (no < pts.length) { nextCursor = encodeConversationCursor({ ...(notionCursor ? { notionCursor } : {}), offset: no }); hasMore = true; } else if (page.hasMore && page.nextCursor) { nextCursor = encodeConversationCursor({ notionCursor: page.nextCursor, offset: 0 }); hasMore = true; } else { nextCursor = null; hasMore = false; } break; } } if (conversations.length >= limit) break; if (!page.hasMore || !page.nextCursor) { nextCursor = null; hasMore = false; break; } notionCursor = page.nextCursor; offset = 0; nextCursor = encodeConversationCursor({ notionCursor, offset: 0 }); hasMore = true; } return { conversations, nextCursor, hasMore }; }

  private async findThread(threadId: string, maxPages: number): Promise<ThreadLookup> { let cursor: string | undefined; for (let pi = 0; pi < maxPages; pi += 1) { const page = await this.transcriptPage(cursor); const rawThread = page.recordMap?.thread?.[threadId]; if (rawThread) { const t = (page.transcripts ?? []).find((item) => asString(object(item).id) === threadId) ?? null; return { page, transcript: t, thread: unwrapRecord(rawThread) }; } if (!page.hasMore || !page.nextCursor) break; cursor = page.nextCursor; } throw new Error(`Conversation ${threadId} was not found`); }

  private async fetchThreadMessages(messageIds: string[]): Promise<Record<string, unknown>> { const account = await this.account(); const records: Record<string, unknown> = {}; for (let i = 0; i < messageIds.length; i += 100) { const batch = messageIds.slice(i, i + 100); const resp = await this.fetchJson("syncRecordValuesMain", { requests: batch.map((id) => ({ pointer: { table: "thread_message", id, spaceId: account.spaceId }, version: -1 })) }); Object.assign(records, object(object(resp.recordMap).thread_message)); } return records; }

  /**
   * Reads back the config/context/updated-config steps Notion already stored for a thread.
   *
   * Notion validates a partial transcript against the step ids it has on record, so resuming a
   * conversation has to replay those ids. Inventing fresh ones makes the server accept the request
   * and then stream no assistant text at all.
   */
  private async recoverThreadSteps(messageIds: string[]): Promise<RecoveredThreadSteps> {
    const records = await this.fetchThreadMessages(messageIds);
    const recovered: RecoveredThreadSteps = { updatedConfigIds: [] };
    for (const id of messageIds) {
      const step = object(unwrapRecord(records[id]).step);
      const type = asString(step.type);
      const stepId = asString(step.id) || id;
      if (type === "config") {
        if (recovered.configId) continue;
        recovered.configId = stepId;
        const value = object(step.value);
        const storedModel = asString(value.model);
        const storedEffort = asString(value.reasoningEffort);
        if (storedModel) recovered.model = storedModel;
        if (storedEffort) recovered.reasoningEffort = storedEffort;
      } else if (type === "context") {
        if (!recovered.contextId) recovered.contextId = stepId;
      } else if (type === "updated-config") {
        recovered.updatedConfigIds.push(stepId);
      }
    }
    return recovered;
  }

  async getConversation(threadId: string, maxPages = 20): Promise<Conversation> { const found = await this.findThread(threadId, Math.min(Math.max(maxPages, 1), 100)); const messageIds = arrayOfStrings(found.thread.messages); const records = await this.fetchThreadMessages(messageIds); const t = found.transcript ?? {}; return { id: threadId, title: asString(t.title) || asString(object(found.thread.data).title) || "Untitled", type: asString(t.type) || asString(found.thread.type, "workflow"), createdAt: asNumber(t.created_at) ?? asNumber(found.thread.created_time), updatedAt: asNumber(t.updated_at) ?? asNumber(found.thread.updated_time), messages: parseConversationMessages(messageIds, records) }; }

  /**
   * Reads one thread record and returns the signals a keep-awake watchdog needs.
   *
   * Both signals have to come from the same read: updated_time and data.last_turn_outcome describe
   * the same turn only if they were fetched together, and a torn pair is exactly what makes a
   * watchdog nudge a chat that already finished. syncRecordValuesMain answers straight from the
   * record store, so this stays cheap enough to poll every 30 seconds.
   *
   * The current time is taken from the Date response header, because completed_time and updated_time
   * are Notion's stamps and comparing them against a local clock makes the result depend on skew.
   */
  async threadSignals(threadId: string): Promise<ThreadSignals> {
    const account = await this.account();
    const response = await this.request("syncRecordValuesMain", { requests: [{ pointer: { table: "thread", id: threadId, spaceId: account.spaceId }, version: -1 }] }, false);
    const header = Date.parse(response.headers.get("date") ?? "");
    const serverNow = Number.isFinite(header) ? header : Date.now();
    const payload = object(await response.json());
    const record = unwrapRecord(object(object(payload.recordMap).thread)[threadId]);
    if (Object.keys(record).length === 0) throw new Error(`Conversation ${threadId} was not found`);
    const data = object(record.data);
    const creditsByType = object(object(data.usage_summary).credits_by_type_unit);
    let credits: number | null = null;
    for (const value of Object.values(creditsByType)) {
      const amount = asNumber(value);
      if (amount !== null) credits = (credits ?? 0) + amount;
    }
    return {
      threadId,
      updatedTime: asNumber(record.updated_time),
      currentInferenceId: asString(record.current_inference_id),
      leaseExpiration: asNumber(record.current_inference_lease_expiration),
      serverNow,
      messageCount: arrayOfStrings(record.messages).length,
      lastTurnOutcome: parseTurnOutcome(data.last_turn_outcome),
      credits
    };
  }

  /**
   * Reads the shape of the step a closed turn ended on.
   *
   * One extra record read, and only when a watched turn has already gone quiet, so it costs about as
   * much as the poll it rides along with. It is the only server-side evidence that separates Notion
   * stopping a turn on its step-limit prompt from the turn genuinely finishing.
   */
  async finalStepShape(stepId: string): Promise<FinalStepShape | null> {
    if (!stepId) return null;
    const account = await this.account();
    const payload = await this.fetchJson("syncRecordValuesMain", { requests: [{ pointer: { table: "thread_message", id: stepId, spaceId: account.spaceId }, version: -1 }] });
    const record = unwrapRecord(object(object(payload.recordMap).thread_message)[stepId]);
    if (Object.keys(record).length === 0) return null;
    const step = object(record.step ?? object(record.data).step ?? record.data);
    return {
      stepId,
      type: asString(step.type),
      state: asString(step.state),
      hasAnswerText: agentInferenceText(step.value).length > 0,
      finishedAt: asNumber(step.finishedAt)
    };
  }

  /**
   * Clears the thread's inference lease so a new turn can be submitted.
   *
   * Notion locks a thread while an inference holds `current_inference_id` and a lease expiration, and
   * a second runInferenceTranscript against a locked thread answers 200 with an empty stream. The web
   * client's stop button aborts its own stream and clears both columns; this reproduces the persisted
   * half so a turn that died without finishing can be interrupted from outside the browser.
   */
  async interruptTurn(threadId: string): Promise<InterruptResult> {
    const account = await this.account();
    const signals = await this.threadSignals(threadId);
    if (!signals.currentInferenceId) {
      return { threadId, cleared: false, inferenceId: "", leaseExpiration: signals.leaseExpiration };
    }
    await this.fetchJson("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: account.spaceId,
        operations: [{
          pointer: { table: "thread", id: threadId, spaceId: account.spaceId },
          path: [],
          command: "update",
          args: { current_inference_id: null, current_inference_lease_expiration: null }
        }]
      }]
    });
    return { threadId, cleared: true, inferenceId: signals.currentInferenceId, leaseExpiration: signals.leaseExpiration };
  }

  keepAwakeDefaults(): KeepAwakeDefaults {
    return { ...this.config.keepAwake };
  }

  keepAliveStatePath(): string | null { return this.config.keepAliveFilePath ?? null; }

  async renameConversation(threadId: string, title: string, maxPages = 20): Promise<{ conversationId: string; previousTitle: string; title: string; changed: boolean }> {
    const nextTitle = title.trim();
    if (!nextTitle || Buffer.byteLength(nextTitle, "utf8") > 500 || /[\0\r\n]/.test(nextTitle)) {
      throw new Error("Conversation title must be one line and at most 500 UTF-8 bytes");
    }
    const found = await this.findThread(threadId, Math.min(Math.max(maxPages, 1), 100));
    const previousTitle = asString(found.transcript?.title) || asString(object(found.thread.data).title) || "Untitled";
    if (previousTitle === nextTitle) return { conversationId: threadId, previousTitle, title: nextTitle, changed: false };
    const account = await this.account();
    await this.fetchJson("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: account.spaceId,
        debug: { userAction: "renameThread" },
        operations: [{
          pointer: { table: "thread", id: threadId, spaceId: account.spaceId },
          path: ["data"],
          command: "update",
          args: { title: nextTitle }
        }]
      }]
    });
    return { conversationId: threadId, previousTitle, title: nextTitle, changed: true };
  }

  /**
   * Deletes a conversation by turning off the thread record itself.
   *
   * The live Notion backend accepts the ordinary record-off operation for an AI thread: one
   * `saveTransactionsFanout` operation with `path: []`, `command: "update"`, `args: { alive: false }`.
   * Ownership is checked first through the transcript listing, so a thread that belongs to another
   * workspace can never be touched, and a thread Notion already deleted stays a no-op.
   */
  async deleteConversation(threadId: string, maxPages = 20): Promise<{ conversationId: string; title: string; deleted: boolean; alreadyDeleted: boolean }> {
    const found = await this.findThread(threadId, Math.min(Math.max(maxPages, 1), 100));
    const title = asString(found.transcript?.title) || asString(object(found.thread.data).title) || "Untitled";
    if (found.thread.alive === false) return { conversationId: threadId, title, deleted: false, alreadyDeleted: true };
    const account = await this.account();
    await this.fetchJson("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: account.spaceId,
        debug: { userAction: "deleteThread" },
        operations: [{
          pointer: { table: "thread", id: threadId, spaceId: account.spaceId },
          path: [],
          command: "update",
          args: { alive: false }
        }]
      }]
    });
    return { conversationId: threadId, title, deleted: true, alreadyDeleted: false };
  }

  private buildContext(account: AccountContext, datetime: string, hasAttachments = false): JsonObject { return { timezone: account.timezone, userName: account.userName, userId: account.userId, userEmail: account.userEmail, spaceName: account.spaceName, spaceId: account.spaceId, spaceViewId: account.spaceViewId, currentDatetime: datetime, surface: hasAttachments ? "workflows" : "ai_module" }; }

  private buildInferenceBody(account: AccountContext, prompt: string, model: string, webSearch: boolean, workspaceSearch: boolean, readOnly: boolean, session: ChatSession, attachments: TranscriptUploadRecord[] = [], reasoningEffort?: string | undefined): JsonObject {
    const sub = session.turnCount > 0;
    const now = new Date().toISOString();
    const userStep: JsonObject = { id: randomUUID(), type: "user", value: [[prompt]], userId: account.userId, createdAt: now };
    const attachmentSteps = attachments.map((attachment) => {
      if (attachment.processed) {
        const metadata: JsonObject = { ...attachment.processed.metadata, attachmentSource: "user_upload" };
        if (Object.keys(object(metadata.guardrail)).length === 0) metadata.guardrail = { attachmentRisk: "skipped" };
        return {
          id: attachment.stepId,
          type: "attachment",
          fileUrl: attachment.fileUrl,
          fileName: attachment.fileName,
          contentType: attachment.processed.contentType,
          ...(attachment.processed.contentType === "application/pdf" ? { base64EncodedFileUrl: "" } : {}),
          metadata
        };
      }
      return {
        id: attachment.stepId,
        type: "computer-file",
        fileUrl: attachment.fileUrl,
        fileName: attachment.fileName,
        contentType: attachment.mediaType,
        metadata: { fileSize: attachment.sizeBytes, attachmentSource: "user_upload" }
      };
    });
    const transcript: JsonObject[] = [
      { id: session.configId, type: "config", value: buildConfigValue(model, webSearch, workspaceSearch, readOnly, sub, reasoningEffort) },
      { id: session.contextId, type: "context", value: this.buildContext(account, session.originalDatetime, attachments.length > 0) },
      ...session.updatedConfigIds.map((id) => ({ id, type: "updated-config" })),
      ...attachmentSteps,
      userStep
    ];
    return { traceId: randomUUID(), spaceId: account.spaceId, threadId: session.threadId, transcript, createThread: !sub, generateTitle: !sub, saveAllThreadOperations: true, setUnreadState: false, threadType: "workflow", asPatchResponse: false, isPartialTranscript: sub, ...(!sub ? { threadParentPointer: { table: "space", id: account.spaceId, spaceId: account.spaceId } } : {}), debugOverrides: { model, emitAgentSearchExtractedResults: true } };
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const maxRetries = this.config.maxWorkspaceRetries ?? 5;
    try { return await this._chatInternal(options); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isPremiumLimit = message.includes("premium feature unavailable") || message.includes("premium-feature-unavailable");
      const attempt = (options._retryCount ?? 0) + 1;
      if (isPremiumLimit && this.workspaceManager) {
        this.workspaceManager.markCurrentExhausted();
        const workspaceBound = Boolean(options.conversationId || options.fileIds?.some((id) => id.trim()));
        if (workspaceBound) {
          throw new Error("AI credit limit reached in the current workspace and this conversation or attachment is workspace-bound; switch workspace, then start a new chat and upload again.");
        }
        if (attempt <= maxRetries) {
          await this.workspaceManager.handleLimitReached();
          this.accountPromise = null;
          return this.chat({ ...options, _retryCount: attempt });
        }
      }
      throw error;
    }
  }

  /**
   * Starts a chat in the background and returns once the conversation ID is known.
   *
   * MCP clients abandon a tool call after roughly 60 seconds while Notion AI keeps generating, so the
   * conversation ID is handed out before the answer exists and the answer is kept in a job for later.
   */
  async startChat(options: ChatOptions): Promise<ChatStartResult> {
    const model = normalizeModelName(options.model, this.config.defaultModel);
    const reasoningEffort = normalizeReasoningEffort(model, options.reasoningEffort);
    const requested = options.conversationId?.trim() ?? "";
    let rehydrated = false;
    if (requested && !this.sessions.get(requested)) {
      const restored = await this.rehydrateSession(requested, model, reasoningEffort);
      if (!restored) throw new Error(`Conversation ${requested} was not found in this workspace, so it cannot be continued. Start a new chat without conversationId, or switch to the workspace that owns it.`);
      rehydrated = true;
    }
    const conversationId = requested || randomUUID();
    const job = this.state.createJob({
      conversationId, model, ...(reasoningEffort ? { reasoningEffort } : {}), prompt: options.prompt,
      turn: (this.sessions.get(conversationId)?.turnCount ?? 0) + 1,
      transport: normalizedFileIds(options.fileIds).length > 0 ? "agent_service" : "inference_transcript"
    });
    void this.runChatJob(job.jobId, requested ? { ...options } : { ...options, newConversationId: conversationId });
    return {
      status: "running", jobId: job.jobId, conversationId, model,
      ...(reasoningEffort ? { reasoningEffort } : {}), startedAt: job.startedAt,
      ...(rehydrated ? { rehydrated: true } : {}),
      hint: `Notion AI is generating in the background. Collect the answer with get_chat_result (jobId ${job.jobId} or conversationId ${conversationId}).`
    };
  }

  private async runChatJob(jobId: string, options: ChatOptions): Promise<void> {
    try {
      const result = await this.chat(options);
      // An AI-credit retry can move the answer to a freshly created thread, so the job follows the real conversation.
      this.state.retarget(jobId, result.conversationId);
      this.state.complete(jobId, {
        text: result.text, usage: result.usage, conversationId: result.conversationId, model: result.model,
        ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {})
      });
    } catch (error) {
      this.state.fail(jobId, error instanceof Error ? error.message : String(error));
    }
  }

  /** Waits a bounded time for a chat, then hands back a pending job instead of losing the request. */
  async chatWithWait(options: ChatOptions, waitMs?: number): Promise<ChatWaitResult> {
    const started = await this.startChat(options);
    const job = await this.state.wait(started.jobId, Math.max(0, waitMs ?? this.config.chatWaitMs ?? DEFAULT_CHAT_WAIT_MS));
    if (job?.status === "failed") throw new Error(job.error || "Notion AI chat failed");
    if (job?.status === "completed") {
      return {
        status: "completed", jobId: job.jobId, conversationId: job.conversationId, text: job.text ?? "", model: job.model,
        ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
        usage: job.usage ?? { inputTokens: 0, outputTokens: 0 },
        ...(started.rehydrated ? { rehydrated: true } : {})
      };
    }
    const conversationId = job?.conversationId ?? started.conversationId;
    const elapsedMs = Date.now() - started.startedAt;
    return {
      status: "pending", jobId: started.jobId, conversationId, model: started.model,
      ...(started.reasoningEffort ? { reasoningEffort: started.reasoningEffort } : {}),
      startedAt: started.startedAt, elapsedMs,
      ...(started.rehydrated ? { rehydrated: true } : {}),
      hint: `Still generating after ${Math.round(elapsedMs / 1000)}s. Nothing is lost: call get_chat_result with jobId ${started.jobId} (or conversationId ${conversationId}) to collect the answer.`
    };
  }

  listChatJobs(options: { status?: ChatJobStatus | undefined; limit?: number | undefined } = {}): ChatJob[] { return this.state.list(options); }

  chatStatePath(): string | null { return this.state.statePath(); }

  /** Capability defaults applied when notion_ai_chat omits webSearch/workspaceSearch/readOnly. */
  chatDefaults(): { webSearch: boolean; workspaceSearch: boolean; readOnly: boolean } {
    return { webSearch: this.config.defaultWebSearch, workspaceSearch: this.config.defaultWorkspaceSearch, readOnly: this.config.defaultReadOnly };
  }

  chatStateError(): string | null { return this.state.persistError(); }

  /** Collects a chat answer after the fact, from the job cache or, when the stream is gone, from the thread itself. */
  async chatResult(options: { jobId?: string | undefined; conversationId?: string | undefined; waitMs?: number | undefined }): Promise<ChatJobLookup> {
    const waitMs = Math.max(0, options.waitMs ?? 0);
    const jobId = options.jobId?.trim() ?? "";
    const conversationId = options.conversationId?.trim() ?? "";
    if (!jobId && !conversationId) throw new Error("jobId or conversationId is required");
    let job = jobId ? this.state.job(jobId) : this.state.latestForConversation(conversationId);
    if (jobId && !job) throw new Error(`Unknown jobId ${jobId}. Call list_chat_jobs, or pass conversationId to read the answer from the thread.`);
    if (job?.status === "running" && waitMs > 0) job = await this.state.wait(job.jobId, waitMs);
    if (job && (job.status === "completed" || job.status === "failed")) return jobLookupOf(job);
    const threadId = job?.conversationId || conversationId;
    if (!threadId) throw new Error("conversationId is required to read the answer from the thread");
    // No live stream: the call timed out, the job is from a previous process, or the answer arrived late.
    const recovered = await this.recoverAnswerFromThread(threadId, job?.startedAt, job ? 0 : waitMs);
    if (recovered) {
      if (job) this.state.complete(job.jobId, { text: recovered });
      return {
        status: "completed", source: "thread", conversationId: threadId, ...(job ? { jobId: job.jobId } : {}),
        ...(job?.model ? { model: job.model } : {}), ...(job?.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
        text: recovered, ...(job ? { startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt } : {})
      };
    }
    return {
      status: job?.status ?? "running", source: job ? "job" : "thread", conversationId: threadId,
      ...(job ? { jobId: job.jobId, model: job.model, startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt } : {}),
      ...(job?.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
      hint: `Notion AI has not written the answer to conversation ${threadId} yet. Call get_chat_result again in a few seconds, or read the thread with get_conversation.`
    };
  }

  /** Polls the thread until an assistant answer newer than the request shows up. */
  private async recoverAnswerFromThread(threadId: string, since: number | undefined, budgetMs: number): Promise<string> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (;;) {
      const conversation = await this.getConversation(threadId, 5);
      const answer = [...conversation.messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
      if (answer && (since === undefined || answer.createdAt === null || answer.createdAt >= since - 5000)) return answer.text;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "";
      await sleep(Math.min(5000, Math.max(500, remaining)));
    }
  }

  /**
   * Rebuilds a chat session for a conversation this process never started.
   *
   * Without this, a conversation whose call timed out (or that was started before a restart) could
   * never be continued, because the session lived only in the memory of the previous process.
   */
  private async rehydrateSession(conversationId: string, model: string, reasoningEffort: string | undefined, modelRequested = false): Promise<ChatSession | null> {
    if (this.config.allowSessionRehydrate === false) return null;
    const found = await this.findThread(conversationId, 20).catch(() => null);
    if (!found) return null;
    const messageIds = arrayOfStrings(found.thread.messages);
    const stored = await this.recoverThreadSteps(messageIds).catch(() => null);
    // Without the original config and context ids Notion answers a partial transcript with an empty
    // stream, so refuse to resume instead of burning credits on a request that cannot produce text.
    if (!stored?.configId || !stored.contextId) {
      throw new Error(`Conversation ${conversationId} cannot be resumed because Notion no longer exposes the config and context steps it was started with. Start a new chat without conversationId.`);
    }
    const resumedModel = modelRequested ? model : stored.model ?? model;
    // Only inherit the stored effort when the stored model comes with it; mixing a caller-picked
    // model with a foreign effort would fail validation.
    const resumedEffort = reasoningEffort ?? (resumedModel === stored.model ? stored.reasoningEffort : undefined);
    const session: ChatSession = {
      threadId: conversationId, configId: stored.configId, contextId: stored.contextId,
      originalDatetime: new Date(asNumber(found.thread.created_time) ?? Date.now()).toISOString(),
      model: resumedModel, ...(resumedEffort ? { reasoningEffort: resumedEffort } : {}), updatedConfigIds: stored.updatedConfigIds,
      // A non-zero turn count keeps the request a partial transcript, so Notion appends to the existing thread.
      turnCount: Math.max(1, messageIds.length), transport: "inference_transcript", rehydrated: true
    };
    this.rememberSession(session);
    return session;
  }

  private rememberSession(session: ChatSession): void {
    this.sessions.set(session.threadId, session);
    this.state.saveSession(session);
  }

  private async _chatInternal(options: ChatOptions): Promise<ChatResult> {
    const account = await this.account();
    const model = normalizeModelName(options.model, this.config.defaultModel);
    const requestedEffort = normalizeReasoningEffort(model, options.reasoningEffort);
    const fileIds = normalizedFileIds(options.fileIds);
    const resolvedTranscriptFiles = fileIds.map((id) => this.transcriptUploads.get(id));
    const transcriptFileCount = resolvedTranscriptFiles.filter((file): file is TranscriptUploadRecord => file !== undefined).length;
    if (transcriptFileCount > 0 && transcriptFileCount !== fileIds.length) throw new Error("Agent Service and inference-transcript attachment handles cannot be mixed");
    if (transcriptFileCount === 0 && fileIds.some((id) => id.startsWith(TRANSCRIPT_FILE_HANDLE_PREFIX))) {
      throw new Error("Inference-transcript attachment handle is unknown or expired; upload it again in this server process");
    }
    const transcriptFiles = resolvedTranscriptFiles.filter((file): file is TranscriptUploadRecord => file !== undefined);
    if (transcriptFiles.some((file) => file.spaceId !== account.spaceId)) throw new Error("Attachment handles belong to another workspace; switch back or upload again");
    const transcriptThreadIds = new Set(transcriptFiles.map((file) => file.threadId));
    if (transcriptThreadIds.size > 1) throw new Error("Inference-transcript attachments from different conversations cannot be mixed");

    let session: ChatSession;
    if (options.conversationId) {
      const cached = this.sessions.get(options.conversationId);
      // A session whose first turn never finished locally (timed-out stream, answer recovered from the
      // thread) still looks brand new, and sending it as-is would ask Notion to create the thread twice.
      const stale = cached !== undefined && cached.turnCount === 0 && cached.transport === "inference_transcript" && fileIds.length === 0;
      const refreshed = stale
        ? await this.rehydrateSession(options.conversationId, model, requestedEffort, Boolean(options.model)).catch(() => null)
        : null;
      const known = refreshed ?? cached ?? await this.rehydrateSession(options.conversationId, model, requestedEffort, Boolean(options.model));
      if (!known) throw new Error(`Conversation ${options.conversationId} was not found in this workspace, so it cannot be continued. Start a new chat without conversationId, or switch to the workspace that owns it.`);
      session = known;
      if (transcriptFiles.length > 0 && transcriptFiles[0]?.threadId !== session.threadId) throw new Error("Attachment handle belongs to another conversation");
    } else if (transcriptFiles.length > 0) {
      const threadId = transcriptFiles[0]?.threadId as string;
      const known = this.sessions.get(threadId);
      if (!known || known.transport !== "inference_transcript") throw new Error("Inference-transcript attachment session is no longer active; upload it again");
      session = known;
    } else {
      session = {
        threadId: options.newConversationId || randomUUID(), configId: randomUUID(), contextId: randomUUID(), originalDatetime: new Date().toISOString(),
        model, updatedConfigIds: [], turnCount: 0,
        ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}),
        transport: fileIds.length > 0 ? "agent_service" : "inference_transcript"
      };
    }
    const reasoningEffort = requestedEffort ?? session.reasoningEffort;
    // A rehydrated session carries the model Notion recorded on the thread, so a resumed turn keeps
    // answering with that model unless the caller names a different one.
    const effectiveModel = session.rehydrated === true && !options.model ? session.model || model : model;
    if (session.transport === "agent_service") {
      if (transcriptFiles.length > 0) throw new Error("Inference-transcript attachment handles cannot be used in an Agent Service conversation");
      return this.agentServiceChat(account, effectiveModel, session, options, fileIds, reasoningEffort);
    }
    if (fileIds.length > 0 && transcriptFiles.length === 0) throw new Error("Uploaded file IDs cannot be added to a legacy chat unless they are inference-transcript attachment handles. Start a new chat without conversationId.");
    if (transcriptFiles.some((file) => file.usedInChat)) throw new Error("An inference-transcript attachment handle can only be attached once");
    const prompt = promptWithLegacyAttachments(options.prompt, options.attachments ?? []);
    const body = this.buildInferenceBody(account, prompt, effectiveModel, options.webSearch ?? this.config.defaultWebSearch, options.workspaceSearch ?? this.config.defaultWorkspaceSearch, options.readOnly ?? this.config.defaultReadOnly, session, transcriptFiles, reasoningEffort);
    const response = await this.request("runInferenceTranscript", body, true);
    if (!response.body) throw new Error("runInferenceTranscript returned no response stream");
    const parsed = await parseInferenceStream(response.body);
    if (!parsed.text.trim()) throw new Error(emptyAnswerMessage(account.spaceId, session, parsed.eventTypes));
    for (const file of transcriptFiles) file.usedInChat = true;
    session.turnCount += 1; session.updatedConfigIds.push(randomUUID()); session.model = effectiveModel; session.reasoningEffort = reasoningEffort; this.rememberSession(session);
    return { conversationId: session.threadId, text: parsed.text, model: effectiveModel, ...(reasoningEffort ? { reasoningEffort } : {}), usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens } };
  }

  private async signedRequest(url: string, init: RequestInit, label: string): Promise<Response> {
    const parsed = new URL(validateSignedUrl(url, label));
    const response = await this.fetchImpl(parsed, { ...init, redirect: "error", signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 500);
      throw new Error(`${label} returned HTTP ${response.status}: ${errorBody}`);
    }
    return response;
  }

  private async notionSignedProxyRequest(url: string, account: AccountContext, label: string): Promise<Response> {
    const parsed = new URL(validateSignedUrl(url, label));
    const headers = new Headers(this.headers(account, false));
    headers.set("accept", "*/*");
    headers.delete("content-type");
    const response = await this.fetchImpl(parsed, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${label} redirect did not include a Location header`);
      const redirectedUrl = new URL(location, parsed);
      const redirectInit: RequestInit = { method: "GET" };
      if (redirectedUrl.hostname.toLowerCase() === "file.notion.com") {
        const fileToken = cookieValue(account.fullCookie, "file_token");
        if (!fileToken) {
          throw new Error(`${label} requires file_token in the account full_cookie or NOTION_FULL_COOKIE`);
        }
        redirectInit.headers = { cookie: `file_token=${fileToken}` };
      }
      return this.signedRequest(redirectedUrl.toString(), redirectInit, label);
    }
    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 500);
      throw new Error(`${label} returned HTTP ${response.status}: ${errorBody}`);
    }
    return response;
  }

  private createInferenceSession(threadId: string): ChatSession {
    return {
      threadId, configId: randomUUID(), contextId: randomUUID(), originalDatetime: new Date().toISOString(),
      model: this.config.defaultModel, updatedConfigIds: [], turnCount: 0, transport: "inference_transcript"
    };
  }

  private taskOutputRecord(payload: JsonObject, outputKey: string): JsonObject | null {
    const table = object(object(payload.recordMap).task_output);
    const entry = object(table[outputKey]);
    if (Object.keys(entry).length === 0) return null;
    const value = object(entry.value);
    const nestedValue = object(value.value);
    return [entry, value, nestedValue].find((candidate) => typeof candidate.status === "string") ?? null;
  }

  private processedTranscriptAttachment(value: unknown): ProcessedTranscriptAttachment {
    let wrapper = object(value);
    if (wrapper.result === undefined && object(wrapper.value).result !== undefined) wrapper = object(wrapper.value);
    const result = object(wrapper.result);
    const resultType = asString(result.type);
    const data = object(result.data);
    if (resultType === "error") {
      const code = asString(data.code, "UNKNOWN");
      const message = asString(data.message, "Attachment processing failed").slice(0, 1_000);
      const allowedCodes = new Set([
        "CORRUPTED_FILE", "FILE_NOT_FOUND", "FILE_SIZE_EXCEEDS_MAX_SIZE", "FILE_SIZE_IS_0", "INTERNAL_ERROR",
        "PASSWORD_PROTECTED", "PROCESSING_FAILED", "UNKNOWN", "UNSUPPORTED_CONTENT_TYPE"
      ]);
      if (!allowedCodes.has(code)) throw new Error("Attachment processing returned an invalid error code");
      throw new Error(`Attachment processing failed (${code}): ${message}`);
    }
    if (resultType !== "success") throw new Error("Attachment processing returned an invalid result type");

    const contentType = asString(data.contentType).trim().toLowerCase();
    const attachmentRisk = asString(data.attachmentRisk);
    if (!new Set(["confirmed_safe_by_user", "failed", "risky", "scanned", "skipped"]).has(attachmentRisk)) {
      throw new Error("Attachment processing returned an invalid attachment risk");
    }
    const fileSizeBytes = data.fileSizeBytes;
    if (typeof fileSizeBytes !== "number" || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 0) {
      throw new Error("Attachment processing returned an invalid file size");
    }
    const integerField = (name: string): void => {
      const field = data[name];
      if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new Error(`Attachment processing returned an invalid ${name}`);
      }
    };
    const imageTypes = new Set(["image/gif", "image/heic", "image/jpeg", "image/png", "image/webp"]);
    const textTypes = new Set([
      "application/javascript", "application/json", "application/typescript", "text/css", "text/html", "text/markdown",
      "text/plain", "text/x-c", "text/x-c++src", "text/x-go", "text/x-java-source", "text/x-python", "text/x-ruby",
      "text/x-rust", "text/x-shellscript", "text/xml", "text/yaml"
    ]);
    if (contentType === "application/pdf") integerField("numPages");
    else if (contentType === "text/csv") { integerField("numFields"); integerField("numRows"); }
    else if (imageTypes.has(contentType)) {
      integerField("height");
      integerField("width");
      const moderation = object(data.moderation);
      const moderationStatus = asString(moderation.status);
      if (!new Set(["flagged", "passed", "skipped", "failed"]).has(moderationStatus)) {
        throw new Error("Attachment processing returned an invalid moderation status");
      }
      if (moderationStatus === "flagged") {
        const scores = object(moderation.scores);
        for (const name of ["hate", "hate/threatening", "self-harm", "sexual", "sexual/minors", "violence/graphic"]) {
          if (typeof scores[name] !== "number" || !Number.isFinite(scores[name])) {
            throw new Error("Attachment processing returned invalid moderation scores");
          }
        }
      }
    } else if (!textTypes.has(contentType)) {
      throw new Error(`Attachment processing returned unsupported content type ${contentType || "<empty>"}`);
    }
    return { contentType, metadata: object(data.stepMetadata) };
  }

  private async processInferenceTranscriptAttachment(
    account: AccountContext,
    threadId: string,
    fileUrl: string,
    fileName: string
  ): Promise<ProcessedTranscriptAttachment> {
    const started = await this.fetchJson("processAgentAttachment", {
      url: fileUrl,
      spaceId: account.spaceId,
      aiSessionPointer: { table: "thread", id: threadId, spaceId: account.spaceId },
      source: "user_upload",
      clientVersion: account.clientVersion
    });
    const outputKey = asString(started.outputKey).trim();
    const outputSpaceId = asString(started.spaceId).trim();
    if (!UUID_PATTERN.test(outputKey)) throw new Error("processAgentAttachment returned an invalid outputKey");
    if (!UUID_PATTERN.test(outputSpaceId) || outputSpaceId !== account.spaceId) {
      throw new Error("processAgentAttachment returned a different or invalid workspace");
    }

    const deadline = Date.now() + this.config.requestTimeoutMs;
    while (Date.now() < deadline) {
      const payload = await this.fetchJson("syncRecordValuesMain", {
        requests: [{ pointer: { table: "task_output", id: outputKey, spaceId: outputSpaceId }, version: -1 }]
      });
      const record = this.taskOutputRecord(payload, outputKey);
      if (record) {
        const status = asString(record.status);
        if (status === "complete") return this.processedTranscriptAttachment(record.value);
        if (status === "failed") {
          const failedValue = object(record.value);
          if (failedValue.result !== undefined || object(failedValue.value).result !== undefined) {
            return this.processedTranscriptAttachment(failedValue);
          }
          throw new Error("Attachment processing task failed without a result");
        }
        if (status && status !== "pending" && status !== "in_progress") {
          throw new Error(`Attachment processing returned unknown task status ${status}`);
        }
      }
      await sleep(250);
    }
    throw new Error("Timed out waiting for attachment processing");
  }

  private async uploadInferenceTranscriptAttachment(account: AccountContext, prepared: PreparedAttachment, conversationId?: string, processForInference = false): Promise<AttachmentUploadResult> {
    const existing = conversationId ? this.sessions.get(conversationId) : undefined;
    if (conversationId && (!existing || existing.transport !== "inference_transcript")) {
      throw new Error("Inference-transcript upload requires an active inference-transcript conversation");
    }
    const threadId = existing?.threadId ?? randomUUID();
    const session = existing ?? this.createInferenceSession(threadId);
    const serverFileName = transcriptServerFileName(prepared.fileName);
    const pointer = { spaceId: account.spaceId, table: "thread", id: threadId };
    const created = await this.fetchJson("getUploadFileUrlForAssistantChatTranscriptUpload", {
      name: serverFileName,
      contentType: prepared.mediaType,
      assistantChatTranscriptSessionPointer: pointer,
      contentLength: prepared.sizeBytes,
      createThread: true
    });
    const chatId = asString(created.chatId).trim();
    if (!UUID_PATTERN.test(chatId) || chatId !== threadId) throw new Error("Transcript upload returned a different or invalid chatId");
    const fileUrl = validateTranscriptFileUrl(created.url);
    validateSignedUrl(created.signedGetUrl, "Transcript upload signedGetUrl");
    const signedUploadPostUrl = validateSignedUrl(created.signedUploadPostUrl, "Transcript upload");
    const postHeaders = validateTranscriptHeaders(created.postHeaders);
    const fields = validateTranscriptFields(created.fields);
    const form = new FormData();
    for (const [name, value] of fields) form.append(name, value);
    form.append("file", new Blob([new Uint8Array(prepared.data)], { type: prepared.mediaType }), serverFileName);
    const uploadResponse = await this.signedRequest(signedUploadPostUrl, { method: "POST", headers: postHeaders, body: form }, "Transcript attachment upload");
    if (uploadResponse.status !== 200 && uploadResponse.status !== 204) throw new Error(`Transcript attachment upload returned unsupported HTTP ${uploadResponse.status}`);

    const processed = processForInference
      ? await this.processInferenceTranscriptAttachment(account, threadId, fileUrl, prepared.fileName)
      : undefined;
    const handleId = `${TRANSCRIPT_FILE_HANDLE_PREFIX}${randomUUID()}`;
    const sha256 = createHash("sha256").update(prepared.data).digest("hex");
    const record: TranscriptUploadRecord = {
      handleId, stepId: randomUUID(), threadId, spaceId: account.spaceId, fileUrl, fileName: prepared.fileName,
      mediaType: prepared.mediaType, sizeBytes: prepared.sizeBytes, sha256, usedInChat: false,
      ...(processed ? { processed } : {})
    };
    this.transcriptUploads.set(handleId, record);
    this.rememberSession(session);
    const file: AgentUploadedFile = { id: handleId, filename: prepared.fileName, media_type: prepared.mediaType, size_bytes: prepared.sizeBytes, sha256 };
    return {
      transport: "inference_transcript", fileId: handleId, conversationId: threadId, fileName: prepared.fileName,
      mediaType: prepared.mediaType, sizeBytes: prepared.sizeBytes, sha256,
      ...(processed ? { processedForInference: true } : {}),
      target: { type: "thread", threadId }, file
    };
  }

  async uploadAttachment(options: AttachmentInput & { conversationId?: string | undefined; transport?: AttachmentTransport | undefined; processForInference?: boolean | undefined }): Promise<AttachmentUploadResult> {
    const requestedTransport = options.transport ?? "auto";
    if (options.processForInference && requestedTransport !== "inference_transcript") {
      throw new Error("processForInference requires transport inference_transcript");
    }
    const known = options.conversationId ? this.sessions.get(options.conversationId) : undefined;
    if (requestedTransport === "inference_transcript" && options.conversationId && !known) {
      throw new Error("Inference-transcript upload requires an active inference-transcript conversation");
    }
    const account = await this.account();
    const maxBytes = this.config.maxAttachmentBytes ?? 20 * 1024 * 1024;
    const root = this.config.attachmentRoot ?? process.cwd();
    const prepared = await prepareAttachmentInput(options, root, maxBytes);
    if (known?.transport === "inference_transcript" && requestedTransport === "agent_service") {
      throw new Error("Agent Service uploads cannot target an inference-transcript conversation");
    }
    if (known?.transport === "agent_service" && requestedTransport === "inference_transcript") {
      throw new Error("Inference-transcript uploads cannot target an Agent Service conversation");
    }
    if (known?.transport === "inference_transcript" || requestedTransport === "inference_transcript") {
      return this.uploadInferenceTranscriptAttachment(account, prepared, options.conversationId, options.processForInference ?? false);
    }
    if (known && known.transport !== "agent_service") throw new Error("Attachments cannot cross chat transports");
    const target: AgentUploadTarget = options.conversationId
      ? { type: "thread", threadId: options.conversationId }
      : { type: "user" };

    let created: JsonObject;
    try {
      created = await this.fetchJson("createAgentServiceFileUploadURL", {
        spaceId: account.spaceId,
        target,
        filename: prepared.fileName,
        mediaType: prepared.mediaType,
        sizeBytes: prepared.sizeBytes
      });
    } catch (error) {
      if (options.conversationId || !canFallbackToTranscriptUpload(error)) throw error;
      return this.uploadInferenceTranscriptAttachment(account, prepared);
    }
    const upload = object(created.upload);
    const createdFile = object(created.file);
    const fileId = asString(createdFile.id).trim();
    if (!fileId) throw new Error("createAgentServiceFileUploadURL did not return file.id");

    let completedParts: Array<{ partNumber: number; etag: string }> | undefined;
    if (upload.type === "single_part") {
      const url = asString(upload.url);
      const method = asString(upload.method).toUpperCase();
      if (!url || !["POST", "PUT"].includes(method)) throw new Error("Notion returned an invalid single-part upload descriptor");
      await this.signedRequest(url, { method, headers: signedHeaders(upload.headers), body: new Uint8Array(prepared.data) }, "Attachment upload");
    } else if (upload.type === "multipart") {
      const partSize = upload.part_size_bytes;
      const descriptors = Array.isArray(upload.parts) ? upload.parts.map(object) : [];
      if (typeof partSize !== "number" || !Number.isSafeInteger(partSize) || partSize <= 0 || descriptors.length === 0) {
        throw new Error("Notion returned an invalid multipart upload descriptor");
      }
      const expectedParts = Math.ceil(prepared.sizeBytes / partSize);
      if (descriptors.length !== expectedParts) {
        throw new Error(`Multipart descriptor contained ${descriptors.length} parts; expected ${expectedParts}`);
      }
      const seen = new Set<number>();
      const validatedParts = descriptors.map((descriptor) => {
        const partNumber = descriptor.part_number;
        const url = asString(descriptor.url);
        const method = asString(descriptor.method).toUpperCase();
        if (typeof partNumber !== "number" || !Number.isSafeInteger(partNumber) || partNumber <= 0 || seen.has(partNumber) || !url || !["POST", "PUT"].includes(method)) {
          throw new Error("Notion returned an invalid multipart upload part");
        }
        if (partNumber > expectedParts) throw new Error(`Multipart part ${partNumber} is outside the file bounds`);
        seen.add(partNumber);
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, prepared.sizeBytes);
        if (end <= start) throw new Error(`Multipart part ${partNumber} is outside the file bounds`);
        return { partNumber, url, method, headers: signedHeaders(descriptor.headers), start, end };
      });
      completedParts = [];
      for (const descriptor of validatedParts) {
        const response = await this.signedRequest(descriptor.url, {
          method: descriptor.method,
          headers: descriptor.headers,
          body: new Uint8Array(prepared.data.subarray(descriptor.start, descriptor.end))
        }, `Attachment upload part ${descriptor.partNumber}`);
        const etag = response.headers.get("etag")?.trim();
        if (!etag) throw new Error(`Attachment upload part ${descriptor.partNumber} did not return an ETag`);
        completedParts.push({ partNumber: descriptor.partNumber, etag });
      }
      completedParts.sort((left, right) => left.partNumber - right.partNumber);
    } else {
      throw new Error("Notion returned an unsupported upload descriptor type");
    }

    const completed = await this.fetchJson("completeAgentServiceFileUpload", {
      spaceId: account.spaceId,
      target,
      fileId,
      ...(completedParts ? { parts: completedParts } : {})
    });
    const file = parseUploadedFile(completed);
    if (file.id !== fileId) throw new Error("Completed upload returned a different file ID");
    if (file.size_bytes !== prepared.sizeBytes) throw new Error("Completed upload returned a different file size");
    if (file.sha256) {
      const actual = createHash("sha256").update(prepared.data).digest("hex");
      if (actual.toLowerCase() !== file.sha256.toLowerCase()) throw new Error("Completed upload checksum did not match local data");
    }
    return {
      transport: "agent_service",
      fileId: file.id,
      fileName: file.filename,
      mediaType: file.media_type,
      sizeBytes: file.size_bytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      target,
      file
    };
  }

  async downloadAttachment(options: {
    conversationId?: string | undefined;
    fileId?: string | undefined;
    legacy?: LegacyAttachmentDownloadInput | undefined;
    outputPath?: string | undefined;
    returnBase64?: boolean | undefined;
    overwrite?: boolean | undefined;
  }): Promise<AttachmentDownloadResult> {
    const conversationId = options.conversationId?.trim() ?? "";
    const fileId = options.fileId?.trim() ?? "";
    const agentServiceMode = Boolean(conversationId || fileId);
    const legacyMode = options.legacy !== undefined;
    if (agentServiceMode === legacyMode) {
      throw new Error("Choose exactly one download mode: conversationId + fileId, or legacy");
    }
    if (agentServiceMode && (!conversationId || !fileId)) {
      throw new Error("Agent Service download requires both conversationId and fileId");
    }

    const account = await this.account();
    const maxBytes = this.config.maxAttachmentBytes ?? 20 * 1024 * 1024;
    const transcriptUpload = legacyMode ? undefined : this.transcriptUploads.get(fileId);
    if (transcriptUpload) {
      if (transcriptUpload.spaceId !== account.spaceId) throw new Error("Attachment handle belongs to another workspace");
      if (transcriptUpload.threadId !== conversationId) throw new Error("Attachment handle belongs to another conversation");
      const permissionRecord = { table: "thread", id: transcriptUpload.threadId, spaceId: transcriptUpload.spaceId };
      const proxyUrl = signedFileProxyUrl(
        transcriptUpload.fileUrl,
        transcriptUpload.fileName,
        permissionRecord,
        account.userId
      );
      const response = await this.notionSignedProxyRequest(proxyUrl, account, "Transcript attachment download");
      const data = await readResponseBuffer(response, maxBytes);
      if (data.byteLength !== transcriptUpload.sizeBytes) throw new Error("Downloaded transcript attachment size did not match the upload");
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== transcriptUpload.sha256) throw new Error("Downloaded transcript attachment checksum did not match the upload");
      let outputPath: string | undefined;
      const requestedOutput = options.outputPath ?? (options.returnBase64 ? undefined : `downloads/${transcriptUpload.fileName}`);
      if (requestedOutput) outputPath = await writeAttachmentOutput(data, requestedOutput, this.config.attachmentRoot ?? process.cwd(), options.overwrite ?? false);
      return {
        source: "inference_transcript", fileId, fileName: transcriptUpload.fileName, mediaType: transcriptUpload.mediaType,
        sizeBytes: data.byteLength, sha256,
        ...(outputPath ? { path: outputPath } : {}),
        ...(options.returnBase64 ? { base64: data.toString("base64") } : {})
      };
    }
    if (!legacyMode && fileId.startsWith(TRANSCRIPT_FILE_HANDLE_PREFIX)) throw new Error("Inference-transcript attachment handle is unknown or expired; upload it again");
    if (legacyMode) {
      const legacy = options.legacy;
      if (!legacy) throw new Error("Legacy download input was missing");
      const sourceUrl = legacy.url.trim();
      const safeLength = sourceUrl.length <= 8_192 && !/[\0\r\n]/.test(sourceUrl);
      const rootRelative = safeLength && sourceUrl.startsWith("/") && !sourceUrl.startsWith("//");
      const notionAttachment = safeLength && /^attachment:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[^/\\]{1,2048}$/i.test(sourceUrl);
      let https = false;
      if (safeLength) {
        try { https = new URL(sourceUrl).protocol === "https:"; } catch { https = false; }
      }
      if (!rootRelative && !notionAttachment && !https) throw new Error("Legacy attachment URL must be HTTPS, root-relative, or a Notion attachment: URI");

      const fileName = legacy.fileName.trim();
      if (!fileName || Buffer.byteLength(fileName, "utf8") > 255 || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\") || /[\0\r\n]/.test(fileName)) {
        throw new Error("Legacy attachment fileName must be a plain file name of at most 255 UTF-8 bytes");
      }
      const table = legacy.permissionRecord.table.trim();
      const permissionId = legacy.permissionRecord.id.trim();
      const permissionSpaceId = legacy.permissionRecord.spaceId.trim();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (table.length > 64 || !/^[a-z][a-z0-9_]*$/.test(table) || !uuidPattern.test(permissionId) || !uuidPattern.test(permissionSpaceId)) {
        throw new Error("Legacy attachment permissionRecord is invalid");
      }
      if (permissionSpaceId !== account.spaceId) {
        throw new Error("Legacy attachment permissionRecord must belong to the active workspace; switch workspaces first");
      }
      const requestedMimeType = legacy.mimeType?.trim() ?? "";
      if (requestedMimeType.length > 255 || /[\r\n]/.test(requestedMimeType)) throw new Error("Legacy attachment mimeType is invalid");

      const descriptor = await this.fetchJson("getSignedFileUrls", {
        urls: [{
          url: sourceUrl,
          download: true,
          downloadName: fileName,
          permissionRecord: { table, id: permissionId, spaceId: permissionSpaceId }
        }]
      });
      const signedUrls = descriptor.signedUrls;
      if (!Array.isArray(signedUrls) || signedUrls.length !== 1) {
        throw new Error("getSignedFileUrls did not return exactly one signed URL");
      }
      const signedUrl = asString(signedUrls[0]).trim();
      if (!signedUrl) throw new Error("getSignedFileUrls returned an invalid signed URL");
      const signedDownloadUrl = new URL(validateSignedUrl(signedUrl, "Legacy attachment download"));
      const signedHost = signedDownloadUrl.hostname.toLowerCase();
      let downloadHeaders: HeadersInit | undefined;
      if (signedHost === "file.notion.so" || signedHost === "file.notion.com") {
        const fileToken = cookieValue(account.fullCookie, "file_token");
        if (!fileToken) {
          throw new Error("Legacy attachment download requires file_token in the account full_cookie or NOTION_FULL_COOKIE");
        }
        downloadHeaders = { cookie: `file_token=${fileToken}` };
      }
      const response = await this.signedRequest(
        signedDownloadUrl.toString(),
        { method: "GET", ...(downloadHeaders ? { headers: downloadHeaders } : {}) },
        "Legacy attachment download"
      );
      const data = await readResponseBuffer(response, maxBytes);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const mediaType = requestedMimeType || response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
      let outputPath: string | undefined;
      const requestedOutput = options.outputPath ?? (options.returnBase64 ? undefined : `downloads/${fileName}`);
      if (requestedOutput) outputPath = await writeAttachmentOutput(data, requestedOutput, this.config.attachmentRoot ?? process.cwd(), options.overwrite ?? false);
      return {
        source: "legacy_signed_url",
        fileName,
        mediaType,
        sizeBytes: data.byteLength,
        sha256,
        ...(outputPath ? { path: outputPath } : {}),
        ...(options.returnBase64 ? { base64: data.toString("base64") } : {})
      };
    }

    const descriptor = await this.fetchJson("getFileContentURLForAgentThread", {
      spaceId: account.spaceId,
      threadId: conversationId,
      fileId,
      includeFileMetadata: true
    });
    const url = asString(descriptor.url);
    if (!url) throw new Error("getFileContentURLForAgentThread did not return a URL");
    const metadata = object(descriptor.file);
    const metadataId = asString(metadata.id).trim();
    if (metadataId && metadataId !== fileId) throw new Error("Downloaded attachment metadata returned a different file ID");
    const declaredSize = metadata.size_bytes;
    if (declaredSize !== undefined && (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      throw new Error("Downloaded attachment metadata returned an invalid size");
    }
    if (typeof declaredSize === "number" && declaredSize > maxBytes) throw new Error(`Download exceeds the ${maxBytes}-byte limit`);
    const response = await this.signedRequest(url, { method: "GET" }, "Attachment download");
    const data = await readResponseBuffer(response, maxBytes);
    if (typeof declaredSize === "number" && Number.isSafeInteger(declaredSize) && declaredSize >= 0 && data.byteLength !== declaredSize) {
      throw new Error("Downloaded attachment size did not match Notion metadata");
    }
    const sha256 = asString(metadata.sha256).trim();
    if (sha256) {
      if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Downloaded attachment metadata returned an invalid checksum");
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual.toLowerCase() !== sha256.toLowerCase()) throw new Error("Downloaded attachment checksum did not match Notion metadata");
    }
    const rawName = asString(metadata.filename).replaceAll("\0", "").trim();
    const downloadedFileName = basename(rawName || `${fileId}.bin`) || `${fileId}.bin`;
    const mediaType = asString(metadata.media_type).trim() || response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
    let outputPath: string | undefined;
    const requestedOutput = options.outputPath ?? (options.returnBase64 ? undefined : `downloads/${downloadedFileName}`);
    if (requestedOutput) outputPath = await writeAttachmentOutput(data, requestedOutput, this.config.attachmentRoot ?? process.cwd(), options.overwrite ?? false);
    return {
      source: "agent_service",
      fileId,
      fileName: downloadedFileName,
      mediaType,
      sizeBytes: data.byteLength,
      ...(outputPath ? { path: outputPath } : {}),
      ...(options.returnBase64 ? { base64: data.toString("base64") } : {}),
      ...(sha256 ? { sha256 } : {})
    };
  }

  private async latestAgentTranscriptCursor(account: AccountContext, threadId: string): Promise<unknown> {
    let cursor: unknown;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await this.fetchJson("getThreadTranscript", {
        spaceId: account.spaceId,
        threadId,
        direction: "forward",
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {})
      });
      const next = page.forward_cursor;
      if (page.has_more_forward !== true) return next;
      if (next === undefined || Object.is(next, cursor)) throw new Error("getThreadTranscript pagination did not advance");
      cursor = next;
    }
    throw new Error("getThreadTranscript exceeded 100 pages");
  }

  private async waitForAgentServiceTurn(account: AccountContext, threadId: string, initialCursor: unknown): Promise<string> {
    const state = createAgentTranscriptState();
    const deadline = Date.now() + this.config.requestTimeoutMs;
    let cursor = initialCursor;
    while (Date.now() < deadline) {
      const page = await this.fetchJson("getThreadTranscript", {
        spaceId: account.spaceId,
        threadId,
        direction: "forward",
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {})
      });
      applyAgentTranscriptPatches(state, page.patches);
      const error = agentTranscriptError(state);
      if (error) throw new Error(`Notion Agent Service error: ${error}`);
      const text = latestAgentTranscriptText(state);
      if (text && isAgentTranscriptTurnComplete(state)) return text;
      const session = Object.keys(object(page.session)).length > 0 ? object(page.session) : state.session ?? {};
      const sessionStatus = asString(session.status);
      if (text && ["completed", "idle", "stopped"].includes(sessionStatus)) return text;
      const next = page.forward_cursor;
      const hasMore = page.has_more_forward === true;
      if (next !== undefined) cursor = next;
      if (!hasMore) await sleep(250);
    }
    throw new Error("Timed out waiting for the Notion Agent Service response");
  }

  private async agentServiceChat(account: AccountContext, model: string, session: ChatSession, options: ChatOptions, fileIds: string[], reasoningEffort?: string | undefined): Promise<ChatResult> {
    if (options.attachments?.length) throw new Error("For real file attachments, use upload_attachment and pass the returned IDs as fileIds");
    const content: JsonObject[] = [
      { type: "text", text: options.prompt },
      ...fileIds.map((fileId) => ({ type: "file", file_id: fileId }))
    ];
    const clientMessageId = randomUUID();
    const existing = session.turnCount > 0;
    const cursor = existing ? await this.latestAgentTranscriptCursor(account, session.threadId) : undefined;
    if (existing) {
      await this.fetchJson("sendEventToAgentThread", {
        spaceId: account.spaceId,
        threadId: session.threadId,
        event: { type: "user.message", content },
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        policies: { approval_mode: "ask" },
        browserEnabled: options.webSearch ?? this.config.defaultWebSearch,
        clientEventId: clientMessageId
      });
    } else {
      await this.fetchJson("createAgentThread", {
        type: "personal_agent",
        spaceId: account.spaceId,
        threadId: session.threadId,
        content,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        policies: { approval_mode: "ask" },
        browserEnabled: options.webSearch ?? this.config.defaultWebSearch,
        clientMessageId
      });
    }
    const text = await this.waitForAgentServiceTurn(account, session.threadId, cursor);
    if (!text.trim()) throw new Error("Notion Agent Service returned an empty response");
    session.turnCount += 1;
    session.model = model;
    session.reasoningEffort = reasoningEffort;
    session.transport = "agent_service";
    this.rememberSession(session);
    return { conversationId: session.threadId, text, model, ...(reasoningEffort ? { reasoningEffort } : {}), usage: { inputTokens: 0, outputTokens: 0 } };
  }

  /** Raw internal-API POST used by the management tools. */
  async apiPost(endpoint: string, body: JsonObject): Promise<JsonObject> { return this.fetchJson(endpoint, body); }

  mcp(): McpConnectionManager {
    this.mcpManager ??= new McpConnectionManager(
      {
        post: (endpoint, requestBody) => this.fetchJson(endpoint, requestBody),
        context: async () => {
          const account = await this.account();
          return { spaceId: account.spaceId, userId: account.userId, spaceViewId: account.spaceViewId };
        }
      },
      this.config.mcpRegistryPath
    );
    return this.mcpManager;
  }

  private workspaces(): WorkspaceManager {
    if (!this.workspaceManager) throw new Error("Workspace management requires a token_v2 credential");
    return this.workspaceManager;
  }

  async listWorkspaces(): Promise<Array<Record<string, unknown>>> {
    const account = await this.account();
    const all = await this.workspaces().listWorkspaces();
    return all.map((ws) => ({ ...ws, current: ws.spaceId === account.spaceId }));
  }

  async getCurrentWorkspace(): Promise<JsonObject> {
    const account = await this.account();
    return { spaceId: account.spaceId, spaceName: account.spaceName, spaceViewId: account.spaceViewId, userEmail: account.userEmail, pinnedSpaceId: this.workspaces().pinnedWorkspace() };
  }

  async switchWorkspace(selector: string, pin = false): Promise<JsonObject> {
    await this.account();
    const workspace = await this.workspaces().switchWorkspace(selector);
    if (pin) this.workspaces().pin(workspace.spaceId);
    this.accountPromise = null;
    this.sessions.clear();
    this.transcriptUploads.clear();
    return { ...workspace, pinned: pin };
  }

  async createWorkspace(name?: string, options: { pin?: boolean; switchTo?: boolean } = {}): Promise<JsonObject> {
    await this.account();
    const manager = this.workspaces();
    const shouldSwitch = options.switchTo !== false;
    const workspace = shouldSwitch
      ? await manager.createAndSwitchWorkspace(name, { pin: options.pin ?? true })
      : await manager.createWorkspace(name);
    if (shouldSwitch) { this.accountPromise = null; this.sessions.clear(); this.transcriptUploads.clear(); }
    return { ...workspace, switched: shouldSwitch, pinned: shouldSwitch ? (options.pin ?? true) : false };
  }
}
