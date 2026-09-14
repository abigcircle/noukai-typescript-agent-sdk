/**
 * @noukai/agent — Generic Agent Protocol Types
 *
 * Defines the contract for the yield/resume tool-calling loop between
 * any caller (frontend, backend runner, mobile app) and the agent platform.
 *
 * These types are domain-agnostic. Application-specific concerns (like
 * pipeline operations) are passed via the generic metadata parameter.
 */

// ─── Tool Schema ──────────────────────────────────────────────

/** JSON Schema for a single tool parameter. Recursive so array `items` and
 *  nested object `properties` can be described. */
export interface ToolPropertySchema {
  type: string;
  description?: string;
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  enum?: readonly unknown[];
}

/** JSON Schema definition for a tool's parameters */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

/** A tool definition sent to the LLM */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ─── Tool Calls & Results ─────────────────────────────────────

/** A tool call request from the LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A resolved tool result to send back to the LLM */
export interface ToolResult {
  toolCallId: string;
  result: string;
}

// ─── Agent Response ───────────────────────────────────────────

/**
 * Response from the agent endpoint — either tool calls to resolve
 * or a final message.
 *
 * The `metadata` field is generic — each agent type passes its own
 * domain payload. For example, the pipeline agent passes operations.
 */
export type AgentResponse<M = Record<string, unknown>> =
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "message"; content: string; metadata?: M };

// ─── Conversation Turns ───────────────────────────────────────

/** A turn in the conversation sent to/from the LLM */
export type AgentTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; content: null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

// ─── Display Message ──────────────────────────────────────────

/** Minimal message for display. Consumer can map to their own UI type. */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "thinking";
  content: string;
  timestamp: number;
}

// ─── Hook Types ───────────────────────────────────────────────

/**
 * Function that resolves a tool call locally. Can be sync or async.
 *
 * `ctx.sessionId` is present when the call belongs to a background (detached)
 * turn — so a SINGLE resolver multiplexed across many sessions can route to the
 * right session's state instead of "whatever tab is currently focused". It is
 * absent on the default (non-background) path. Backward compatible: a resolver
 * that ignores the second argument keeps working unchanged.
 */
export type ToolResolver = (
  call: ToolCall,
  ctx?: { sessionId?: string },
) => ToolResult | Promise<ToolResult>;

/** Configuration for the useAgentChat hook */
export interface AgentChatOptions<M = Record<string, unknown>> {
  /** API endpoint to POST conversation turns to */
  endpoint: string;
  /** Tool definitions to send with each request */
  tools: ToolDefinition[];
  /** Function to resolve tool calls locally */
  resolveToolCall: ToolResolver;
  /** Max tool-calling loop iterations (default: 10) */
  maxIterations?: number;
  /** Formatter for tool-call progress labels. Pass a custom ToolLabelFormatter
   *  to control the verbs shown during tool resolution (e.g. whimsical labels).
   *  Defaults to a standard ToolLabelFormatter instance. */
  toolLabelFormatter?: import("./tool-label-formatter.js").ToolLabelFormatter;
  /** Extracts display context from a tool call (e.g. block name from blockId).
   *  The returned string is inserted into the progress label. */
  toolCallContext?: (call: ToolCall) => string | undefined;
  /**
   * Called when the agent returns a final message with metadata.
   *
   * `ctx.sessionId` identifies the originating session and is passed only for
   * background (detached) turns — so a consumer multiplexing many sessions can
   * route a backgrounded turn's metadata (e.g. pipeline operations) to the right
   * tab's overlay even while another tab is active. Absent on the default path.
   */
  onMetadata?: (metadata: M | undefined, ctx?: { sessionId: string }) => void;
  /**
   * Called when tool calls are about to be resolved — use for progress UI.
   * `ctx.sessionId` is passed only for background (detached) turns (see
   * {@link onMetadata}); absent on the default path.
   */
  onToolCallStart?: (toolCalls: ToolCall[], ctx?: { sessionId: string }) => void;
  /**
   * Called when a background (detached) turn fails. Fires even while a different
   * session is active, so a consumer can surface an error badge on a backgrounded
   * tab. Only invoked when `backgroundTurns` is enabled; the default path surfaces
   * errors inline as an assistant error bubble (unchanged).
   */
  onTurnError?: (error: Error, ctx: { sessionId: string }) => void;
  /**
   * Chat-flow mode. When true, each send passes the growing conversation as
   * structured top-level `messages` (role:user/role:assistant turns) instead of
   * the default `parameters.conversation` (flattened) path. Default false keeps
   * the existing behavior byte-identical.
   */
  sendStructuredMessages?: boolean;
  /**
   * Session identity for optional persistence. When set together with `store`,
   * the hook loads this session's `{ conversation, displayMessages }` on mount
   * and whenever `sessionId` changes (switching sessions/tabs restores that
   * conversation), saves after each completed exchange, and deletes on
   * `clearChat`. Changing `sessionId` aborts any in-flight turn. Omit for the
   * default in-memory-only behavior.
   */
  sessionId?: string;
  /**
   * Pluggable persistence backend. See {@link import("./session-store.js").ChatSessionStore}.
   * MUST be referentially stable across renders (memoize it) — a new object each
   * render re-triggers the load effect. Pair with `sessionId`. Only
   * `conversation` + `displayMessages` are persisted here; app-specific overlay
   * state (pending ops, etc.) is the consumer's own concern — see the
   * "domain overlay" recipe in session-store.ts.
   */
  store?: import("./session-store.js").ChatSessionStore;
  /**
   * Opt in to **background (detached) turns**. Requires both `sessionId` and
   * `store`.
   *
   * When enabled, a turn started for a session keeps running to completion even
   * after `sessionId` changes — switching sessions no longer aborts the turn, and
   * its result is present (from the store and/or a still-live stream) when you
   * return. Aborting becomes explicit: `stop(sessionId?)`. Turns survive a hook
   * unmount/remount (they live in a module-level manager); a page reload keeps
   * only what the store persisted, exactly as before.
   *
   * Default `false` preserves today's behavior byte-for-byte (a `sessionId`
   * change aborts the in-flight turn). Enabling it without a `store` is a no-op
   * (a dev-mode warning is logged) since a detached turn needs somewhere to
   * persist and a stable identity to run under.
   */
  backgroundTurns?: boolean;
}

/** Return value from the useAgentChat hook */
export interface AgentChatReturn {
  /** Messages for display */
  messages: AgentMessage[];
  /** Whether the agent is processing */
  isLoading: boolean;
  /** Send a user message */
  sendMessage: (content: string) => void;
  /**
   * Abort an in-flight turn so a new send is allowed. With no argument, aborts
   * the ACTIVE session's turn (e.g. user pressed Escape). With `backgroundTurns`
   * enabled, pass a `sessionId` to abort a specific backgrounded session's turn
   * even while another session is active.
   */
  stop: (sessionId?: string) => void;
  /** Clear conversation */
  clearChat: () => void;
  /** Full conversation history (for advanced use) */
  conversation: readonly AgentTurn[];
  /**
   * sessionIds (for this hook's `store`) that currently have an in-flight
   * background turn — including the active session if it has one. Empty unless
   * `backgroundTurns` is enabled. Use it to show a spinner on backgrounded tabs.
   */
  backgroundSessions: readonly string[];
}
