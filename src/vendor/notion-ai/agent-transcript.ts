type JsonObject = Record<string, unknown>;

export interface AgentTranscriptState {
  entities: Map<string, JsonObject>;
  pendingPatches: Map<string, JsonObject[][]>;
  session?: JsonObject | undefined;
  latestCommittedSequence: number;
  abandonedSequenceRanges: Array<{ afterSequence: number; beforeSequence: number }>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clone(value: JsonObject): JsonObject {
  return structuredClone(value);
}

export function createAgentTranscriptState(): AgentTranscriptState {
  return {
    entities: new Map(),
    pendingPatches: new Map(),
    latestCommittedSequence: 0,
    abandonedSequenceRanges: []
  };
}

function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`Invalid transcript patch path ${path}`);
  return path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function patchValue(operation: JsonObject): unknown {
  return operation.value !== undefined ? operation.value : operation.v;
}

function validateOperation(entity: JsonObject, operation: JsonObject): void {
  const op = string(operation.op || operation.o);
  const path = string(operation.path || operation.p);
  if (!["append", "add", "replace", "remove"].includes(op)) throw new Error(`Unsupported transcript patch operation ${op}`);
  if (op === "append") {
    const valid = entity.source === "provisional" &&
      ((entity.kind === "assistant_message" && path === "/content/0/text") ||
       (entity.kind === "thinking" && path === "/content_text"));
    if (!valid) throw new Error(`Invalid transcript append path ${path}`);
  }
}

function applyOperation(target: JsonObject, operation: JsonObject): JsonObject {
  validateOperation(target, operation);
  const op = string(operation.op || operation.o);
  const path = string(operation.path || operation.p);
  const parts = decodePointer(path);
  if (parts.length === 0) {
    const value = patchValue(operation);
    if ((op === "replace" || op === "add") && value && typeof value === "object" && !Array.isArray(value)) return clone(value as JsonObject);
    throw new Error(`Unsupported root transcript patch ${op}`);
  }

  let current: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) throw new Error(`Invalid transcript patch index ${part}`);
      current = current[index];
    } else if (current && typeof current === "object") {
      current = (current as JsonObject)[part];
    } else {
      throw new Error(`Invalid transcript patch path ${path}`);
    }
  }

  const key = parts.at(-1) as string;
  const value = patchValue(operation);
  if (Array.isArray(current)) {
    const index = key === "-" ? current.length : Number(key);
    const maxIndex = op === "add" ? current.length : current.length - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index > maxIndex) throw new Error(`Invalid transcript patch index ${key}`);
    if (op === "add") current.splice(index, 0, value);
    else if (op === "replace") current[index] = value;
    else if (op === "append") current[index] = `${string(current[index])}${string(value)}`;
    else if (op === "remove") current.splice(index, 1);
    else throw new Error(`Unsupported transcript patch operation ${op}`);
    return target;
  }
  if (!current || typeof current !== "object") throw new Error(`Invalid transcript patch path ${path}`);
  const record = current as JsonObject;
  if (op === "append") record[key] = `${string(record[key])}${string(value)}`;
  else if (op === "add" || op === "replace") record[key] = value;
  else if (op === "remove") delete record[key];
  else throw new Error(`Unsupported transcript patch operation ${op}`);
  return target;
}

function applyOperations(entity: JsonObject, rawOperations: unknown): JsonObject {
  let next = clone(entity);
  for (const raw of Array.isArray(rawOperations) ? rawOperations : []) next = applyOperation(next, object(raw));
  return next;
}

function abandoned(state: AgentTranscriptState, sequence: number): boolean {
  return state.abandonedSequenceRanges.some((range) => sequence > range.afterSequence && sequence < range.beforeSequence);
}

function mergeRanges(ranges: AgentTranscriptState["abandonedSequenceRanges"]): AgentTranscriptState["abandonedSequenceRanges"] {
  const merged: AgentTranscriptState["abandonedSequenceRanges"] = [];
  for (const range of [...ranges].sort((a, b) => a.afterSequence - b.afterSequence)) {
    const previous = merged.at(-1);
    if (!previous || range.afterSequence > previous.beforeSequence) merged.push({ ...range });
    else previous.beforeSequence = Math.max(previous.beforeSequence, range.beforeSequence);
  }
  return merged;
}

