import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatJob, ChatJobStatus, ChatJobUsage, ChatSession } from "./types.js";

export const STATE_VERSION = 1;
export const MAX_TRACKED_JOBS = 200;
export const MAX_TRACKED_SESSIONS = 200;
export const FINISHED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_TEXT = 20000;
const MAX_PROMPT_PREVIEW = 500;

/** Default location of the resume cache: jobs and chat sessions survive a server restart. */
export function defaultStateFilePath(): string {
  let base = "";
  try { base = homedir(); } catch { base = ""; }
  return join(base || tmpdir(), ".notion-ai-mcp", "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}...` : value; }
function usageOf(value: unknown): ChatJobUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = finite(value.inputTokens);
  const outputTokens = finite(value.outputTokens);
  if (inputTokens === null || outputTokens === null) return undefined;
  return { inputTokens, outputTokens };
}
function jobStatus(value: unknown): ChatJobStatus | null {
  return value === "running" || value === "completed" || value === "failed" || value === "orphaned" ? value : null;
}
function transportOf(value: unknown): "inference_transcript" | "agent_service" {
  return value === "agent_service" ? "agent_service" : "inference_transcript";
}

export function sanitizeJob(value: unknown): ChatJob | null {
  if (!isRecord(value)) return null;
  const jobId = text(value.jobId);
  const conversationId = text(value.conversationId);
  const status = jobStatus(value.status);
  const startedAt = finite(value.startedAt);
  if (!jobId || !conversationId || !status || startedAt === null) return null;
  const finishedAt = finite(value.finishedAt);
  const answer = text(value.text);
  const error = text(value.error);
  const effort = text(value.reasoningEffort);
  const parsedUsage = usageOf(value.usage);
  return {
    jobId,
    conversationId,
    // A job still marked running in the cache belongs to a dead process: Notion kept generating, but this process cannot await that stream.
    status: status === "running" ? "orphaned" : status,
    model: text(value.model),
    ...(effort ? { reasoningEffort: effort } : {}),
    promptPreview: clip(text(value.promptPreview), MAX_PROMPT_PREVIEW),
    turn: finite(value.turn) ?? 1,
    transport: transportOf(value.transport),
    startedAt,
    ...(finishedAt !== null ? { finishedAt } : {}),
    ...(answer ? { text: answer } : {}),
    ...(error ? { error } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {})
  };
}

export function sanitizeSession(value: unknown): ChatSession | null {
  if (!isRecord(value)) return null;
  const threadId = text(value.threadId);
  const configId = text(value.configId);
  const contextId = text(value.contextId);
  if (!threadId || !configId || !contextId) return null;
  const effort = text(value.reasoningEffort);
  return {
    threadId,
    configId,
    contextId,
    originalDatetime: text(value.originalDatetime) || new Date().toISOString(),
    model: text(value.model),
    ...(effort ? { reasoningEffort: effort } : {}),
    updatedConfigIds: Array.isArray(value.updatedConfigIds) ? value.updatedConfigIds.filter((id): id is string => typeof id === "string") : [],
    turnCount: finite(value.turnCount) ?? 1,
    transport: transportOf(value.transport),
    ...(value.rehydrated === true ? { rehydrated: true } : {})
  };
}

/**
 * Tracks background chat jobs and chat sessions.
 *
 * MCP clients abandon a request after about 60 seconds, so a slow Notion AI answer must be
 * recoverable afterwards. Jobs keep the conversation ID and the final text; sessions are cached
 * on disk so a conversation can still be continued after the server process restarts.
 */
export class ChatStateStore {
  private readonly jobRecords = new Map<string, ChatJob>();
  private readonly sessionRecords = new Map<string, ChatSession>();
  private readonly waiters = new Map<string, Set<(job: ChatJob) => void>>();
  private lastPersistError: string | null = null;

  constructor(private readonly filePath: string | null = null) { this.load(); }

  statePath(): string | null { return this.filePath; }
  persistError(): string | null { return this.lastPersistError; }

  private load(): void {
    if (!this.filePath) return;
    let raw = "";
    try { raw = readFileSync(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.lastPersistError = error instanceof Error ? error.message : String(error);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { this.lastPersistError = "resume cache is not valid JSON; starting from an empty cache"; return; }
    if (!isRecord(parsed)) return;
    for (const candidate of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
      const job = sanitizeJob(candidate);
      if (job) this.jobRecords.set(job.jobId, job);
    }
    for (const candidate of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
      const session = sanitizeSession(candidate);
      if (session) this.sessionRecords.set(session.threadId, session);
    }
    this.prune();
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload = JSON.stringify({
      version: STATE_VERSION,
      jobs: [...this.jobRecords.values()].map((job) => (job.text ? { ...job, text: clip(job.text, MAX_PERSISTED_TEXT) } : { ...job })),
      sessions: [...this.sessionRecords.values()]
    });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
      this.lastPersistError = null;
    } catch (error) {
      // A cache write must never fail a chat: the tool result itself stays authoritative.
      this.lastPersistError = error instanceof Error ? error.message : String(error);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [jobId, job] of [...this.jobRecords]) {
      if (job.status === "running") continue;
      if (now - (job.finishedAt ?? job.startedAt) > FINISHED_JOB_RETENTION_MS) this.jobRecords.delete(jobId);
    }
    const excessJobs = this.jobRecords.size - MAX_TRACKED_JOBS;
    if (excessJobs > 0) {
      const ordered = [...this.jobRecords.values()].sort((left, right) => left.startedAt - right.startedAt);
      let removed = 0;
      for (const job of ordered) {
        if (removed >= excessJobs) break;
        if (job.status === "running") continue;
        this.jobRecords.delete(job.jobId);
        removed += 1;
      }
    }
    const excessSessions = this.sessionRecords.size - MAX_TRACKED_SESSIONS;
    if (excessSessions > 0) {
      for (const key of [...this.sessionRecords.keys()].slice(0, excessSessions)) this.sessionRecords.delete(key);
    }
  }

  createJob(input: { conversationId: string; model: string; reasoningEffort?: string | undefined; prompt: string; turn: number; transport: "inference_transcript" | "agent_service" }): ChatJob {
    const job: ChatJob = {
      jobId: randomUUID(),
      conversationId: input.conversationId,
      status: "running",
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      promptPreview: clip(input.prompt, MAX_PROMPT_PREVIEW),
      turn: input.turn,
      transport: input.transport,
      startedAt: Date.now()
    };
    this.jobRecords.set(job.jobId, job);
    this.prune();
    this.persist();
    return { ...job };
  }

  retarget(jobId: string, conversationId: string): void {
    const job = this.jobRecords.get(jobId);
    if (!job || !conversationId || job.conversationId === conversationId) return;
    job.conversationId = conversationId;
    this.persist();
  }

  complete(jobId: string, result: { text: string; usage?: ChatJobUsage | undefined; conversationId?: string | undefined; model?: string | undefined; reasoningEffort?: string | undefined }): ChatJob | null {
    const job = this.jobRecords.get(jobId);
    if (!job) return null;
    job.status = "completed";
    job.text = result.text;
    if (result.usage) job.usage = result.usage;
    if (result.conversationId) job.conversationId = result.conversationId;
    if (result.model) job.model = result.model;
    if (result.reasoningEffort) job.reasoningEffort = result.reasoningEffort;
    return this.settle(job);
  }

  fail(jobId: string, message: string): ChatJob | null {
    const job = this.jobRecords.get(jobId);
    if (!job) return null;
    job.status = "failed";
    job.error = clip(message, 2000);
    return this.settle(job);
  }

  private settle(job: ChatJob): ChatJob {
    job.finishedAt = Date.now();
    this.persist();
    const listeners = this.waiters.get(job.jobId);
    if (listeners) {
      this.waiters.delete(job.jobId);
      for (const listener of listeners) {
        try { listener({ ...job }); } catch { /* a waiter that already gave up must not break the job */ }
      }
    }
    return { ...job };
  }

  job(jobId: string): ChatJob | null {
    const job = this.jobRecords.get(jobId);
    return job ? { ...job } : null;
  }

  latestForConversation(conversationId: string): ChatJob | null {
    let latest: ChatJob | null = null;
    for (const job of this.jobRecords.values()) {
      if (job.conversationId !== conversationId) continue;
      if (!latest || job.startedAt >= latest.startedAt) latest = job;
    }
    return latest ? { ...latest } : null;
  }

  list(options: { status?: ChatJobStatus | undefined; limit?: number | undefined } = {}): ChatJob[] {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return [...this.jobRecords.values()]
      .filter((job) => (options.status ? job.status === options.status : true))
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  /** Resolves as soon as the job settles, or with the still-running snapshot once timeoutMs passes. */
  async wait(jobId: string, timeoutMs: number): Promise<ChatJob | null> {
    const current = this.jobRecords.get(jobId);
    if (!current) return null;
    if (current.status !== "running" || timeoutMs <= 0) return { ...current };
    return new Promise<ChatJob | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const listeners = this.waiters.get(jobId) ?? new Set<(job: ChatJob) => void>();
      const listener = (job: ChatJob): void => { clearTimeout(timer); resolve(job); };
      listeners.add(listener);
      this.waiters.set(jobId, listeners);
      timer = setTimeout(() => {
        listeners.delete(listener);
        if (listeners.size === 0) this.waiters.delete(jobId);
        const snapshot = this.jobRecords.get(jobId);
        resolve(snapshot ? { ...snapshot } : null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  sessions(): ChatSession[] { return [...this.sessionRecords.values()].map((session) => ({ ...session })); }

  saveSession(session: ChatSession): void {
    this.sessionRecords.set(session.threadId, { ...session });
    this.prune();
    this.persist();
  }
}
