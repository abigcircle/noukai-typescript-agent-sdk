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

import { useState, useCallback, useRef } from "react";
import { runAgentLoop } from "./agent-loop.js";
import { ToolLabelFormatter } from "./tool-label-formatter.js";
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
          appendFinalMessage(
            "I gathered some information but reached the maximum number of steps. Could you rephrase your question?",
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
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

  // ── Clear Chat ───────────────────────────────────────────

  const clearChat = useCallback(() => {
    setMessages([]);
    conversationRef.current = [];
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
