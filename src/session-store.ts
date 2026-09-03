/**
 * Chat Session Store — Optional persistence for agent conversations
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ PURPOSE                                                        │
 * │                                                                │
 * │ The agent protocol is stateless — the server holds nothing     │
 * │ between requests. Conversation state lives on the caller side. │
 * │                                                                │
 * │ By default, that state lives in memory (React ref / variable). │
 * │ A ChatSessionStore adds optional persistence so conversations  │
 * │ survive page refreshes, tab closes, or app restarts.           │
 * │                                                                │
 * │ This is a PRODUCT FEATURE (user sees conversation history),    │
 * │ not an architectural requirement. The protocol works without   │
 * │ a store.                                                       │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ WHAT GETS STORED                                               │
 * │                                                                │
 * │ A ChatSession contains two things:                             │
 * │                                                                │
 * │ 1. conversation: AgentTurn[]                                   │
 * │    The full conversation history (user, assistant, tool turns). │
 * │    This is what gets sent to the LLM on the next user message. │
 * │                                                                │
 * │ 2. displayMessages: AgentMessage[]                             │
 * │    The rendered messages shown in the UI. Includes thinking    │
 * │    indicators, formatted responses, etc. Separate from the     │
 * │    raw conversation because display concerns ≠ LLM concerns.  │
 * │                                                                │
 * │ The state token is NOT stored here. It only exists during an   │
 * │ active yield/resume cycle (seconds), and is held in memory by  │
 * │ the agent loop. If the page refreshes mid-yield, the cycle     │
 * │ restarts from the last completed exchange — which is fine.     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ STORAGE BACKENDS                                               │
 * │                                                                │
 * │ The framework provides the interface. Consumers provide the    │
 * │ backend. Examples:                                             │
 * │                                                                │
 * │   Browser:   localStorage, sessionStorage, IndexedDB           │
 * │   Mobile:    AsyncStorage, Core Data, SQLite                   │
 * │   Backend:   Database, file system                             │
 * │   Testing:   In-memory map                                     │
 * │                                                                │
 * │ The framework ships a MemorySessionStore (default, no persist) │
 * │ and consumers can plug in their own.                           │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * @example
 *   // Without store (default) — conversation lives in memory only
 *   const agent = useAgentChat({
 *     endpoint: "/api/nana/execute",
 *     tools: registry.definitions(),
 *     resolveToolCall: (call) => registry.resolve(call),
 *   });
 *
 * @example
 *   // With store — conversation persists across page refreshes
 *   const agent = useAgentChat({
 *     endpoint: "/api/nana/execute",
 *     tools: registry.definitions(),
 *     resolveToolCall: (call) => registry.resolve(call),
 *     sessionId: "pipeline-abc-chat",
 *     store: myLocalStorageStore,
 *   });
 */

import type { AgentMessage, AgentTurn } from "./types.js";

// ─── Session Data ──────────────────────────────────────────────

/**
 * A persisted chat session.
 *
 * Contains everything needed to restore a conversation after the
 * component unmounts or the page refreshes. The agent loop can
 * pick up where the user left off by loading this session and
 * passing `conversation` to the next LLM call.
 */
export interface ChatSession {
  /** Unique session identifier (e.g., "pipeline-abc-chat") */
  sessionId: string;

  /**
   * Full conversation history — the LLM-facing turns.
   *
   * This is the array that gets sent as `messages` in the first
   * POST of a new user message. It accumulates across exchanges:
   *
   *   [user, assistant-tools, tool-result, assistant-message,  ← exchange 1
   *    user, assistant-message,                                 ← exchange 2
   *    user, assistant-tools, tool-result, assistant-message]   ← exchange 3
   */
  conversation: AgentTurn[];

  /**
   * Display messages — the UI-facing messages.
   *
   * Includes thinking indicators, error messages, and formatted
   * responses. This is what gets rendered in the chat widget.
   * Kept separate from `conversation` because not all display
   * messages map to LLM turns (e.g., "thinking..." indicators).
   */
  displayMessages: AgentMessage[];

  /** When the session was created (ISO 8601) */
  createdAt: string;

  /** When the session was last updated (ISO 8601) */
  updatedAt: string;
}

// ─── Store Interface ───────────────────────────────────────────

/**
 * Pluggable storage backend for chat sessions.
 *
 * The framework calls these methods at specific lifecycle points:
 *
 *   load()   — called when useAgentChat mounts (or runAgentLoop starts)
 *              to restore a previous session.
 *
 *   save()   — called after each completed exchange (user sends message,
 *              agent responds with final message). NOT called mid-yield —
 *              partial tool-call state is not persisted.
 *
 *   delete() — called when the consumer explicitly clears the chat
 *              (e.g., user clicks "New conversation").
 *
 *   list()   — called to show conversation history UI (e.g., sidebar
 *              with past conversations). Optional — can return empty
 *              if the consumer doesn't need this feature.
 *
 * ┌────────────────────────────────────────────────────────────┐
 * │ IMPORTANT: All methods are async to support any backend.  │
 * │ For synchronous backends (localStorage), just return the  │
 * │ value directly — TypeScript allows sync returns from async │
 * │ functions.                                                │
 * └────────────────────────────────────────────────────────────┘
 */
export interface ChatSessionStore {
  /**
   * Load a previously saved session.
   *
   * Returns null if no session exists for this ID (first visit,
   * or session was deleted). The framework will start a fresh
   * conversation when this returns null.
   */
  load(sessionId: string): Promise<ChatSession | null>;

  /**
   * Persist the current session state.
   *
   * Called after each completed user↔agent exchange, NOT during
   * active yield/resume cycles. The session object contains the
   * updated conversation and display messages.
   *
   * Implementations should upsert (create or update).
   */
  save(session: ChatSession): Promise<void>;

  /**
   * Delete a session.
   *
   * Called when the user explicitly clears/resets the chat.
   * Should be a no-op if the session doesn't exist.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * List saved session summaries.
   *
   * Used for "conversation history" UI. Returns lightweight
   * metadata without the full conversation array.
   *
   * Optional feature — implementations can return an empty array
   * if conversation history listing isn't needed.
   */
  list(): Promise<ChatSessionSummary[]>;
}

// ─── Session Summary ───────────────────────────────────────────

/**
 * Lightweight session metadata for listing past conversations.
 *
 * Intentionally excludes `conversation` and `displayMessages`
 * to keep list queries fast. Load the full session only when
 * the user selects one.
 */
export interface ChatSessionSummary {
  sessionId: string;
  /** First user message or a generated title */
  title: string;
  /** Number of user messages in this session */
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}
