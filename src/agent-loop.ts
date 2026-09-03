/**
 * runAgentLoop — Slug execute pause/resume tool-calling loop
 *
 * Implements the native tool-calling protocol for the slug /execute
 * endpoint. The server is stateless — all execution context (toolCallMessages,
 * executionId, etc.) is passed back and forth between client and server.
 *
 * Flow:
 *   1. POST { message, tools, parameters? } (fresh call)
 *   2. If status "tool_calls_required":
 *      - Resolve tool calls locally via the provided resolver
 *      - Append tool result messages to toolCallMessages
 *      - POST { executionId, pausedAtStep, iterationsUsed, toolCallMessages, tools }
 *      - Repeat from 2
 *   3. If status "completed": return result
 *
 * The hook (`useAgentChat`) wraps this with React state management,
 * display messages, and abort handling.
 */

import type { AgentTurn, ToolCall, ToolDefinition, ToolResolver, ToolResult } from "./types.js";
import {
  toWireToolDefs,
  parseWireToolCall,
  toWireToolResult,
} from "./wire-adapters.js";
import type { WireToolCall, WireToolResult } from "./wire-adapters.js";

// ─── Types ───────────────────────────────────────────────────

export interface AgentLoopOptions<M = Record<string, unknown>> {
  /** API endpoint to POST to (BFF route) */
  endpoint: string;
  /** Tool definitions in internal format (converted to OpenAI format on the wire) */
  tools: ToolDefinition[];
  /** Function to resolve tool calls locally */
  resolveToolCall: ToolResolver;
  /** Max tool-calling loop iterations (default: 12) */
  maxIterations?: number;
  /** Abort signal (optional) */
  signal?: AbortSignal;
  /** Fetch implementation (defaults to globalThis.fetch) — useful for testing */
  fetch?: typeof globalThis.fetch;
  /** Called when tool calls are about to be resolved — use for progress UI */
  onToolCallStart?: (toolCalls: ToolCall[]) => void;
  /** Extra parameters sent on the first (fresh) call — e.g., { conversation } for multi-turn */
  parameters?: Record<string, unknown>;
  /** Tool choice: "auto" (default), "none", "required", or {type: "function", function: {name}} */
  toolChoice?: string | Record<string, unknown>;
  /**
   * Chat-flow mode: structured prior conversation (already ending with the
   * current user turn). When set, the fresh call sends top-level `messages`
   * instead of `message` + `parameters.conversation`; `message`/`parameters`
   * are ignored. Absent = the default (Nana) path, unchanged.
   */
  messages?: AgentTurn[];
}

export type AgentLoopResult<M = Record<string, unknown>> =
  | { type: "message"; content: string; metadata?: M }
  | { type: "max_iterations" };

// ─── Backend Response Shapes ─────────────────────────────────

interface PausedResponse {
  status: "tool_calls_required";
  executionId: string;
  pausedAtStep: string;
  iterationsUsed: number;
  toolCallMessages: Record<string, unknown>[];
  toolCalls: WireToolCall[];
  accumulatedOutputs: Record<string, unknown>;
  flowId: string;
  blockCount: number;
}

interface CompletedResponse {
  status: "completed";
  result: unknown;
  flowId: string;
  blockCount: number;
}

type SlugResponse = PausedResponse | CompletedResponse;

// ─── Loop ────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 12;

export async function runAgentLoop<M = Record<string, unknown>>(
  message: string,
  options: AgentLoopOptions<M>,
): Promise<AgentLoopResult<M>> {
  const {
    endpoint,
    tools,
    resolveToolCall,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    signal,
    fetch: fetchFn = globalThis.fetch,
    onToolCallStart,
    parameters,
    toolChoice,
    messages,
  } = options;

  const wireTools = toWireToolDefs(tools);

  // Track resolved tool calls to skip duplicate resolver invocations.
  // Key: "toolName:serializedArgs" → cached result string.
  const resolvedCache = new Map<string, string>();

  // Fresh call. Chat-flow mode sends structured `messages`; the default (Nana)
  // path sends `message` + `parameters.conversation`. Resume shape is shared.
  let body: Record<string, unknown> =
    messages != null
      ? {
          messages,
          tools: wireTools,
          ...(toolChoice != null ? { toolChoice } : {}),
        }
      : {
          message,
          tools: wireTools,
          ...(toolChoice != null ? { toolChoice } : {}),
          ...(parameters != null ? { parameters } : {}),
        };

  for (let i = 0; i < maxIterations; i++) {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const detail = errorData as Record<string, unknown>;
      const errorMsg =
        (detail.detail as Record<string, unknown>)?.message ??
        detail.error ??
        `API error: ${response.status} ${response.statusText}`;
      throw new Error(String(errorMsg));
    }

    const data = (await response.json()) as SlugResponse;

    // ── Completed ─────────────────────────────────────────
    if (data.status === "completed") {
      return extractResult<M>(data.result);
    }

    // ── Paused for tool calls ─────────────────────────────
    if (data.status === "tool_calls_required") {
      const allCalls = data.toolCalls.map(parseWireToolCall);

      // Deduplicate: skip resolver for tool calls already seen with identical args
      const fresh: ToolCall[] = [];
      const cached: { call: ToolCall; result: string }[] = [];

      for (const call of allCalls) {
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        const hit = resolvedCache.get(key);
        if (hit !== undefined) {
          cached.push({ call, result: hit });
        } else {
          fresh.push(call);
        }
      }

      // Build tool result messages to append to the server's toolCallMessages
      const toolResultMessages: WireToolResult[] = [];

      // Append cached results
      for (const { call, result } of cached) {
        toolResultMessages.push(toWireToolResult(call.id, result));
      }

      // Resolve fresh tool calls one at a time, notifying before each so
      // thinking labels appear sequentially.
      for (const call of fresh) {
        onToolCallStart?.([call]);
        const result: ToolResult = await Promise.resolve(resolveToolCall(call));
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        resolvedCache.set(key, result.result);
        toolResultMessages.push(toWireToolResult(call.id, result.result));
      }

      // Build resume request — echo back server state + append our tool results
      body = {
        executionId: data.executionId,
        pausedAtStep: data.pausedAtStep,
        iterationsUsed: data.iterationsUsed,
        toolCallMessages: [
          ...data.toolCallMessages,
          ...toolResultMessages.map((m) => ({ ...m })),
        ],
        accumulatedOutputs: data.accumulatedOutputs,
        tools: wireTools,
      };

      continue;
    }

    // ── Unknown status ────────────────────────────────────
    throw new Error(
      `Unexpected response status: ${(data as Record<string, unknown>).status}`,
    );
  }

  return { type: "max_iterations" };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract content and metadata from the flow's `result` field.
 *
 * The Nana flow returns: { type: "message", content: string, metadata?: { operations } }
 * Chat flows return the seeded block's output schema: { message: string }
 */
function extractResult<M>(result: unknown): AgentLoopResult<M> {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.content === "string") {
      return { type: "message", content: obj.content, metadata: result as M };
    }
    if (typeof obj.message === "string") {
      return { type: "message", content: obj.message, metadata: result as M };
    }
  }

  // Plain string result (no metadata)
  const content = typeof result === "string" ? result : JSON.stringify(result);
  return { type: "message", content };
}
