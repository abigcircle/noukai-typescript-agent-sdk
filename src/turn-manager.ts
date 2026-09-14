/**
 * turn-manager — module-level ownership of background (detached) turns.
 *
 * A turn started for a session must be able to outlive being the *active*
 * session in a multiplexing consumer (e.g. Nana's many chat tabs through one
 * `useAgentChat`). Today a turn is welded to the hook instance's single
 * `AbortController`, and "sessionId changed ⇒ abort" is hard-wired. This module
 * lifts a turn's EXECUTION out of the React view: a turn runs here — owning its
 * own `AbortController`, appending to a live record, and flushing the finished
 * conversation to the store — regardless of which session the hook is showing.
 *
 * Design: `docs/design-logs/2026/09Sep/20260914-SDK-agent-background-turns.md`.
 *
 * Why here, not in `useAgentChat`:
 *   - The manager is module-scoped, so turns survive a hook unmount/remount
 *     (only a page reload — which kills the module — falls back to store-only,
 *     the unchanged contract).
 *   - It is 100% React-free (React is an optional peer). The only observable
 *     outputs of a turn are the `onToolCallStart` "thinking" events and one
 *     terminal result/error — there is NO token stream — so re-attaching a view
 *     is a pure re-read of a single authoritative record, never a delta replay.
 *
 * Browser/SSR-safe: module init allocates empty `Map`/`WeakMap`/`Set` only — no
 * Node built-ins, no `AsyncLocalStorage`, no `window`/`localStorage`/`process`
 * access, no import side effects. All work happens inside a user-triggered
 * `startTurn` on the client.
 */

import { runAgentLoop } from "./agent-loop.js";
import type { AgentLoopOptions, AgentLoopResult } from "./agent-loop.js";
import type { ChatSessionStore } from "./session-store.js";
import type { ToolLabelFormatter } from "./tool-label-formatter.js";
import type {
  AgentMessage,
  AgentTurn,
  ToolCall,
  ToolDefinition,
  ToolResolver,
} from "./types.js";

// ─── Public value types ──────────────────────────────────────

export type LiveTurnStatus = "running" | "done" | "error";

/**
 * An immutable snapshot of a live turn, delivered to subscribers. Never exposes
 * the internal `AbortController`. Arrays are replaced (not mutated) on every
 * change, so holding a reference is safe.
 */
export interface LiveTurn {
  sessionId: string;
  status: LiveTurnStatus;
  /** Full display incl. user + thinking… + final/error bubbles. */
  displayMessages: AgentMessage[];
  /** LLM-facing turns — the send-time snapshot; user+assistant appended on success. */
  conversation: AgentTurn[];
  metadata?: unknown;
  error?: Error;
  createdAt: string;
}

/** The loop runner. Defaults to {@link runAgentLoop}; overridable for tests. */
export type LoopRunner = (
  message: string,
  options: AgentLoopOptions,
) => Promise<AgentLoopResult>;

/**
 * Everything a turn needs to run, captured AT SEND from the hook's current
 * options + state. Held for the life of the turn so a later tab switch cannot
 * change which endpoint/tools/resolver/callbacks a backgrounded turn uses.
 */
export interface ExecutionSnapshot {
  endpoint: string;
  tools: ToolDefinition[];
  resolveToolCall: ToolResolver;
  maxIterations?: number;
  formatter: ToolLabelFormatter;
  toolCallContext?: (call: ToolCall) => string | undefined;
  sendStructuredMessages: boolean;
  /** Conversation history at send (excludes the new user turn). */
  conversation: AgentTurn[];
  /** Display messages at send — the baseline the new turn appends to. */
  displayMessages: AgentMessage[];
  /** Preserved session `createdAt`, or null for a fresh session. */
  createdAt: string | null;
  onToolCallStart?: (toolCalls: ToolCall[], ctx: { sessionId: string }) => void;
  onMetadata?: (metadata: unknown, ctx: { sessionId: string }) => void;
  onTurnError?: (error: Error, ctx: { sessionId: string }) => void;
  /** Test seam. Defaults to {@link runAgentLoop}. */
  loopRunner?: LoopRunner;
}

type TurnSubscriber = (turn: LiveTurn | undefined) => void;
type LiveSetSubscriber = (sessionIds: string[]) => void;

/** The "reached maximum steps" bubble — matches `useAgentChat`'s inline text. */
const MAX_STEPS_MESSAGE =
  "I gathered some information but reached the maximum number of steps. Could you rephrase your question?";

// ─── Internal turn state ─────────────────────────────────────

