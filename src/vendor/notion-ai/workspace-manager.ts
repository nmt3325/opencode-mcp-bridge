import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { AccountContext, WorkspaceInfo } from "./types.js";

function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function asNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
export function unwrapRecord(value: unknown): Record<string, unknown> { let current = object(value); for (let i = 0; i < 5; i += 1) { const nested = current.value; if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break; current = object(nested); } return current; }

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export function createSpaceScopedId(spaceId: string): string {
  const compactSpaceId = spaceId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compactSpaceId)) return randomUUID();
  const random = randomUUID().replaceAll("-", "");
  const compact = `${random.slice(0, 3)}${compactSpaceId.slice(3, 12)}8${random.slice(13)}`;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export interface WorkspaceManagerOptions {
  discoveryAttempts?: number;
  discoveryDelayMs?: number;
  requestTimeoutMs?: number;
}

export class WorkspaceManager {
  private exhausted = new Set<string>();
  private accountPath: string | null;
  private pinnedSpaceId: string | null = null;
  private discoveryAttempts: number;
  private discoveryDelayMs: number;
  private requestTimeoutMs: number;

  constructor(
    private account: AccountContext,
    private configBase: string,
    private fetchFn: typeof fetch,
    accountFilePath?: string,
    options: WorkspaceManagerOptions = {}
  ) {
    this.accountPath = accountFilePath || null;
    this.pinnedSpaceId = account.pinnedSpaceId?.trim() || null;
    this.discoveryAttempts = Math.max(1, Math.floor(options.discoveryAttempts ?? 8));
    this.discoveryDelayMs = Math.max(0, Math.floor(options.discoveryDelayMs ?? 250));
    this.requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? 30_000));
  }

  private requestHeaders(spaceId = this.account.spaceId): Record<string, string> {
    const cookie = this.account.fullCookie?.trim() || [
      this.account.browserId ? `notion_browser_id=${this.account.browserId}` : "",
      this.account.deviceId ? `device_id=${this.account.deviceId}` : "",
      this.account.userId ? `notion_user_id=${this.account.userId}` : "",
      this.account.userId ? `notion_users=[%22${this.account.userId}%22]` : "",
      `token_v2=${this.account.tokenV2}`
    ].filter(Boolean).join("; ");
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      "notion-audit-log-platform": "web",
      origin: "https://app.notion.com",
      referer: "https://app.notion.com/",
      "user-agent": USER_AGENT
    };
    if (this.account.clientVersion) headers["notion-client-version"] = this.account.clientVersion;
    if (this.account.userId) headers["x-notion-active-user-header"] = this.account.userId;
    if (spaceId) headers["x-notion-space-id"] = spaceId;
    return headers;
  }

  private async postJson(endpoint: string, body: unknown, spaceId = this.account.spaceId): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(`${this.configBase}/${endpoint}`, {
      method: "POST",
      headers: this.requestHeaders(spaceId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retryDetail = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
      throw new Error(`${endpoint} returned HTTP ${response.status}.${retryDetail}${text ? ` Body: ${text.slice(0, 500)}` : ""}`);
    }
    if (!text.trim()) return {};
    try { return object(JSON.parse(text) as unknown); }
    catch { throw new Error(`${endpoint} returned invalid JSON`); }
  }

  private persistAccount(): void {
    if (!this.accountPath) return;
    const data: Record<string, unknown> = {};
    try {
      const existing = JSON.parse(readFileSync(this.accountPath, "utf8")) as unknown;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) Object.assign(data, existing);
    } catch {
      // A missing account file is valid on the first write; all required values are supplied below.
    }
    Object.assign(data, {
      token_v2: this.account.tokenV2,
      user_id: this.account.userId,
      user_name: this.account.userName,
      user_email: this.account.userEmail,
      space_id: this.account.spaceId,
      space_view_id: this.account.spaceViewId,
      space_name: this.account.spaceName,
      timezone: this.account.timezone,
      client_version: this.account.clientVersion,
      browser_id: this.account.browserId,
      device_id: this.account.deviceId
    });
    if (this.account.fullCookie) data.full_cookie = this.account.fullCookie;
    if (this.pinnedSpaceId) data.pinned_space_id = this.pinnedSpaceId;
    else delete data.pinned_space_id;
    writeFileSync(this.accountPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.accountPath, 0o600);
  }

  private parseWorkspaces(payload: Record<string, unknown>): WorkspaceInfo[] {
    const recordMap = object(payload.recordMap);
    const userRoots = object(recordMap.user_root);
    const userId = this.account.userId || Object.keys(userRoots)[0] || "";
    const root = unwrapRecord(userRoots[userId]);
    const pointers = Array.isArray(root.space_view_pointers) ? root.space_view_pointers : [];
    const spaces = object(recordMap.space);
    const results: WorkspaceInfo[] = [];
    const seen = new Set<string>();
    for (const rawPointer of pointers) {
      const pointer = object(rawPointer);
      const spaceId = asString(pointer.spaceId);
      const spaceViewId = asString(pointer.id);
      const pointerTable = asString(pointer.table);
      if (!spaceId || !spaceViewId || (pointerTable && pointerTable !== "space_view")) continue;
      const space = unwrapRecord(spaces[spaceId]);
      if (Object.keys(space).length === 0) continue;
      const key = `${spaceId}:${spaceViewId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        spaceId,
        spaceViewId,
        spaceName: asString(space.name) || "(nameless)",
        plan: asString(space.plan_type) || "unknown",
        createdTime: asNumber(space.created_time)
      });
    }
    return results;
  }

  private buildSpaceViewTransaction(spaceId: string, spaceViewId: string, now: number): Record<string, unknown> {
    const spaceViewPointer = { table: "space_view", id: spaceViewId, spaceId };
    const spaceView: Record<string, unknown> = {
      id: spaceViewId,
      version: 1,
      space_id: spaceId,
      parent_id: this.account.userId,
      parent_table: "user_root",
      alive: true,
      notify_mobile: true,
      notify_desktop: true,
      notify_email: true,
      joined: true,
      settings: {
        notify_email_digest: true,
        notify_home_digest_email: true
      },
      first_joined_space_time: now
    };
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId,
        debug: { userAction: "spaceActions.createSpace" },
        operations: [
          {
            pointer: spaceViewPointer,
            path: [],
            command: "set",
            args: spaceView
          },
          {
            pointer: { table: "user_root", id: this.account.userId },
            path: ["space_views"],
            command: "listAfter",
            args: { id: spaceViewId }
          },
          {
            pointer: { table: "user_root", id: this.account.userId },
            path: ["space_view_pointers"],
            command: "keyedObjectListAfter",
            args: { value: spaceViewPointer }
          }
        ]
      }]
    };
  }

  private inspectWorkspaceDiscovery(payload: Record<string, unknown>, spaceId: string, spaceViewId: string): {
    workspace: WorkspaceInfo | undefined;
    viewCount: number;
    pointerCount: number;
    spacePresent: boolean;
  } {
    const recordMap = object(payload.recordMap);
    const userRoots = object(recordMap.user_root);
    const root = unwrapRecord(userRoots[this.account.userId]);
    const views = Array.isArray(root.space_views) ? root.space_views : [];
    const pointers = Array.isArray(root.space_view_pointers) ? root.space_view_pointers : [];
    const viewCount = views.filter((value) => asString(value) === spaceViewId).length;
    const pointerCount = pointers.filter((rawPointer) => {
      const pointer = object(rawPointer);
      return asString(pointer.table) === "space_view"
        && asString(pointer.id) === spaceViewId
        && asString(pointer.spaceId) === spaceId;
    }).length;
    const space = unwrapRecord(object(recordMap.space)[spaceId]);
    const recordId = asString(space.id);
    const spacePresent = Object.keys(space).length > 0 && (!recordId || recordId === spaceId);
    const workspace = this.parseWorkspaces(payload)
      .find((candidate) => candidate.spaceId === spaceId && candidate.spaceViewId === spaceViewId);
    return { workspace, viewCount, pointerCount, spacePresent };
  }

  private async hydrateWorkspaceSpaces(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordMap = object(payload.recordMap);
    const roots = object(recordMap.user_root);
    const root = unwrapRecord(roots[this.account.userId]);
    const pointers = Array.isArray(root.space_view_pointers) ? root.space_view_pointers : [];
    const spaces = { ...object(recordMap.space) };
    const missing = [...new Set(pointers.map((rawPointer) => asString(object(rawPointer).spaceId))
      .filter((spaceId) => spaceId && spaces[spaceId] === undefined))];
    for (let index = 0; index < missing.length; index += 100) {
      const ids = missing.slice(index, index + 100);
      const loaded = await this.postJson("syncRecordValuesMain", {
        requests: ids.map((spaceId) => ({ pointer: { table: "space", id: spaceId, spaceId }, version: -1 }))
      });
      Object.assign(spaces, object(object(loaded.recordMap).space));
    }
    return { ...payload, recordMap: { ...recordMap, space: spaces } };
  }

  private async hasValidSpaceViewRecord(spaceId: string, spaceViewId: string): Promise<boolean> {
    const payload = await this.postJson("syncRecordValuesMain", {
      requests: [{ pointer: { table: "space_view", id: spaceViewId, spaceId }, version: -1 }],
      spacePointer: { table: "space", id: spaceId, spaceId }
    }, spaceId);
    const recordMap = object(payload.recordMap);
    const record = unwrapRecord(object(recordMap.space_view)[spaceViewId]);
    const fullRecord = asString(record.id) === spaceViewId
      && asString(record.space_id) === spaceId
      && asString(record.parent_id) === this.account.userId
      && asString(record.parent_table) === "user_root"
      && record.alive === true
      && record.joined === true;
    // Current multi-space accounts may receive a permission projection instead of the full space_view row.
    const projectedRole = asString(record.role);
    return fullRecord || projectedRole === "editor" || projectedRole === "owner";
  }

  private async canActivateWorkspace(spaceId: string): Promise<boolean> {
    try {
      await this.postJson("getInferenceTranscriptsForUser", {
        threadParentPointer: { table: "space", id: spaceId, spaceId },
        includeWorkflowThreads: true,
        includeWriterChats: false
      }, spaceId);
      return true;
    } catch { return false; }
  }

  async createWorkspace(name?: string): Promise<WorkspaceInfo> {
    if (!this.account.userId) throw new Error("Workspace creation requires a resolved Notion user");
    const now = Date.now();
    const spaceName = name?.trim() || `auto-${now.toString(36)}`;
    const created = await this.postJson("createSpace", {
      name: spaceName,
      icon: "🏠",
      planType: "personal",
      planSelection: "personal",
      initialPersona: "unfilled",
      deviceId: this.account.deviceId,
      deviceType: "web-desktop",
      source: "handle_root_redirect"
    });
    const spaceId = asString(created.spaceId);
    if (!spaceId) throw new Error("createSpace did not return a spaceId");
    const createdSpaceRecords = object(object(created.recordMap).space);
    const spaceViewId = createSpaceScopedId(spaceId);
    try {
      // Keep the active workspace in the HTTP routing header. The transaction itself targets the new cell.
      await this.postJson("saveTransactionsMain", this.buildSpaceViewTransaction(spaceId, spaceViewId, now));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace ${spaceId} was created, but its space_view transaction failed and was not retried: ${detail}`);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < this.discoveryAttempts; attempt += 1) {
      try {
        const rawPayload = await this.postJson("loadUserContent", {});
        const rawRecordMap = object(rawPayload.recordMap);
        const payloadWithCreatedSpace = {
          ...rawPayload,
          recordMap: {
            ...rawRecordMap,
            space: { ...object(rawRecordMap.space), ...createdSpaceRecords }
          }
        };
        const payload = await this.hydrateWorkspaceSpaces(payloadWithCreatedSpace);
        const state = this.inspectWorkspaceDiscovery(payload, spaceId, spaceViewId);
        if (state.viewCount === 1 && state.pointerCount === 1 && state.spacePresent && state.workspace) {
          if (!await this.hasValidSpaceViewRecord(spaceId, spaceViewId)) {
            lastError = new Error("the root pointer was visible but the space_view record was missing or invalid");
          } else if (!await this.canActivateWorkspace(spaceId)) {
            lastError = new Error("the workspace records were visible but the workspace could not be activated");
          } else {
            const match = state.workspace;
            return {
              ...match,
              spaceName: match.spaceName === "(nameless)" ? spaceName : match.spaceName,
              plan: match.plan === "unknown" ? "personal" : match.plan,
              createdTime: match.createdTime ?? now
            };
          }
        } else {
          lastError = new Error(`root state was incomplete (space_views=${state.viewCount}, space_view_pointers=${state.pointerCount}, space=${state.spacePresent})`);
        }
      } catch (error) { lastError = error; }
      if (attempt + 1 < this.discoveryAttempts && this.discoveryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.discoveryDelayMs));
      }
    }
    const suffix = lastError instanceof Error ? ` Last verification error: ${lastError.message}` : "";
    throw new Error(`Workspace ${spaceId} was created, but its space_view ${spaceViewId} was not fully discoverable.${suffix}`);
  }

  async discoverWorkspaces(): Promise<WorkspaceInfo[]> {
    const payload = await this.postJson("loadUserContent", {});
    return this.parseWorkspaces(await this.hydrateWorkspaceSpaces(payload));
  }

  async rotate(): Promise<boolean> {
    const workspaces = await this.discoverWorkspaces();
    const fresh = workspaces.filter((workspace) =>
      workspace.spaceId !== this.account.spaceId && !this.exhausted.has(workspace.spaceId)
    );
    for (const workspace of fresh) {
      if (await this.switchTo(workspace)) return true;
    }
    const created = await this.createWorkspace();
    return this.switchTo(created);
  }

  private async switchTo(workspace: WorkspaceInfo): Promise<boolean> {
    const response = await this.fetchFn(`${this.configBase}/getInferenceTranscriptsForUser`, {
      method: "POST",
      headers: this.requestHeaders(workspace.spaceId),
      body: JSON.stringify({
        threadParentPointer: { table: "space", id: workspace.spaceId, spaceId: workspace.spaceId },
        includeWorkflowThreads: true,
        includeWriterChats: false
      })
    });
    if (!response.ok) return false;
    this.account.spaceId = workspace.spaceId;
    this.account.spaceViewId = workspace.spaceViewId;
    this.account.spaceName = workspace.spaceName;
    this.persistAccount();
    return true;
  }

  getCurrent(): WorkspaceInfo { return { spaceId: this.account.spaceId, spaceViewId: this.account.spaceViewId, spaceName: this.account.spaceName, plan: "unknown", createdTime: null }; }

  pinnedWorkspace(): string | null { return this.pinnedSpaceId; }

  pin(spaceId: string | null): void {
    this.pinnedSpaceId = spaceId && spaceId.trim() ? spaceId.trim() : null;
    if (this.pinnedSpaceId) this.account.pinnedSpaceId = this.pinnedSpaceId;
    else delete this.account.pinnedSpaceId;
    this.persistAccount();
  }

  async listWorkspaces(): Promise<Array<WorkspaceInfo & { current: boolean; exhausted: boolean; pinned: boolean }>> {
    const all = await this.discoverWorkspaces();
    return all.map((workspace) => ({ ...workspace, current: workspace.spaceId === this.account.spaceId, exhausted: this.exhausted.has(workspace.spaceId), pinned: workspace.spaceId === this.pinnedSpaceId }));
  }

  async switchWorkspace(selector: string): Promise<WorkspaceInfo> {
    const needle = selector.trim().toLowerCase();
    if (!needle) throw new Error("switch_workspace requires a workspace id or name");
    const bare = needle.replaceAll("-", "");
    const all = await this.discoverWorkspaces();
    const match = all.find((workspace) => workspace.spaceId.toLowerCase() === needle)
      ?? all.find((workspace) => workspace.spaceId.replaceAll("-", "").toLowerCase() === bare)
      ?? all.find((workspace) => workspace.spaceName.toLowerCase() === needle)
      ?? all.find((workspace) => workspace.spaceName.toLowerCase().includes(needle));
    if (!match) throw new Error(`Workspace ${selector} was not found for this account`);
    if (!(await this.switchTo(match))) throw new Error(`Workspace ${match.spaceName} could not be activated`);
    this.exhausted.delete(match.spaceId);
    return match;
  }

  async createAndSwitchWorkspace(name?: string, options: { pin?: boolean } = {}): Promise<WorkspaceInfo> {
    const created = await this.createWorkspace(name);
    if (!(await this.switchTo(created))) throw new Error("The new workspace could not be activated");
    this.exhausted.delete(created.spaceId);
    if (options.pin) this.pin(created.spaceId);
    return created;
  }

  async restorePinnedWorkspace(): Promise<boolean> {
    if (!this.pinnedSpaceId || this.pinnedSpaceId === this.account.spaceId) return false;
    const target = (await this.discoverWorkspaces()).find((workspace) => workspace.spaceId === this.pinnedSpaceId);
    return target ? this.switchTo(target) : false;
  }

  async handleLimitReached(): Promise<AccountContext> { if (!await this.rotate()) throw new Error("All workspaces are rate-limited"); return this.account; }
  markCurrentExhausted(): void { this.exhausted.add(this.account.spaceId); }
}
