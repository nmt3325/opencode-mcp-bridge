export interface AccountContext { tokenV2:string; userId:string; userName:string; userEmail:string; spaceId:string; spaceName:string; spaceViewId:string; timezone:string; clientVersion:string; browserId:string; deviceId:string; fullCookie?:string; pinnedSpaceId?:string }
export interface WorkspaceInfo { spaceId:string; spaceViewId:string; spaceName:string; plan:string; createdTime:number|null }
export interface ConversationSummary { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messageCount:number; unread:boolean }
export interface ConversationMessage { id:string; role:"user"|"assistant"; text:string; createdAt:number|null }
export interface Conversation { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messages:ConversationMessage[] }
export interface ListConversationsResult { conversations:ConversationSummary[]; nextCursor:string|null; hasMore:boolean }
export interface ChatResult { conversationId:string; text:string; model:string; reasoningEffort?:string|undefined; usage:{inputTokens:number;outputTokens:number} }
export interface ChatSession { threadId:string; configId:string; contextId:string; originalDatetime:string; model:string; reasoningEffort?:string|undefined; updatedConfigIds:string[]; turnCount:number; transport?:"inference_transcript"|"agent_service"; rehydrated?:boolean|undefined }
export interface ParsedInferenceStream { text:string; inputTokens:number; outputTokens:number; eventTypes:Record<string,number> }
export interface ChatAttachment { name:string; url?:string|undefined; text?:string|undefined; mimeType?:string|undefined }

export interface AgentUploadedFile { id:string; filename:string; media_type:string; size_bytes:number; sha256?:string|undefined }
export interface AttachmentUploadResult { transport:"agent_service"|"inference_transcript"; fileId:string; conversationId?:string|undefined; fileName:string; mediaType:string; sizeBytes:number; sha256?:string|undefined; processedForInference?:boolean|undefined; target:{type:"user"}|{type:"thread";threadId:string}; file:AgentUploadedFile }
export interface LegacyAttachmentDownloadInput { url:string; fileName:string; mimeType?:string|undefined; permissionRecord:{table:string;id:string;spaceId:string} }
export interface AttachmentDownloadResult { source:"agent_service"|"inference_transcript"|"legacy_signed_url"; fileId?:string|undefined; fileName:string; mediaType:string; sizeBytes:number; path?:string|undefined; base64?:string|undefined; sha256?:string|undefined }

export type ChatJobStatus = "running"|"completed"|"failed"|"orphaned";
export interface ChatJobUsage { inputTokens:number; outputTokens:number }
export interface ChatJob { jobId:string; conversationId:string; status:ChatJobStatus; model:string; reasoningEffort?:string|undefined; promptPreview:string; turn:number; transport:"inference_transcript"|"agent_service"; startedAt:number; finishedAt?:number|undefined; text?:string|undefined; error?:string|undefined; usage?:ChatJobUsage|undefined }
export interface ChatStartResult { status:"running"; jobId:string; conversationId:string; model:string; reasoningEffort?:string|undefined; startedAt:number; rehydrated?:boolean|undefined; hint:string }
export interface CompletedChatResult extends ChatResult { status:"completed"; jobId:string; rehydrated?:boolean|undefined }
export interface PendingChatResult { status:"pending"; jobId:string; conversationId:string; model:string; reasoningEffort?:string|undefined; startedAt:number; elapsedMs:number; rehydrated?:boolean|undefined; hint:string }
export type ChatWaitResult = CompletedChatResult|PendingChatResult;
export interface ChatJobLookup { status:ChatJobStatus; source:"job"|"thread"; conversationId:string; jobId?:string|undefined; model?:string|undefined; reasoningEffort?:string|undefined; text?:string|undefined; error?:string|undefined; usage?:ChatJobUsage|undefined; startedAt?:number|undefined; finishedAt?:number|undefined; elapsedMs?:number|undefined; hint?:string|undefined }

/** One closed turn, as Notion records it in thread.data.last_turn_outcome. */
export interface TurnOutcome { status:string; completedTime:number|null; stepCount:number|null; inferenceId:string; finalStepId:string }
/**
 * The signals the keep-awake watchdog reads from a single thread record.
 *
 * updatedTime is the heartbeat: it matches the created_time of the newest step. lastTurnOutcome is
 * only written when a turn closes, which is the only way to tell a finished turn apart from a turn
 * that died mid-flight, because both freeze the heartbeat. serverNow is the Date response header, so
 * every comparison stays on Notion's clock instead of depending on local clock skew.
 */
export interface ThreadSignals { threadId:string; updatedTime:number|null; serverNow:number; messageCount:number; lastTurnOutcome:TurnOutcome|null; credits:number|null;
  currentInferenceId: string;
  leaseExpiration: number | null;
}

/**
 * The shape of the step a closed turn ended on.
 *
 * Notion writes last_turn_outcome.status = "completed" even when it stopped the turn on its own
 * step-limit prompt, and that prompt is drawn from the live stream and never stored as a step, so
 * the status alone cannot tell a finished answer from a turn that was cut off. A real answer ends on
 * an agent-inference step carrying text; a cut-off turn ends on a tool call still marked streaming.
 */
export interface FinalStepShape { stepId:string; type:string; state:string; hasAnswerText:boolean; finishedAt:number|null }

export interface InterruptResult {
  threadId: string;
  cleared: boolean;
  inferenceId: string;
  leaseExpiration: number | null;
}

export type KeepAliveStatus = "watching"|"completed"|"exhausted"|"expired"|"stopped"|"orphaned";
export interface KeepAlive {
  keepAliveId:string;
  conversationId:string;
  status:KeepAliveStatus;
  /** Heartbeat value at registration. A turn that closed at or after this belongs to the watched work. */
  anchorTime:number;
  createdAt:number;
  deadlineAt:number;
  idleMs:number;
  pollMs:number;
  cooldownMs:number;
  maxNudges:number;
  nudgeCount:number;
  /** Answer Notion's step-limit prompt automatically, the way the web client's Continue button does. */
  autoContinue?:boolean|undefined;
  maxContinues?:number|undefined;
  continueCount?:number|undefined;
  lastContinueAt?:number|undefined;
  language:"ja"|"en";
  doneToken?:string|undefined;
  message?:string|undefined;
  lastNudgeAt?:number|undefined;
  lastCheckedAt?:number|undefined;
  lastUpdatedTime?:number|undefined;
  finishedAt?:number|undefined;
  stopReason?:string|undefined;
  lastError?:string|undefined;
}