interface TurnState {
  sessionId: string;
  storeKey: string;
  status: LiveTurnStatus;
  displayMessages: AgentMessage[];
  conversation: AgentTurn[];
  metadata?: unknown;
  error?: Error;
  createdAt: string;
  controller: AbortController;
  /** Per-turn id counter, seeded from the send-time display so ids never collide. */
  idCounter: number;
}

// ─── Module state ────────────────────────────────────────────
// Keyed by a STABLE store identity (stores are required to be referentially
// stable — see AgentChatOptions.store) so two unrelated hooks that reuse a
// sessionId string against different stores stay isolated.

let storeKeySeq = 0;
const storeKeys = new WeakMap<ChatSessionStore, string>();

/** Active turns:  storeKey → (sessionId → TurnState). Terminal turns are removed. */
const turnsByStore = new Map<string, Map<string, TurnState>>();

/**
 * Persistent per-session subscribers, INDEPENDENT of whether a turn exists.
 * A view subscribes to a session before any turn is started, so subscribers
 * cannot live on the transient TurnState. storeKey → (sessionId → set).
 */
const turnSubs = new Map<string, Map<string, Set<TurnSubscriber>>>();

/** Per-store live-set subscribers: storeKey → set. */
const liveSetSubs = new Map<string, Set<LiveSetSubscriber>>();

// ─── Helpers ─────────────────────────────────────────────────

/** Largest numeric suffix of an `msg-N` id, or 0. Keeps a turn's id counter
 *  ahead of restored ids so an appended bubble can't collide. */
