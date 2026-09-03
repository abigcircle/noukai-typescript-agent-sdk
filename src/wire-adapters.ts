/**
 * Wire Adapters — LLM wire format conversions
 *
 * Translates between the internal @noukai/agent types (camelCase,
 * parsed arguments) and the LLM wire format used by the slug
 * endpoint (snake_case tool_call_id, JSON-string arguments,
 * nested function envelope).
 *
 * These are pure functions with no side effects — easy to test in isolation.
 */

import type { ToolCall, ToolDefinition } from "./types.js";

// ─── Wire Types (slug endpoint / LLM provider format) ───────

/** Tool definition as sent on the wire to the slug endpoint */
export interface WireToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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
}

/** Tool result message in the wire format (note: snake_case tool_call_id) */
export interface WireToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
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
    tool_call_id: callId,
    content,
  };
}
