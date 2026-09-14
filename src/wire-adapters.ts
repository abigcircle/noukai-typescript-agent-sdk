/**
 * Wire Adapters — LLM wire format conversions
 *
 * Translates between the internal @noukai/agent types (parsed object arguments)
 * and the Noukai wire format used by the slug endpoint. Casing is **camelCase**
 * on both sides now (`toolCallId`, `toolCalls`) — the router-ai-slugs execute API
 * accepts/emits camelCase for message contents, so snake_case no longer appears
 * on the Noukai wire. The remaining translation these adapters perform is
 * structural, not casing: the nested `function` envelope and the JSON-string
 * `function.arguments` (object ⇄ string).
 *
 * These are pure functions with no side effects — easy to test in isolation.
 */

import type { ChatMessage } from "@noukai/sdk";
import type { AgentTurn, ToolCall, ToolDefinition } from "./types.js";

// ─── Wire Types (slug endpoint / LLM provider format) ───────

/** Tool definition as sent on the wire to the slug endpoint.
 *  The index signature makes it structurally assignable to the SDK's
 *  `Record<string, unknown>[]` tool/handler slots without an `as unknown` cast. */
export interface WireToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/** Tool call as returned from the LLM via the slug endpoint */
export interface WireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments string */
    arguments: string;
  };
  [key: string]: unknown;
}

/** Tool result message in the wire format (camelCase `toolCallId`). */
export interface WireToolResult {
  role: "tool";
  toolCallId: string;
  content: string;
  [key: string]: unknown;
}

// ─── Converters ──────────────────────────────────────────────

/** Wrap an internal ToolDefinition into the wire envelope */
export function toWireToolDef(def: ToolDefinition): WireToolDef {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: { ...def.parameters },
    },
  };
}

/** Wrap multiple ToolDefinitions */
export function toWireToolDefs(defs: ToolDefinition[]): WireToolDef[] {
  return defs.map(toWireToolDef);
}

/**
 * Parse a wire-format tool call into the internal ToolCall shape.
 *
 * If `function.arguments` is malformed JSON, the parsed arguments will
 * contain a `_parseError` key with the raw string so the resolver can
 * surface a helpful error back to the model.
 */
export function parseWireToolCall(raw: WireToolCall): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(raw.function.arguments);
  } catch {
    args = { _parseError: raw.function.arguments };
  }
  return {
    id: raw.id,
    name: raw.function.name,
    arguments: args,
  };
}

/** Build a tool result message in the wire format */
export function toWireToolResult(
  callId: string,
  content: string,
): WireToolResult {
  return {
    role: "tool",
    toolCallId: callId,
    content,
  };
}

/** Serialize an internal ToolCall (object arguments) into the wire tool-call
 *  envelope (nested `function`, JSON-string arguments). Inverse of
 *  {@link parseWireToolCall}. */
export function toWireToolCall(call: ToolCall): WireToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  };
}

/**
 * Convert internal {@link AgentTurn}s into the SDK's wire {@link ChatMessage}s
 * for a structured (chat-flow) fresh call. Replaces the previous
 * `messages as unknown as ChatMessage[]` cast: casing already matches
 * (camelCase both sides), and this handles the one real structural difference —
 * an assistant tool-call turn's internal `ToolCall[]` (object arguments) becomes
 * the wire tool-call envelope (JSON-string arguments) via {@link toWireToolCall}.
 */
export function toChatMessages(turns: AgentTurn[]): ChatMessage[] {
  return turns.map((t): ChatMessage => {
    if (t.role === "tool") {
      return { role: "tool", toolCallId: t.toolCallId, content: t.content };
    }
    if (t.role === "assistant" && "toolCalls" in t) {
      return { role: "assistant", content: null, toolCalls: t.toolCalls.map(toWireToolCall) };
    }
    return { role: t.role, content: t.content };
  });
}