export function maxMsgIdSuffix(messages: AgentMessage[]): number {
  let max = 0;
  for (const m of messages) {
    const n = Number.parseInt(m.id.replace(/^msg-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function storeKeyFor(store: ChatSessionStore): string {
  let key = storeKeys.get(store);
  if (key === undefined) {
    key = `store-${++storeKeySeq}`;
    storeKeys.set(store, key);
  }
  return key;
}

function getState(storeKey: string, sessionId: string): TurnState | undefined {
  return turnsByStore.get(storeKey)?.get(sessionId);
}

function mintId(state: TurnState): string {
  state.idCounter += 1;
  return `msg-${state.idCounter}`;
}

function snapshotOf(state: TurnState): LiveTurn {
  return {
    sessionId: state.sessionId,
    status: state.status,
    displayMessages: state.displayMessages,
    conversation: state.conversation,
    metadata: state.metadata,
    error: state.error,
    createdAt: state.createdAt,
  };
}

/** Notify this session's subscribers with the current snapshot (or undefined). */
function notifyTurn(storeKey: string, sessionId: string): void {
  const subs = turnSubs.get(storeKey)?.get(sessionId);
  if (!subs || subs.size === 0) return;
  const state = getState(storeKey, sessionId);
  const snap = state ? snapshotOf(state) : undefined;
  for (const cb of [...subs]) {
    try {
      cb(snap);
    } catch {
      // A subscriber throwing must never break the turn.
    }
  }
}

function liveSessionIdsFor(storeKey: string): string[] {
  return [...(turnsByStore.get(storeKey)?.keys() ?? [])];
}

function notifyLiveSet(storeKey: string): void {
  const subs = liveSetSubs.get(storeKey);
  if (!subs || subs.size === 0) return;
  const ids = liveSessionIdsFor(storeKey);
  for (const cb of [...subs]) {
    try {
      cb([...ids]);
    } catch {
      // isolate subscriber errors
    }
  }
}

function removeState(state: TurnState): void {
  const byId = turnsByStore.get(state.storeKey);
  byId?.delete(state.sessionId);
  if (byId?.size === 0) turnsByStore.delete(state.storeKey);
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Start a background turn for `(store, sessionId)`. Per-session single-flight:
 * a no-op if a turn is already running for this session. Returns immediately;
 * the turn runs to completion in the background and drives subscribers.
 */
export function startTurn(
  store: ChatSessionStore,
  sessionId: string,
  snapshot: ExecutionSnapshot,
  userText: string,
): void {
  const storeKey = storeKeyFor(store);
  let byId = turnsByStore.get(storeKey);
  if (!byId) {
    byId = new Map();
    turnsByStore.set(storeKey, byId);
  }
  if (byId.has(sessionId)) return; // single-flight

  const state: TurnState = {
    sessionId,
    storeKey,
    status: "running",
    displayMessages: [...snapshot.displayMessages],
    conversation: [...snapshot.conversation],
    createdAt: snapshot.createdAt ?? new Date().toISOString(),
    controller: new AbortController(),
    idCounter: maxMsgIdSuffix(snapshot.displayMessages),
  };
  byId.set(sessionId, state);

  // Append the user's message immediately so a subscriber sees it right away.
  const userMsg: AgentMessage = {
    id: mintId(state),
    role: "user",
    content: userText,
    timestamp: Date.now(),
  };
  state.displayMessages = [...state.displayMessages, userMsg];

  notifyTurn(storeKey, sessionId);
  notifyLiveSet(storeKey);

  void runTurn(store, state, snapshot, userText);
}

async function runTurn(
  store: ChatSessionStore,
  state: TurnState,
  snapshot: ExecutionSnapshot,
  userText: string,
): Promise<void> {
  const ctx = { sessionId: state.sessionId };
  const loopRunner: LoopRunner = snapshot.loopRunner ?? runAgentLoop;

  // Chat-flow mode sends structured turns (prior conversation + this user turn);
  // the default path sends flattened `parameters.conversation`. Mirrors
  // useAgentChat's sendMessage.
  const modeArgs = snapshot.sendStructuredMessages
    ? {
        messages: [
          ...snapshot.conversation,
          { role: "user" as const, content: userText },
        ],
      }
    : { parameters: { conversation: snapshot.conversation } };

  try {
    const result = await loopRunner(userText, {
      endpoint: snapshot.endpoint,
      tools: snapshot.tools,
      resolveToolCall: (call) => snapshot.resolveToolCall(call, ctx),
      ...(snapshot.maxIterations !== undefined
        ? { maxIterations: snapshot.maxIterations }
        : {}),
      signal: state.controller.signal,
      ...modeArgs,
      onToolCallStart: (toolCalls) => {
        const labels = snapshot.formatter.format(
          toolCalls,
          snapshot.toolCallContext,
        );
        const now = Date.now();
        const thinking: AgentMessage[] = labels.map((label) => ({
          id: mintId(state),
          role: "thinking" as const,
          content: label,
          timestamp: now,
        }));
        state.displayMessages = [...state.displayMessages, ...thinking];
        notifyTurn(state.storeKey, state.sessionId);
        snapshot.onToolCallStart?.(toolCalls, ctx);
      },
    });

    if (result.type === "message") {
      // Extend conversation history for multi-turn context (mirrors the hook).
      state.conversation = [
        ...state.conversation,
        { role: "user", content: userText },
        { role: "assistant", content: result.content },
      ];
      const assistantMsg: AgentMessage = {
        id: mintId(state),
        role: "assistant",
        content: result.content,
        timestamp: Date.now(),
      };
      state.displayMessages = [...state.displayMessages, assistantMsg];
      state.metadata = result.metadata;
      finalize(store, state, "done");
      snapshot.onMetadata?.(result.metadata, ctx);
    } else {
      // DELIBERATE: the max-steps bubble is display-only, never fed back into
      // conversation — identical to useAgentChat's handling.
      const bubble: AgentMessage = {
        id: mintId(state),
        role: "assistant",
        content: MAX_STEPS_MESSAGE,
        timestamp: Date.now(),
      };
      state.displayMessages = [...state.displayMessages, bubble];
      finalize(store, state, "done");
      snapshot.onMetadata?.(undefined, ctx);
    }
  } catch (error) {
    // Discriminate an EXPLICIT abort (stop()) from an AbortError-shaped FAILURE.
    // The SDK relay enforces a per-request timeout by aborting its own internal
    // controller, which rejects with a `DOMException`/`AbortError` indistinguishable
    // from a user abort. Keying on the error shape would silently drop a timed-out
    // background turn (no error surfaced, no onTurnError) — violating the "errors
    // surface on return" contract. `state.controller` is aborted ONLY by
    // abortTurn/abortAllTurns, so its signal is the reliable "was this an explicit
    // stop?" signal; a timeout/other failure falls through to the error path.
    if (state.controller.signal.aborted) {
      // Explicit abort: finalize silently — no bubble, no conversation extension,
      // no store write.
      finalizeAbort(state);
      return;
    }
    // DELIBERATE: the error bubble is display-only, never fed back into
    // conversation — identical to useAgentChat's catch.
    const err = error instanceof Error ? error : new Error(String(error));
    const errorMsg: AgentMessage = {
      id: mintId(state),
      role: "assistant",
      content: `Error: ${error instanceof Error ? error.message : "Something went wrong."}`,
      timestamp: Date.now(),
    };
    state.displayMessages = [...state.displayMessages, errorMsg];
    state.error = err;
    finalize(store, state, "error");
    snapshot.onTurnError?.(err, ctx);
  }
}

/** Persist the finished turn, notify subscribers with the terminal snapshot,
 *  then drop the record (terminal state reaches a non-viewing hook via the
 *  store on its next load). */
function finalize(
  store: ChatSessionStore,
  state: TurnState,
  status: LiveTurnStatus,
): void {
  state.status = status;
  // Persistence is best-effort; a failed save never breaks the live chat.
  // Thinking bubbles are transient — never persisted (mirrors the save effect).
  const displayMessages = state.displayMessages.filter(
    (m) => m.role !== "thinking",
  );
  Promise.resolve(
    store.save({
      sessionId: state.sessionId,
      conversation: [...state.conversation],
      displayMessages,
      createdAt: state.createdAt,
      updatedAt: new Date().toISOString(),
    }),
  ).catch(() => undefined);

  notifyTurn(state.storeKey, state.sessionId);
  removeState(state);
  notifyLiveSet(state.storeKey);
}

/** Finalize an aborted turn: drop the record WITHOUT persisting (an aborted turn
 *  is not a completed exchange). Removed BEFORE the notify so subscribers receive
 *  `undefined` (no live turn) rather than a snapshot — a view that cleared/reset
 *  around the abort must not be asynchronously repopulated by a late finalize. */
function finalizeAbort(state: TurnState): void {
  state.status = "done";
  removeState(state);
  notifyTurn(state.storeKey, state.sessionId);
  notifyLiveSet(state.storeKey);
}

/** Current live turn for a session, or undefined. */
export function getTurn(
  store: ChatSessionStore,
  sessionId: string,
): LiveTurn | undefined {
  const state = getState(storeKeyFor(store), sessionId);
  return state ? snapshotOf(state) : undefined;
}

/**
 * Subscribe to a session's live turn. `cb` is invoked immediately with the
 * current snapshot (or `undefined` if none) and on every change, ending with the
 * terminal snapshot. Returns an unsubscribe function.
 */
export function subscribeTurn(
  store: ChatSessionStore,
  sessionId: string,
  cb: TurnSubscriber,
): () => void {
  const storeKey = storeKeyFor(store);
  let byId = turnSubs.get(storeKey);
  if (!byId) {
    byId = new Map();
    turnSubs.set(storeKey, byId);
  }
  let set = byId.get(sessionId);
  if (!set) {
    set = new Set();
    byId.set(sessionId, set);
  }
  set.add(cb);

  // Prime with the current state.
  const state = getState(storeKey, sessionId);
  try {
    cb(state ? snapshotOf(state) : undefined);
  } catch {
    // isolate subscriber errors
  }

  return () => {
    const s = turnSubs.get(storeKey)?.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      turnSubs.get(storeKey)?.delete(sessionId);
      if (turnSubs.get(storeKey)?.size === 0) turnSubs.delete(storeKey);
    }
  };
}

/** Abort a specific session's in-flight turn, if any. Idempotent. */
export function abortTurn(store: ChatSessionStore, sessionId: string): void {
  const state = getState(storeKeyFor(store), sessionId);
  if (state?.status === "running") state.controller.abort();
}

/** Abort every in-flight turn — for a hard teardown (logout). With a `store`,
 *  limits to that store's turns; without, aborts across all stores. */
export function abortAllTurns(store?: ChatSessionStore): void {
  const keys = store ? [storeKeyFor(store)] : [...turnsByStore.keys()];
  for (const storeKey of keys) {
    for (const state of [...(turnsByStore.get(storeKey)?.values() ?? [])]) {
      if (state.status === "running") state.controller.abort();
    }
  }
}

/** sessionIds with an in-flight turn for this store. */
export function liveTurnSessionIds(store: ChatSessionStore): string[] {
  return liveSessionIdsFor(storeKeyFor(store));
}

/**
 * Subscribe to the SET of sessionIds with an in-flight background turn for a
 * store — for a tab strip rendered outside the component holding `useAgentChat`.
 * `cb` fires immediately with the current set and on every start/finish. Returns
 * an unsubscribe function.
 */
export function subscribeBackgroundSessions(
  store: ChatSessionStore,
  cb: LiveSetSubscriber,
): () => void {
  const storeKey = storeKeyFor(store);
  let set = liveSetSubs.get(storeKey);
  if (!set) {
    set = new Set();
    liveSetSubs.set(storeKey, set);
  }
  set.add(cb);
  try {
    cb(liveSessionIdsFor(storeKey));
  } catch {
    // isolate subscriber errors
  }
  return () => {
    const s = liveSetSubs.get(storeKey);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) liveSetSubs.delete(storeKey);
  };
}
