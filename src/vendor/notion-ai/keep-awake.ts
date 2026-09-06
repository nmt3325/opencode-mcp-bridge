import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FinalStepShape, KeepAlive, KeepAliveStatus, ThreadSignals } from "./types.js";

export const KEEP_ALIVE_STATE_VERSION = 1;

/** A healthy turn goes quiet for 10-20s between steps, so anything under a minute produces false stalls. */
export const MIN_IDLE_MS = 60_000;
export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_NUDGES = 40;
export const DEFAULT_DEADLINE_MS = 3 * 60 * 60 * 1000;
export const MAX_TRACKED_KEEP_ALIVES = 100;
export const FINISHED_KEEP_ALIVE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Answers to Notion's step-limit prompt are capped and paced on their own, apart from nudges. */
export const DEFAULT_MAX_CONTINUES = 10;
export const DEFAULT_CONTINUE_COOLDOWN_MS = 15_000;
export const DEFAULT_CONFIRM_GRACE_MS = 10_000;

/**
 * Step count above which a closed-but-unfinished turn reads as Notion's step limit rather than a
 * crash. Measured on live threads: the turn that stopped on the prompt closed at 2992 steps, an
 * ordinary finish at 99.
 */
export const DEFAULT_STEP_LIMIT_STEPS = 2_000;

export type LeaseState = "free" | "held" | "stale";

/**
 * Reads how the thread's inference lease stands right now.
 *
 * Notion stamps `current_inference_id` on the thread for the duration of a turn and refuses a second
 * turn while it is set, so this is first-hand evidence of whether a chat can accept a nudge at all -
 * unlike the heartbeat, which only says when the thread was last written to.
 */
export function leaseState(signals: ThreadSignals): LeaseState {
  if (!signals.currentInferenceId) return "free";
  if (signals.leaseExpiration === null) return "held";
  return signals.leaseExpiration > signals.serverNow ? "held" : "stale";
}

/** Recognises the empty-stream answer Notion returns for a send against a thread that is still leased. */
export function isLockedError(message: string): boolean {
  return /no events|rejected the resumed thread state|inference lease/i.test(message);
}

/**
 * The prompt Notion writes when a long agent turn asks permission to spend more steps.
 *
 * The pause is a real step in the thread and the Continue button is client-side, so the wording of
 * that newest step is the only evidence a server-side watchdog has. Only the tail is matched: an
 * answer that merely talks about steps is not the prompt.
 */
const CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /taking a lot of steps/i,
  /confirm[^.?!]{0,80}keep going/i,
  /keep going\?/i,
  /続行しますか/,
  /続行してよ(い|ろしい)/
];

const CONFIRMATION_TAIL_LENGTH = 400;

export function isStepLimitConfirmation(text: string, extra: readonly RegExp[] = []): boolean {
  const tail = text.trim().slice(-CONFIRMATION_TAIL_LENGTH);
  if (!tail) return false;
  if ([...CONFIRMATION_PATTERNS, ...extra].some((pattern) => pattern.test(tail))) return true;
  // The Japanese wording moves around far more than the English one, so it is matched by parts.
  return tail.includes("ステップ") && (tail.includes("続行") || tail.includes("続け"));
}

