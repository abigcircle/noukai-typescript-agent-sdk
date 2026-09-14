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

// ─── Default In-Memory Store ───────────────────────────────────

/**
 * Zero-config store that keeps sessions in a `Map` for the lifetime of the
 * instance. Nothing survives a reload — it exists so `useAgentChat({ store })`
 * works out of the box, and as a reference implementation for a real backend.
 *
 * This is an in-memory DEV/REFERENCE store: it has NO eviction (the Map grows
 * unbounded for the lifetime of the instance) and is NOT intended as production
 * persistence. For that, implement {@link ChatSessionStore} against localStorage,
 * IndexedDB, AsyncStorage, or a database — the shape is identical, only the
 * read/write calls change.
 */
export class MemorySessionStore implements ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  // Sync bodies wrapped in resolved Promises — the interface is async so any
  // backend (DB, network) fits, but an in-memory Map has nothing to await.
  // save/load deep-clone via structuredClone so a caller mutating a loaded (or
  // previously saved) session can't reach in and mutate the stored copy — a real
  // serializing backend would give the same isolation for free.
  load(sessionId: string): Promise<ChatSession | null> {
    const stored = this.sessions.get(sessionId);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }

  save(session: ChatSession): Promise<void> {
    this.sessions.set(session.sessionId, structuredClone(session));
    return Promise.resolve();
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  list(): Promise<ChatSessionSummary[]> {
    return Promise.resolve(
      [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        title:
          s.conversation.find((t) => t.role === "user")?.content ?? "New chat",
        messageCount: s.conversation.filter((t) => t.role === "user").length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    );
  }
}

/*
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ RECIPE: persisting DOMAIN state alongside a session ("overlay")  │
 * │                                                                  │
 * │ A ChatSession only holds what the agent framework understands:   │
 * │ `conversation` (LLM turns) and `displayMessages` (rendered chat).│
 * │ Your app usually has MORE per-session state the framework knows  │
 * │ nothing about — pending actions awaiting confirmation, a toggle  │
 * │ like "auto-apply", inline diff/preview cards, a draft input.     │
 * │                                                                  │
 * │ Don't try to cram that into ChatSession. Keep the framework      │
 * │ store generic and persist your overlay in a SECOND store keyed   │
 * │ by the SAME sessionId. Restore it whenever sessionId changes.    │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * If you are an LLM/codegen assistant wiring this up in a consumer app,
 * follow these steps verbatim:
 *
 *   1. Define your overlay type — everything per-session the agent doesn't own:
 *        interface MyOverlay { pendingActions: Action[]; autoApply: boolean }
 *
 *   2. Persist it in your own store, keyed by sessionId (mirror the backend
 *      you gave the agent — localStorage, IndexedDB, etc.):
 *        overlayStore.save(sessionId, overlay)   // on every overlay change
 *        overlayStore.load(sessionId)            // returns MyOverlay | null
 *
 *   3. Feed the agent the same id and its (framework) store:
 *        const agent = useAgentChat({ ...opts, sessionId, store });
 *
 *   4. Restore the overlay whenever the session changes, into YOUR OWN React
 *      state (this is 100% reliable — it is state your app owns, unlike the
 *      agent's internal messages/conversation):
 *        useEffect(() => {
 *          setOverlay(overlayStore.load(sessionId) ?? emptyOverlay());
 *        }, [sessionId]);
 *
 *   5. Render agent.messages + your overlay together. Switching sessionId now
 *      restores BOTH the conversation (framework) and your overlay (app) — no
 *      reaching into agent internals, no re-implementing the agent's persistence.
 *
 * WHY a second store instead of one generic ChatSession<Extra>? Because the
 * framework store stays domain-free and reusable, and your overlay stays fully
 * typed and owned by your app. The only coupling is the shared sessionId.
 */
