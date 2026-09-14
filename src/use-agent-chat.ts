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
import type {
  AgentChatOptions,
  AgentChatReturn,
  AgentMessage,
  AgentTurn,
} from "./types.js";

/** Largest numeric suffix of an `msg-N` id, or 0. Keeps the id counter ahead of
 *  restored ids so a rehydrated session can't mint a colliding message id. */
function maxMsgIdSuffix(messages: AgentMessage[]): number {
  let max = 0;
  for (const m of messages) {
    const n = Number.parseInt(m.id.replace(/^msg-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

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

  // ── Optional session persistence (sessionId + store) ─────
  const { sessionId, store } = options;
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
      if (!content.trim() || isLoading) return;

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
  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  // ── Session Load (restore on mount / sessionId change) ────
  // With a store + sessionId, restore that session's conversation + display.
  // Switching sessionId aborts any in-flight turn and swaps to the new session,
  // so a multi-session UI (tabs) gets restore for free by changing the id.
  useEffect(() => {
    if (!store || sessionId == null) {
      // No persistence: whatever is in memory belongs to "no session".
      hydratedIdRef.current = sessionId;
      isDirtyRef.current = false;
      return;
    }
    const seq = ++loadSeqRef.current;
    // Leaving the current session mid-turn: drop the in-flight request.
    abortRef.current?.abort();
    setIsLoading(false);
    let cancelled = false;
    Promise.resolve(store.load(sessionId))
      .then((session) => {
        // Ignore a resolved load that a newer sessionId change superseded.
        if (cancelled || isStaleLoad({ loadSeqAtStart: seq, currentLoadSeq: loadSeqRef.current }))
          return;
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
  }, [sessionId, store]);

  // ── Unmount cleanup ──────────────────────────────────────
  // A1: abort any in-flight turn when the component finally unmounts. Without
  // this, unmounting mid-turn keeps runAgentLoop POSTing resumes, keeps invoking
  // resolveToolCall (real side effects), and calls setMessages/setIsLoading on an
  // unmounted component. Empty deps → fires only on final unmount, so it does not
  // interfere with the per-send / per-sessionId abort logic above.
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Session Save (persist each settled exchange) ──────────
  // Fires on display changes, but only when this session is loaded (guards the
  // switch window) and no turn is in flight. Thinking bubbles are transient —
  // never persisted.
  useEffect(() => {
    if (!store || sessionId == null) return;
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
  }, [messages, isLoading, sessionId, store]);

  // ── Clear Chat ───────────────────────────────────────────

  const clearChat = useCallback(() => {
    setMessages([]);
    conversationRef.current = [];
    createdAtRef.current = null;
    // A3: clearing is a real mutation. The delete() below persists it directly;
    // the (now empty) save effect is separately blocked by the empty-content
    // guard, so this never re-saves an empty session over the delete.
    isDirtyRef.current = true;
    const { sessionId: sid, store: st } = optionsRef.current;
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
  };
}