/** Extra prompts to treat as the step-limit confirmation: one literal per line, case-insensitive. */
export function parseConfirmationPatterns(raw: string | undefined): RegExp[] {
  return (raw ?? "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

/**
 * True when a closed turn did not end on an answer.
 *
 * The step-limit prompt is never written to the thread, so the only durable trace of a turn Notion
 * stopped is the step it ended on: a finished answer is an agent-inference step carrying text, while
 * a turn that was cut off ends on a tool call that is still marked streaming.
 */
export function isUnfinishedFinalStep(shape: FinalStepShape | null | undefined): boolean {
  if (!shape) return false;
  return !shape.hasAnswerText;
}

/** True when an unfinished close ran long enough to be the step limit rather than an early death. */
export function isStepLimitStop(shape: FinalStepShape | null | undefined, stepCount: number | null, threshold = DEFAULT_STEP_LIMIT_STEPS): boolean {
  if (!isUnfinishedFinalStep(shape)) return false;
  return stepCount !== null && stepCount >= threshold;
}

export type KeepAwakeDecision =
  | { action: "wait"; reason: "healthy" | "cooldown" | "signals_unavailable" | "confirm_grace" }
  | { action: "continue"; reason: "awaiting_confirmation" }
  | { action: "nudge"; reason: "stalled"; idleMs: number }
  | { action: "stop"; reason: "turn_completed" | "max_nudges" | "max_continues" | "deadline" };

export interface KeepAwakeDecisionInput {
  now: number;
  anchorTime: number;
  signals: ThreadSignals | null;
  lastNudgeAt: number | null;
  nudgeCount: number;
  idleMs: number;
  cooldownMs: number;
  maxNudges: number;
  deadlineAt: number;
  /** The newest step is Notion's step-limit prompt, so the turn is one confirmation from resuming. */
  awaitingConfirmation?: boolean | undefined;
  /** False when the closed turn did not end on an answer, so the completion must not stop the watch. */
  completionIsAnswer?: boolean | undefined;
  continueCount?: number | undefined;
  maxContinues?: number | undefined;
  lastContinueAt?: number | null | undefined;
  continueCooldownMs?: number | undefined;
  confirmGraceMs?: number | undefined;
}

/**
 * Decides whether a watched conversation needs a nudge.
 *
 * updated_time freezing is ambiguous on its own: a turn that finished normally and a turn that died
 * mid-flight both stop the heartbeat. last_turn_outcome is only written when a turn closes, so an
 * outcome at or after the anchor proves the pause belongs to the first case. That check has to run
 * before the heartbeat check, otherwise a finished turn is nudged forever.
 */
export function decideKeepAwake(input: KeepAwakeDecisionInput): KeepAwakeDecision {
  if (input.now >= input.deadlineAt) return { action: "stop", reason: "deadline" };
  // A read that failed is not silence. Nudging blind would fire into a perfectly healthy turn.
  if (!input.signals) return { action: "wait", reason: "signals_unavailable" };

  // Notion closes the turn when it asks to keep going, so this has to be checked before the
  // completion rule: otherwise the watch ends on the prompt and nobody ever presses Continue.
  if (input.awaitingConfirmation) {
    const maxContinues = input.maxContinues ?? DEFAULT_MAX_CONTINUES;
    if ((input.continueCount ?? 0) >= maxContinues) return { action: "stop", reason: "max_continues" };
    const lastContinueAt = input.lastContinueAt ?? null;
    const continueCooldownMs = input.continueCooldownMs ?? DEFAULT_CONTINUE_COOLDOWN_MS;
    if (lastContinueAt !== null && input.now - lastContinueAt < continueCooldownMs) return { action: "wait", reason: "cooldown" };
    const writtenAt = input.signals.updatedTime;
    const confirmGraceMs = input.confirmGraceMs ?? DEFAULT_CONFIRM_GRACE_MS;
    // The prompt is written as a step, so a short grace keeps the answer from racing the rest of it.
    if (writtenAt !== null && input.now - writtenAt < confirmGraceMs) return { action: "wait", reason: "confirm_grace" };
    return { action: "continue", reason: "awaiting_confirmation" };
  }

  const outcome = input.signals.lastTurnOutcome;
  // Notion stamps "completed" on a turn it stopped itself, so a completion that did not end on an
  // answer is not a finish at all: it is a dead turn that still needs continuing.
  if (outcome && outcome.status === "completed" && outcome.completedTime !== null && outcome.completedTime >= input.anchorTime && input.completionIsAnswer !== false) {
    return { action: "stop", reason: "turn_completed" };
  }

  if (input.lastNudgeAt !== null && input.now - input.lastNudgeAt < input.cooldownMs) return { action: "wait", reason: "cooldown" };

  const updatedTime = input.signals.updatedTime;
  if (updatedTime === null) return { action: "wait", reason: "signals_unavailable" };
  const idleMs = input.now - updatedTime;
  if (idleMs <= input.idleMs) return { action: "wait", reason: "healthy" };
  if (input.nudgeCount >= input.maxNudges) return { action: "stop", reason: "max_nudges" };
  return { action: "nudge", reason: "stalled", idleMs };
}

function doneLine(token: string | undefined, language: "ja" | "en"): string {
  if (!token) return "";
  return language === "ja"
    ? `\nすでに完了しているなら、説明を足さず ${token} だけを返す。`
    : `\nIf the task is already done, reply with ${token} and nothing else.`;
}

/**
 * Builds the text sent to the stalled conversation.
 *
 * A bare "continue" invites the model to invent new work or to ask the user a question, and both
 * waste the turn. The machine tag makes the message identifiable, and the wording keeps the model
 * on the interrupted step.
 */
export function buildNudge(input: {
  nudgeCount: number;
  maxNudges: number;
  idleMs: number;
  language: "ja" | "en";
  doneToken?: string | undefined;
  custom?: string | undefined;
}): string {
  const header = `[KEEP-AWAKE ${input.nudgeCount}/${input.maxNudges}]`;
  if (input.custom) return `${header} ${input.custom}`;
  const seconds = Math.round(input.idleMs / 1000);
  const done = doneLine(input.doneToken, input.language);
  const isFinal = input.nudgeCount >= input.maxNudges;
  if (input.language === "en") {
    if (isFinal) return `${header} FINAL nudge. Do not start new work.\nSummarise what is done, what is left, and how to resume.${done}`;
    if (input.nudgeCount >= 3) return `${header} STALLED for ${seconds}s again. Do not repeat the same step.\nSplit it smaller or switch approach. Never ask the user a question.${done}`;
    return `${header} Automatic nudge, not a new instruction. Resume from where you stopped.\nWrite one line about the next step, then go straight to a tool call. Do not ask the user anything.${done}`;
  }
  if (isFinal) return `${header} FINAL 最後のナッジ。新しい作業は始めない。\n完了分・未完了分・再開手順をまとめる。${done}`;
  if (input.nudgeCount >= 3) return `${header} STALLED ${seconds}秒また停止した。同じ手順を繰り返さない。\n工程をより小さく分割するか別の手段に切り替える。ユーザーには質問しない。${done}`;
  return `${header} 自動ナッジ。新しい指示ではない。中断した箇所から作業を続行して。\n次にやることを1行書いたら、すぐツール呼び出しに移る。ユーザーへの質問・確認はしない。${done}`;
}

/**
 * Builds the reply to Notion's step-limit prompt.
 *
 * Continue is a confirmation, not a new instruction, so the text says only that: anything longer
 * invites the model to restate its plan or to ask the user something instead of resuming.
 */
export function buildContinue(input: {
  continueCount: number;
  maxContinues: number;
  language: "ja" | "en";
  doneToken?: string | undefined;
}): string {
  const header = `[KEEP-AWAKE CONTINUE ${input.continueCount}/${input.maxContinues}]`;
  const done = doneLine(input.doneToken, input.language);
  if (input.language === "en") {
    return `${header} Continue. This is an automatic answer to your confirmation prompt, not a new instruction.\nKeep going from the step you paused on and do not ask for confirmation again.${done}`;
  }
  return `${header} 続行を承認。確認プロンプトへの自動応答で、新しい指示ではない。\n止まったステップからそのまま作業を続行し、再度の確認は求めない。${done}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function statusOf(value: unknown): KeepAliveStatus | null {
  return value === "watching" || value === "completed" || value === "exhausted" || value === "expired" || value === "stopped" || value === "orphaned" ? value : null;
}
function languageOf(value: unknown): "ja" | "en" { return value === "en" ? "en" : "ja"; }

export function sanitizeKeepAlive(value: unknown): KeepAlive | null {
  if (!isRecord(value)) return null;
  const keepAliveId = text(value.keepAliveId);
  const conversationId = text(value.conversationId);
  const status = statusOf(value.status);
  const anchorTime = finite(value.anchorTime);
  const createdAt = finite(value.createdAt);
  const deadlineAt = finite(value.deadlineAt);
  if (!keepAliveId || !conversationId || !status || anchorTime === null || createdAt === null || deadlineAt === null) return null;
  const doneToken = text(value.doneToken);
  const message = text(value.message);
  const lastNudgeAt = finite(value.lastNudgeAt);
  const lastContinueAt = finite(value.lastContinueAt);
  const lastCheckedAt = finite(value.lastCheckedAt);
  const lastUpdatedTime = finite(value.lastUpdatedTime);
  const finishedAt = finite(value.finishedAt);
  const stopReason = text(value.stopReason);
  const lastError = text(value.lastError);
  return {
    keepAliveId,
    conversationId,
    // A watchdog still marked watching belongs to a dead process: its polling timer died with it,
    // so it is not watching anything any more and must not look alive in list_keep_alives.
    status: status === "watching" ? "orphaned" : status,
    anchorTime,
    createdAt,
    deadlineAt,
    idleMs: Math.max(finite(value.idleMs) ?? DEFAULT_IDLE_MS, MIN_IDLE_MS),
    pollMs: finite(value.pollMs) ?? DEFAULT_POLL_MS,
    cooldownMs: finite(value.cooldownMs) ?? DEFAULT_COOLDOWN_MS,
    maxNudges: finite(value.maxNudges) ?? DEFAULT_MAX_NUDGES,
    nudgeCount: finite(value.nudgeCount) ?? 0,
    autoContinue: value.autoContinue !== false,
    maxContinues: finite(value.maxContinues) ?? DEFAULT_MAX_CONTINUES,
    continueCount: finite(value.continueCount) ?? 0,
    language: languageOf(value.language),
    ...(doneToken ? { doneToken } : {}),
    ...(message ? { message } : {}),
    ...(lastNudgeAt !== null ? { lastNudgeAt } : {}),
    ...(lastContinueAt !== null ? { lastContinueAt } : {}),
    ...(lastCheckedAt !== null ? { lastCheckedAt } : {}),
    ...(lastUpdatedTime !== null ? { lastUpdatedTime } : {}),
    ...(finishedAt !== null ? { finishedAt } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(lastError ? { lastError } : {})
  };
}

/** Registry of keep-awake watchdogs, persisted so a restart does not silently drop them. */
export class KeepAliveStore {
  private readonly records = new Map<string, KeepAlive>();
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
    catch { this.lastPersistError = "keep-alive registry is not valid JSON; starting empty"; return; }
    if (!isRecord(parsed)) return;
    for (const candidate of Array.isArray(parsed.keepAlives) ? parsed.keepAlives : []) {
      const record = sanitizeKeepAlive(candidate);
      if (record) this.records.set(record.keepAliveId, record);
    }
    this.prune();
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload = JSON.stringify({ version: KEEP_ALIVE_STATE_VERSION, keepAlives: [...this.records.values()] });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
      this.lastPersistError = null;
    } catch (error) {
      // Losing the registry file must never break a running watchdog: memory stays authoritative.
      this.lastPersistError = error instanceof Error ? error.message : String(error);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of [...this.records]) {
      if (record.status === "watching") continue;
      if (now - (record.finishedAt ?? record.createdAt) > FINISHED_KEEP_ALIVE_RETENTION_MS) this.records.delete(id);
    }
    const excess = this.records.size - MAX_TRACKED_KEEP_ALIVES;
    if (excess <= 0) return;
    const ordered = [...this.records.values()].sort((left, right) => left.createdAt - right.createdAt);
    let removed = 0;
    for (const record of ordered) {
      if (removed >= excess) break;
      if (record.status === "watching") continue;
      this.records.delete(record.keepAliveId);
      removed += 1;
    }
  }

  create(input: {
    conversationId: string;
    anchorTime: number;
    createdAt: number;
    deadlineAt: number;
    idleMs: number;
    pollMs: number;
    cooldownMs: number;
    maxNudges: number;
    autoContinue: boolean;
    maxContinues: number;
    language: "ja" | "en";
    doneToken?: string | undefined;
    message?: string | undefined;
  }): KeepAlive {
    const record: KeepAlive = {
      keepAliveId: randomUUID(),
      conversationId: input.conversationId,
      status: "watching",
      anchorTime: input.anchorTime,
      createdAt: input.createdAt,
      deadlineAt: input.deadlineAt,
      idleMs: input.idleMs,
      pollMs: input.pollMs,
      cooldownMs: input.cooldownMs,
      maxNudges: input.maxNudges,
      nudgeCount: 0,
      autoContinue: input.autoContinue,
      maxContinues: input.maxContinues,
      continueCount: 0,
      language: input.language,
      ...(input.doneToken ? { doneToken: input.doneToken } : {}),
      ...(input.message ? { message: input.message } : {})
    };
    this.records.set(record.keepAliveId, record);
    this.prune();
    this.persist();
    return { ...record };
  }

  get(keepAliveId: string): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    return record ? { ...record } : null;
  }

  list(options: { status?: KeepAliveStatus | undefined; conversationId?: string | undefined; limit?: number | undefined } = {}): KeepAlive[] {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return [...this.records.values()]
      .filter((record) => (options.status ? record.status === options.status : true))
      .filter((record) => (options.conversationId ? record.conversationId === options.conversationId : true))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  watching(): KeepAlive[] { return [...this.records.values()].filter((record) => record.status === "watching").map((record) => ({ ...record })); }

  orphaned(): KeepAlive[] { return [...this.records.values()].filter((record) => record.status === "orphaned").map((record) => ({ ...record })); }

  /** Re-arms a watchdog that a restart orphaned, so a live process can adopt it. */
  revive(keepAliveId: string): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record || record.status !== "orphaned") return null;
    record.status = "watching";
    delete record.finishedAt;
    delete record.stopReason;
    this.persist();
    return { ...record };
  }

  noteCheck(keepAliveId: string, at: number, updatedTime: number | null, error?: string | undefined): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record) return null;
    record.lastCheckedAt = at;
    if (updatedTime !== null) record.lastUpdatedTime = updatedTime;
    if (error) record.lastError = error.slice(0, 500);
    else delete record.lastError;
    this.persist();
    return { ...record };
  }

  recordNudge(keepAliveId: string, at: number): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record) return null;
    record.nudgeCount += 1;
    record.lastNudgeAt = at;
    this.persist();
    return { ...record };
  }

  /** A confirmation answer is not a nudge, so it is counted and capped on its own. */
  recordContinue(keepAliveId: string, at: number): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record) return null;
    record.continueCount = (record.continueCount ?? 0) + 1;
    record.lastContinueAt = at;
    this.persist();
    return { ...record };
  }

  reanchor(keepAliveId: string, anchorTime: number, deadlineAt?: number | undefined): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record) return null;
    record.anchorTime = anchorTime;
    // A kick says the caller is still working, so a cooldown from an earlier nudge must not carry over.
    delete record.lastNudgeAt;
    if (deadlineAt !== undefined) record.deadlineAt = deadlineAt;
    this.persist();
    return { ...record };
  }

  finish(keepAliveId: string, status: KeepAliveStatus, at: number, reason: string): KeepAlive | null {
    const record = this.records.get(keepAliveId);
    if (!record) return null;
    record.status = status;
    record.finishedAt = at;
    record.stopReason = reason;
    this.persist();
    return { ...record };
  }
}

export interface KeepAwakeRuntime {
  readSignals: (conversationId: string) => Promise<ThreadSignals>;
  sendNudge: (conversationId: string, prompt: string) => Promise<void>;
  /** Newest user-visible text on the thread, used to spot Notion's step-limit prompt. */
  readTail?: ((conversationId: string) => Promise<string>) | undefined;
  /** Shape of the step a closed turn ended on: the durable half of the web client's Continue prompt. */
  readFinalStep?: ((conversationId: string, stepId: string) => Promise<FinalStepShape | null>) | undefined;
  /** Clears the thread's inference lease. Resolves true when a lease was actually cleared. */
  interrupt?: ((conversationId: string) => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
}

export interface KeepAwakeDefaults {
  /** Interrupt a held inference lease before nudging, like the web client's stop button. */
  interrupt: boolean;
  idleMs: number;
  pollMs: number;
  cooldownMs: number;
  maxNudges: number;
  deadlineMs: number;
  enabled: boolean;
  /** Answer Notion's step-limit prompt automatically, like pressing Continue in the web client. */
  autoContinue?: boolean | undefined;
  maxContinues?: number | undefined;
  continueCooldownMs?: number | undefined;
  confirmGraceMs?: number | undefined;
  continuePatterns?: readonly RegExp[] | undefined;
  stepLimitSteps?: number | undefined;
}

const STOP_STATUS: Record<"turn_completed" | "max_nudges" | "max_continues" | "deadline", KeepAliveStatus> = {
  turn_completed: "completed",
  max_nudges: "exhausted",
  max_continues: "exhausted",
  deadline: "expired"
};

/** Polls watched conversations and sends a nudge only when a turn stopped without closing. */
export class KeepAwakeSupervisor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: KeepAliveStore,
    private readonly runtime: KeepAwakeRuntime,
    private readonly defaults: KeepAwakeDefaults
  ) {}

  private now(): number { return this.runtime.now ? this.runtime.now() : Date.now(); }

  registry(): KeepAliveStore { return this.store; }

  async start(input: {
    conversationId: string;
    idleMs?: number | undefined;
    pollMs?: number | undefined;
    cooldownMs?: number | undefined;
    maxNudges?: number | undefined;
    deadlineMs?: number | undefined;
    autoContinue?: boolean | undefined;
    maxContinues?: number | undefined;
    language?: "ja" | "en" | undefined;
    doneToken?: string | undefined;
    message?: string | undefined;
  }): Promise<KeepAlive> {
    if (!this.defaults.enabled) throw new Error("keep_me_awake is disabled; set NOTION_KEEP_AWAKE=1 to enable it");
    const existing = this.store.watching().find((record) => record.conversationId === input.conversationId);
    if (existing) return existing;
    // The anchor is compared against completed_time, which Notion stamps on its own clock, so it has
    // to be a server value too. A first read that fails means the watchdog cannot be calibrated, and
    // arming it anyway would either nudge a healthy chat or never nudge at all.
    const signals = await this.runtime.readSignals(input.conversationId);
    const anchorTime = signals.updatedTime ?? signals.serverNow;
    const record = this.store.create({
      conversationId: input.conversationId,
      anchorTime,
      createdAt: signals.serverNow,
      deadlineAt: signals.serverNow + (input.deadlineMs ?? this.defaults.deadlineMs),
      idleMs: Math.max(input.idleMs ?? this.defaults.idleMs, MIN_IDLE_MS),
      pollMs: input.pollMs ?? this.defaults.pollMs,
      cooldownMs: input.cooldownMs ?? this.defaults.cooldownMs,
      maxNudges: input.maxNudges ?? this.defaults.maxNudges,
      autoContinue: input.autoContinue ?? this.defaults.autoContinue ?? true,
      maxContinues: input.maxContinues ?? this.defaults.maxContinues ?? DEFAULT_MAX_CONTINUES,
      language: input.language ?? "ja",
      ...(input.doneToken ? { doneToken: input.doneToken } : {}),
      ...(input.message ? { message: input.message } : {})
    });
    this.schedule(record.keepAliveId, record.pollMs);
    return record;
  }

  async tick(keepAliveId: string): Promise<{ decision: KeepAwakeDecision; keepAlive: KeepAlive | null }> {
    const record = this.store.get(keepAliveId);
    if (!record || record.status !== "watching") return { decision: { action: "wait", reason: "healthy" }, keepAlive: record };
    let signals: ThreadSignals | null = null;
    let failure = "";
    try { signals = await this.runtime.readSignals(record.conversationId); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    // One read gives both signals from the same record, so the heartbeat and the outcome can never
    // disagree about which turn they describe.
    const now = signals ? signals.serverNow : this.now();
    this.store.noteCheck(keepAliveId, now, signals?.updatedTime ?? null, failure || undefined);
    const probe = await this.inspectCompletion(record, signals, now);
    const decision = decideKeepAwake({
      now,
      anchorTime: record.anchorTime,
      signals,
      lastNudgeAt: record.lastNudgeAt ?? null,
      nudgeCount: record.nudgeCount,
      idleMs: record.idleMs,
      cooldownMs: record.cooldownMs,
      maxNudges: record.maxNudges,
      deadlineAt: record.deadlineAt,
      awaitingConfirmation: probe.awaitingConfirmation,
      completionIsAnswer: probe.completionIsAnswer,
      continueCount: record.continueCount ?? 0,
      maxContinues: record.maxContinues ?? DEFAULT_MAX_CONTINUES,
      lastContinueAt: record.lastContinueAt ?? null,
      ...(this.defaults.continueCooldownMs === undefined ? {} : { continueCooldownMs: this.defaults.continueCooldownMs }),
      ...(this.defaults.confirmGraceMs === undefined ? {} : { confirmGraceMs: this.defaults.confirmGraceMs })
    });
    if (decision.action === "stop") {
      this.cancel(keepAliveId);
      this.store.finish(keepAliveId, STOP_STATUS[decision.reason], now, decision.reason);
    } else if (decision.action === "nudge" || decision.action === "continue") {
      // A confirmation answer travels the same path as a nudge: same lease handling, same retry.
      const isContinue = decision.action === "continue";
      const prompt = isContinue
        ? buildContinue({
            continueCount: (record.continueCount ?? 0) + 1,
            maxContinues: record.maxContinues ?? DEFAULT_MAX_CONTINUES,
            language: record.language,
            ...(record.doneToken ? { doneToken: record.doneToken } : {})
          })
        : buildNudge({
            nudgeCount: record.nudgeCount + 1,
            maxNudges: record.maxNudges,
            idleMs: decision.action === "nudge" ? decision.idleMs : 0,
            language: record.language,
            ...(record.doneToken ? { doneToken: record.doneToken } : {}),
            ...(record.message ? { custom: record.message } : {})
          });
      // Notion holds a lease on the thread while an inference is in flight and answers a second turn
      // with an empty stream instead of an error, so a turn that stopped without releasing its lease
      // has to be interrupted the way the web client's stop button does before a nudge can land.
      const lease = signals ? leaseState(signals) : "free";
      const canInterrupt = this.defaults.interrupt && Boolean(this.runtime.interrupt);
      let interrupted = false;
      try {
        if (canInterrupt && lease !== "free") interrupted = await this.interruptLease(record.conversationId);
        await this.runtime.sendNudge(record.conversationId, prompt);
        this.noteDelivery(keepAliveId, now, isContinue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A rejected nudge leaves no step behind, so one retry behind an interrupt cannot duplicate work.
        if (canInterrupt && !interrupted && isLockedError(message)) {
          try {
            await this.interruptLease(record.conversationId);
            await this.runtime.sendNudge(record.conversationId, prompt);
            this.noteDelivery(keepAliveId, now, isContinue);
            return { decision, keepAlive: this.store.get(keepAliveId) };
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            this.store.noteCheck(keepAliveId, now, signals?.updatedTime ?? null, retryMessage);
            return { decision, keepAlive: this.store.get(keepAliveId) };
          }
        }
        // A nudge that could not be delivered must not burn a slot from the budget.
        this.store.noteCheck(keepAliveId, now, signals?.updatedTime ?? null, message);
      }
    }
    return { decision, keepAlive: this.store.get(keepAliveId) };
  }

  /** Re-anchors a watchdog to the current heartbeat, which also clears any pending cooldown. */
  async kick(keepAliveId: string): Promise<KeepAlive | null> {
    const record = this.store.get(keepAliveId);
    if (!record || record.status !== "watching") return record;
    const signals = await this.runtime.readSignals(record.conversationId);
    const updated = this.store.reanchor(keepAliveId, signals.updatedTime ?? signals.serverNow);
    this.schedule(keepAliveId, record.pollMs);
    return updated;
  }

  /**
   * Adopts watchdogs left behind by an earlier process.
   *
   * Every entry still marked watching in the registry belongs to a process whose polling timers died
   * with it, so loading downgrades it to orphaned. Only a process that intends to keep polling may
   * take those entries back, which is why this is an explicit call and not part of the constructor.
   */
  resume(): KeepAlive[] {
    if (!this.defaults.enabled) return [];
    const now = this.now();
    const resumed: KeepAlive[] = [];
    for (const record of this.store.orphaned()) {
      // A watchdog whose deadline passed while nobody was watching has nothing left to do.
      if (record.deadlineAt <= now) {
        this.store.finish(record.keepAliveId, "expired", now, "deadline");
        continue;
      }
      const revived = this.store.revive(record.keepAliveId);
      if (!revived) continue;
      this.schedule(revived.keepAliveId, revived.pollMs);
      resumed.push(revived);
    }
    return resumed;
  }

  stop(keepAliveId: string): KeepAlive | null {
    const record = this.store.get(keepAliveId);
    if (!record) return null;
    this.cancel(keepAliveId);
    if (record.status !== "watching") return record;
    return this.store.finish(keepAliveId, "stopped", this.now(), "stopped_by_caller");
  }

  stopAll(): KeepAlive[] {
    return this.store.watching().map((record) => this.stop(record.keepAliveId)).filter((record): record is KeepAlive => record !== null);
  }

  list(options: { status?: KeepAliveStatus | undefined; conversationId?: string | undefined; limit?: number | undefined } = {}): KeepAlive[] {
    return this.store.list(options);
  }

  private schedule(keepAliveId: string, pollMs: number): void {
    this.cancel(keepAliveId);
    const timer = setTimeout(() => {
      void this.tick(keepAliveId)
        .then((outcome) => { if (outcome.keepAlive?.status === "watching") this.schedule(keepAliveId, outcome.keepAlive.pollMs); })
        .catch(() => { this.schedule(keepAliveId, pollMs); });
    }, pollMs);
    timer.unref?.();
    this.timers.set(keepAliveId, timer);
  }

  private noteDelivery(keepAliveId: string, at: number, isContinue: boolean): void {
    if (isContinue) this.store.recordContinue(keepAliveId, at);
    else this.store.recordNudge(keepAliveId, at);
  }

  /**
   * Reads the newest user-visible step, but only when the turn already looks paused.
   *
   * Every poll costs one thread read already, and a turn that is plainly still working cannot be
   * sitting on a confirmation prompt, so probing the transcript then would double the traffic for
   * nothing.
   */
  private async inspectCompletion(record: KeepAlive, signals: ThreadSignals | null, now: number): Promise<{ awaitingConfirmation: boolean; completionIsAnswer: boolean }> {
    // Nothing learned means nothing changes: the watch keeps behaving exactly as it did before.
    const inconclusive = { awaitingConfirmation: false, completionIsAnswer: true };
    if (!signals) return inconclusive;
    if (record.autoContinue === false || this.defaults.autoContinue === false) return inconclusive;
    const outcome = signals.lastTurnOutcome;
    const closed = Boolean(outcome && outcome.completedTime !== null && outcome.completedTime >= record.anchorTime);
    const confirmGraceMs = this.defaults.confirmGraceMs ?? DEFAULT_CONFIRM_GRACE_MS;
    const quiet = signals.updatedTime !== null && now - signals.updatedTime >= confirmGraceMs;
    if (!closed && !quiet) return inconclusive;
    // Kept as insurance. If Notion ever does write the prompt into the thread, matching the text is
    // the most direct evidence available, and it costs one transcript page.
    if (this.runtime.readTail) {
      try {
        if (isStepLimitConfirmation(await this.runtime.readTail(record.conversationId), this.defaults.continuePatterns ?? [])) {
          return { awaitingConfirmation: true, completionIsAnswer: false };
        }
      } catch {
        // A failed transcript read is not evidence of anything; the next poll tries again.
      }
    }
    if (!closed || !this.runtime.readFinalStep || !outcome?.finalStepId) return inconclusive;
    try {
      const shape = await this.runtime.readFinalStep(record.conversationId, outcome.finalStepId);
      if (!isUnfinishedFinalStep(shape)) return inconclusive;
      // Unfinished either way, so the watch must not stop; the step count only decides whether the
      // answer is a Continue click or an ordinary nudge.
      return { awaitingConfirmation: isStepLimitStop(shape, outcome.stepCount, this.defaults.stepLimitSteps ?? DEFAULT_STEP_LIMIT_STEPS), completionIsAnswer: false };
    } catch {
      return inconclusive;
    }
  }

  /** Clears a held inference lease, reproducing the persisted half of the web client's stop button. */
  private async interruptLease(conversationId: string): Promise<boolean> {
    if (!this.runtime.interrupt) return false;
    return await this.runtime.interrupt(conversationId);
  }

  private cancel(keepAliveId: string): void {
    const timer = this.timers.get(keepAliveId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(keepAliveId);
  }
}