export function applyAgentTranscriptPatches(state: AgentTranscriptState, rawPatches: unknown): void {
  for (const rawPatch of Array.isArray(rawPatches) ? rawPatches : []) {
    const patch = object(rawPatch);
    const op = string(patch.op);
    if (op === "put") {
      let entity = clone(object(patch.entity));
      const id = string(entity.id);
      if (!id) continue;
      if (abandoned(state, number(entity.sequence))) {
        state.entities.delete(id);
        state.pendingPatches.delete(id);
        continue;
      }
      for (const operations of state.pendingPatches.get(id) ?? []) entity = applyOperations(entity, operations);
      state.pendingPatches.delete(id);
      state.entities.set(id, entity);
    } else if (op === "patch") {
      const id = string(patch.id);
      if (!id) continue;
      const operations = Array.isArray(patch.ops) ? patch.ops.map(object) : [];
      const entity = state.entities.get(id);
      if (entity) state.entities.set(id, applyOperations(entity, operations));
      else {
        if (operations.some((operation) => string(operation.op || operation.o) === "append")) {
          throw new Error("Cannot stash a provisional append patch");
        }
        if (!state.pendingPatches.has(id) && state.pendingPatches.size >= 10_000) {
          throw new Error("Agent transcript pending-patch target limit exceeded");
        }
        const pending = state.pendingPatches.get(id) ?? [];
        if (pending.length >= 20) throw new Error("Agent transcript pending-patch per-target limit exceeded");
        pending.push(operations);
        state.pendingPatches.set(id, pending);
      }
    } else if (op === "remove") {
      const id = string(patch.id);
      state.entities.delete(id);
      state.pendingPatches.delete(id);
    } else if (op === "rewind") {
      const afterSequence = patch.rewind_to_sequence;
      const beforeSequence = patch.event_sequence;
      if (!Number.isSafeInteger(afterSequence) || !Number.isSafeInteger(beforeSequence) || (afterSequence as number) < 0 || (afterSequence as number) >= (beforeSequence as number)) {
        throw new Error("Invalid Agent Service transcript rewind bounds");
      }
      state.abandonedSequenceRanges = mergeRanges([...state.abandonedSequenceRanges, {
        afterSequence: afterSequence as number,
        beforeSequence: beforeSequence as number
      }]);
      for (const [id, entity] of state.entities) {
        if (abandoned(state, number(entity.sequence))) {
          state.entities.delete(id);
          state.pendingPatches.delete(id);
        }
      }
    } else if (op === "session") {
      const session = object(patch.session);
      if (!state.session || number(session.sequence) >= number(state.session.sequence)) state.session = clone(session);
    } else if (op === "session_status") {
      const session = object(patch.session);
      if (!state.session || number(session.sequence) > number(state.session.sequence)) state.session = { ...clone(session), pending_input: null };
      else if (number(session.sequence) === number(state.session.sequence)) state.session = { ...state.session, ...clone(session) };
    } else if (op === "committed") {
      state.latestCommittedSequence = Math.max(state.latestCommittedSequence, number(patch.sequence));
    }
  }
}

function entityText(entity: JsonObject): string {
  const content = Array.isArray(entity.content) ? entity.content : [];
  return content.map((raw) => {
    const item = object(raw);
    return item.type === "text" ? string(item.text || item.content) : "";
  }).filter(Boolean).join("\n\n").trim();
}

function orderedEntities(state: AgentTranscriptState): JsonObject[] {
  return [...state.entities.values()].sort((left, right) => {
    const sequence = number(left.sequence) - number(right.sequence);
    return sequence || string(left.id).localeCompare(string(right.id));
  });
}

export function latestAgentTranscriptText(state: AgentTranscriptState): string {
  const assistantMessages = orderedEntities(state).filter((entity) => entity.kind === "assistant_message");
  return entityText(assistantMessages.at(-1) ?? {});
}

export function agentTranscriptError(state: AgentTranscriptState): string | undefined {
  const errors = orderedEntities(state).filter((entity) => entity.kind === "error");
  const latest = errors.at(-1);
  return latest ? string(latest.message) || string(latest.error_type) || "Unknown Agent Service error" : undefined;
}

export function isAgentTranscriptTurnComplete(state: AgentTranscriptState): boolean {
  const entities = orderedEntities(state);
  const assistantSequence = number(entities.filter((entity) => entity.kind === "assistant_message").at(-1)?.sequence);
  const completionSequence = number(entities.filter((entity) => entity.kind === "turn_completed").at(-1)?.sequence);
  return completionSequence > 0 && completionSequence >= assistantSequence;
}
