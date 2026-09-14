/**
 * useAgentChat — Generic Yield/Resume Agent Chat Hook
 *
 * Manages the tool-calling loop between a caller and an agent endpoint.
 * Domain-agnostic — the consumer provides tool definitions, a resolver
 * function, and an endpoint. The hook handles the HTTP loop, conversation
 * state, abort handling, and display messages.
 *
 * The core protocol loop is in `agent-loop.ts` (pure async, testable
 * without React). This hook wraps it with React state management.
 *
 * @example
 *   const agent = useAgentChat({
 *     endpoint: "/api/my-agent",
 *     tools: myToolDefinitions,
 *     resolveToolCall: (call) => myResolver(call),
 *     onMetadata: (meta) => handleDomainPayload(meta),
 *   });
 *
 *   return <Chat messages={agent.messages} onSend={agent.sendMessage} />;
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { runAgentLoop } from "./agent-loop.js";
import { shouldSaveSession, isStaleLoad } from "./session-sync.js";
import { ToolLabelFormatter } from "./tool-label-formatter.js";
import {
  startTurn,
  getTurn,
  subscribeTurn,
  abortTurn,
  subscribeBackgroundSessions,
  maxMsgIdSuffix,
} from "./turn-manager.js";
import type { ExecutionSnapshot } from "./turn-manager.js";
import type {
  AgentChatOptions,
  AgentChatReturn,
  AgentMessage,
  AgentTurn,
} from "./types.js";

const defaultFormatter = new ToolLabelFormatter();

// ─── Hook ────────────────────────────────────────────────────

export function useAgentChat<M = Record<string, unknown>>(
  options: AgentChatOptions<M>,
): AgentChatReturn {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messageIdCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<AgentTurn[]>([]);

  // Capture options in refs to avoid stale closures in sendMessage
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Mirror of `messages` for synchronous reads in sendMessage — background mode
  // snapshots the current display as the new turn's baseline.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // sessionIds (for this store) with an in-flight background turn — for tab UI.
  const [backgroundSessions, setBackgroundSessions] = useState<string[]>([]);

  // ── Optional session persistence (sessionId + store) ─────
  const { sessionId, store, backgroundTurns } = options;
  // Background (detached) turns need a store (somewhere to persist) and a
  // sessionId (a stable identity to run under). Enabled only when all three line
  // up; otherwise every path below is the original, byte-for-byte behavior.
  const bgEnabled = Boolean(backgroundTurns) && store != null && sessionId != null;
  // Monotonic token so a slow load() for a since-abandoned session is ignored.
  const loadSeqRef = useRef(0);
  // The sessionId whose data currently populates messages/conversation. The save
  // effect only writes once this matches the active sessionId — so a tab switch
  // can't save the old tab's turns under the new tab's key before its load lands.
  const hydratedIdRef = useRef<string | undefined>(undefined);
  // Preserve a restored session's original createdAt across re-saves.
  const createdAtRef = useRef<string | null>(null);
  // A3: true only when the user/loop has actually mutated the conversation since
  // the last load. A load resets it to false so merely opening (hydrating) a
  // session can't trigger a re-save that bumps its updatedAt on every view.
  const isDirtyRef = useRef(false);

  const nextId = useCallback(() => {
    messageIdCounter.current += 1;
    return `msg-${messageIdCounter.current}`;
  }, []);

  // ── Send Message ─────────────────────────────────────────

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      // ── Background (detached) turn path ──────────────────────
      // The turn runs in the module-level manager, NOT this hook — so it survives
      // sessionId changes and unmount. The subscription effect (below) drives
      // `messages` + `isLoading` from the manager's live record; nothing is set
      // inline here. The execution context (endpoint, tools, resolver, callbacks)
      // is snapshotted now so a later tab switch can't change what a backgrounded
      // turn uses.
      const o = optionsRef.current;
      if (Boolean(o.backgroundTurns) && o.store != null && o.sessionId != null) {
        // Per-session single-flight: ignore a re-send while a turn is already live.
        if (getTurn(o.store, o.sessionId)) return;
        const snapshot: ExecutionSnapshot = {
          endpoint: o.endpoint,
          tools: o.tools,
          resolveToolCall: o.resolveToolCall,
          ...(o.maxIterations !== undefined
            ? { maxIterations: o.maxIterations }
            : {}),
          formatter: o.toolLabelFormatter ?? defaultFormatter,
          ...(o.toolCallContext !== undefined
            ? { toolCallContext: o.toolCallContext }
            : {}),
          sendStructuredMessages: o.sendStructuredMessages ?? false,
          conversation: [...conversationRef.current],
          displayMessages: messagesRef.current,
          createdAt: createdAtRef.current,
          ...(o.onToolCallStart !== undefined
            ? { onToolCallStart: o.onToolCallStart }
            : {}),
          ...(o.onMetadata !== undefined
            ? { onMetadata: o.onMetadata as ExecutionSnapshot["onMetadata"] }
            : {}),
          ...(o.onTurnError !== undefined ? { onTurnError: o.onTurnError } : {}),
        };
        startTurn(o.store, o.sessionId, snapshot, content);
        return;
      }

      if (isLoading) return;

      // Abort any previous in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Add user message to display
      const userMsg: AgentMessage = {
        id: nextId(),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      // A3: a real turn is starting — everything appended below (user message,
      // final message, or an error/max-iteration bubble) is a genuine mutation
      // the save effect should persist.
      isDirtyRef.current = true;
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const {
          endpoint,
          tools,
          resolveToolCall,
          maxIterations,
          toolLabelFormatter,
          toolCallContext,
          sendStructuredMessages,
        } = optionsRef.current;
        const formatter = toolLabelFormatter ?? defaultFormatter;

        // Chat-flow mode sends structured turns (prior conversation + this user
        // turn); the default path sends flattened `parameters.conversation`.
        const modeArgs = sendStructuredMessages
          ? {
              messages: [
                ...conversationRef.current,
                { role: "user" as const, content },
              ],
            }
          : { parameters: { conversation: conversationRef.current } };

        const result = await runAgentLoop<M>(content, {
          endpoint,
          tools,
          resolveToolCall,
          maxIterations,
          signal: controller.signal,
          ...modeArgs,
          onToolCallStart: (toolCalls) => {
            const labels = formatter.format(toolCalls, toolCallContext);
            const now = Date.now();
            const thinkingMsgs: AgentMessage[] = labels.map((label) => ({
              id: nextId(),
              role: "thinking" as const,
              content: label,
              timestamp: now,
            }));
            setMessages((prev) => [...prev, ...thinkingMsgs]);
            optionsRef.current.onToolCallStart?.(toolCalls);
          },
        });

        if (result.type === "message") {
          // Update conversation history for multi-turn context
          conversationRef.current.push({ role: "user", content });
          conversationRef.current.push({
            role: "assistant",
            content: result.content,
          });
          appendFinalMessage(result.content, result.metadata);
        } else {
          // DELIBERATE: the "reached maximum steps" bubble is appended to the
          // display only, NOT to conversationRef. Error/status bubbles are
          // UI-only and are intentionally NOT fed back to the model as turns.
          appendFinalMessage(
            "I gathered some information but reached the maximum number of steps. Could you rephrase your question?",
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        // DELIBERATE: the error bubble is appended to the display only, NOT to
        // conversationRef. Error/status bubbles are UI-only and are
        // intentionally NOT fed back to the model as turns.
        const errorMsg: AgentMessage = {
          id: nextId(),
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Something went wrong."}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, nextId],
  );

  // ── Append Final Message ─────────────────────────────────

  function appendFinalMessage(content: string, metadata?: M) {
    const assistantMsg: AgentMessage = {
      id: nextId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMsg]);

    // Notify consumer of metadata
    optionsRef.current.onMetadata?.(metadata);
  }

  // ── Stop ─────────────────────────────────────────────────

  // Abort the in-flight loop. The pending fetch rejects with AbortError, which
  // sendMessage's catch swallows; setting isLoading false here re-enables the
  // composer immediately instead of waiting for that rejection to settle.
  const stop = useCallback((sessionId?: string) => {
    const o = optionsRef.current;
    if (Boolean(o.backgroundTurns) && o.store != null) {
      // Background mode: abort a specific session's turn (defaults to the active
      // one). The subscription flips isLoading when the abort finalizes; clear it
      // eagerly too when aborting the active session for an instant composer.
      const target = sessionId ?? o.sessionId;
      if (target != null) abortTurn(o.store, target);
      if (target === o.sessionId) setIsLoading(false);
      return;
    }
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  // ── Session Load (restore on mount / sessionId change) ────
  // With a store + sessionId, restore that session's conversation + display.
  //
  // Default: switching sessionId aborts any in-flight turn and swaps to the new
  // session, so a multi-session UI (tabs) gets restore for free by changing the
  // id. Background mode: switching NEVER aborts — the turn keeps running in the
  // module manager. If the new session has a live turn, the subscription effect
  // (below) owns the view, so we don't overwrite it with a store load.
  useEffect(() => {
    if (!store || sessionId == null) {
      // No persistence: whatever is in memory belongs to "no session".
      hydratedIdRef.current = sessionId;
      isDirtyRef.current = false;
      return;
    }
    const seq = ++loadSeqRef.current;
    const background = Boolean(optionsRef.current.backgroundTurns);
    // Default path aborts the outgoing turn; background path leaves it running.
    if (!background) abortRef.current?.abort();
    // Reset the composer; the subscription re-derives isLoading from any live
    // turn for the incoming session (background mode).
    setIsLoading(false);

    if (background) {
      // A live turn for the incoming session takes over via the subscription;
      // seed the refs from its record so save-gating / id-minting stay consistent
      // and skip the store load (it would clobber the live display).
      const live = getTurn(store, sessionId);
      if (live) {
        conversationRef.current = [...live.conversation];
        createdAtRef.current = live.createdAt;
        messageIdCounter.current = Math.max(
          messageIdCounter.current,
          maxMsgIdSuffix(live.displayMessages),
        );
        hydratedIdRef.current = sessionId;
        isDirtyRef.current = false;
        return;
      }
    }

    let cancelled = false;
    Promise.resolve(store.load(sessionId))
      .then((session) => {
        // Ignore a resolved load that a newer sessionId change superseded.
        if (cancelled || isStaleLoad({ loadSeqAtStart: seq, currentLoadSeq: loadSeqRef.current }))
          return;
        // Background: a turn may have STARTED for this session during the async
        // load — it owns the view now, so don't clobber it with stale store data.
        if (background && getTurn(store, sessionId)) {
          hydratedIdRef.current = sessionId;
          isDirtyRef.current = false;
          return;
        }
        if (session) {
          setMessages(session.displayMessages);
          conversationRef.current = [...session.conversation];
          createdAtRef.current = session.createdAt;
          messageIdCounter.current = Math.max(
            messageIdCounter.current,
            maxMsgIdSuffix(session.displayMessages),
          );
        } else {
          setMessages([]);
          conversationRef.current = [];
          createdAtRef.current = null;
        }
        hydratedIdRef.current = sessionId;
        // A3: hydration is not a mutation — opening this session must not re-save it.
        isDirtyRef.current = false;
      })
      .catch(() => {
        if (cancelled || isStaleLoad({ loadSeqAtStart: seq, currentLoadSeq: loadSeqRef.current }))
          return;
        if (background && getTurn(store, sessionId)) {
          hydratedIdRef.current = sessionId;
          isDirtyRef.current = false;
          return;
        }
        // A failed load starts the session empty rather than stranding it.
        setMessages([]);
        conversationRef.current = [];
        createdAtRef.current = null;
        hydratedIdRef.current = sessionId;
        isDirtyRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, store, backgroundTurns]);

  // ── Background turn subscription (active session) ─────────
  // Mirrors the active session's live turn record into messages + isLoading.
  // cb(turn) always wins; cb(undefined) is a no-op so the loaded store baseline
  // stands. A no-op unless background mode is on.
  useEffect(() => {
    if (!bgEnabled || !store || sessionId == null) return;
    return subscribeTurn(store, sessionId, (turn) => {
      if (!turn) return;
      setMessages(turn.displayMessages);
      setIsLoading(turn.status === "running");
      if (turn.status !== "running") {
        // Terminal: the manager persisted this turn; keep the ref in sync so a
        // subsequent send builds on the completed conversation.
        conversationRef.current = [...turn.conversation];
      }
    });
  }, [bgEnabled, store, sessionId]);

  // ── Background turns live-set (for tab spinners) ─────────
  useEffect(() => {
    if (!backgroundTurns || store == null) {
      // Clear only if non-empty — returning the same reference lets React bail on
      // the update, so a flag-off consumer gets no extra render on mount.
      setBackgroundSessions((prev) => (prev.length ? [] : prev));
      return;
    }
    return subscribeBackgroundSessions(store, setBackgroundSessions);
  }, [backgroundTurns, store]);

  // ── Dev nudge: backgroundTurns needs a store + sessionId ──
  useEffect(() => {
    if (!backgroundTurns || (store != null && sessionId != null)) return;
    // Read NODE_ENV via globalThis so this stays browser/SSR-safe (no bare
    // `process` reference). Warn only outside production.
    const nodeEnv = (
      globalThis as { process?: { env?: { NODE_ENV?: string } } }
    ).process?.env?.NODE_ENV;
    if (nodeEnv !== "production") {
      console.warn(
        "[useAgentChat] `backgroundTurns` requires both `sessionId` and `store`; running turns inline instead.",
      );
    }
  }, [backgroundTurns, store, sessionId]);

  // ── Unmount cleanup ──────────────────────────────────────
  // A1: abort any in-flight turn when the component finally unmounts. Without
  // this, unmounting mid-turn keeps runAgentLoop POSTing resumes, keeps invoking
  // resolveToolCall (real side effects), and calls setMessages/setIsLoading on an
  // unmounted component. Empty deps → fires only on final unmount, so it does not
  // interfere with the per-send / per-sessionId abort logic above.
  //
  // Background turns intentionally SURVIVE unmount — they live in the module
  // manager (an unmounted hook has unsubscribed, so there is no stray setState,
  // and continued resolveToolCall is the feature). Only the inline path aborts.
  useEffect(
    () => () => {
      if (!optionsRef.current.backgroundTurns) abortRef.current?.abort();
    },
    [],
  );

  // ── Session Save (persist each settled exchange) ──────────
  // Fires on display changes, but only when this session is loaded (guards the
  // switch window) and no turn is in flight. Thinking bubbles are transient —
  // never persisted.
  useEffect(() => {
    if (!store || sessionId == null) return;
    // Background mode persists via the manager on turn completion — the hook's
    // own save would double-write (and race the manager). Leave it to the manager.
    if (backgroundTurns) return;
    const displayMessages = messages.filter((m) => m.role !== "thinking");
    // Save-gate decision (pure — see session-sync.ts). Blocks the write during
    // the tab-switch window (hydratedId mismatch), while a turn is in flight,
    // when nothing mutated the conversation since the last load (A3 — merely
    // opening a session must not re-save it), and when there is nothing to
    // persist. The empty-content skip is also what lets clearChat's delete()
    // stick: without it, the setMessages([]) in clearChat would re-fire this
    // effect and re-save an empty session over the delete.
    if (
      !shouldSaveSession({
        hydratedId: hydratedIdRef.current,
        activeSessionId: sessionId,
        isLoading,
        isDirty: isDirtyRef.current,
        messageCount: displayMessages.length + conversationRef.current.length,
      })
    ) {
      return;
    }
    const now = new Date().toISOString();
    // Persistence is best-effort; a failed save never breaks the live chat.
    createdAtRef.current ??= now;
    Promise.resolve(
      store.save({
        sessionId,
        conversation: [...conversationRef.current],
        displayMessages,
        createdAt: createdAtRef.current,
        updatedAt: now,
      }),
    ).catch(() => undefined);
  }, [messages, isLoading, sessionId, store, backgroundTurns]);

  // ── Clear Chat ───────────────────────────────────────────

  const clearChat = useCallback(() => {
    const { sessionId: sid, store: st, backgroundTurns: bg } = optionsRef.current;
    // Background: discard any in-flight turn for this session BEFORE the delete,
    // so its (removed) record can't resurrect the session via a terminal save.
    // finalizeAbort notifies `undefined`, so it won't repopulate the cleared view.
    if (Boolean(bg) && st != null && sid != null) abortTurn(st, sid);
    setMessages([]);
    conversationRef.current = [];
    createdAtRef.current = null;
    // A3: clearing is a real mutation. The delete() below persists it directly;
    // the (now empty) save effect is separately blocked by the empty-content
    // guard, so this never re-saves an empty session over the delete.
    isDirtyRef.current = true;
    if (st && sid != null) Promise.resolve(st.delete(sid)).catch(() => undefined);
  }, []);

  // ── Return ───────────────────────────────────────────────

  return {
    messages,
    isLoading,
    sendMessage,
    stop,
    clearChat,
    conversation: conversationRef.current,
    backgroundSessions,
  };
}
