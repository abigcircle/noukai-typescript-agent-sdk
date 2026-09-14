/**
 * runAgentLoop — the slug execute pause/resume tool-calling loop.
 *
 * As of the agent-relay rewire (design 20260903-SDK-agent-relay, PR-3) this is
 * a thin adapter over `@noukai/sdk`'s `createRelayFlow` — the yield/resume loop,
 * the request/response models, and the round limit now live in ONE place (the
 * SDK). This package no longer re-declares the wire response shapes
 * (`PausedResponse`/`CompletedResponse`) or the loop; it maps the SDK's
 * `ExecuteResult`/`PausedResult` into `@noukai/agent`'s public
 * `AgentLoopResult`, and keeps this package's value-adds: local tool resolution,
 * duplicate-call de-duplication, `onToolCallStart` progress hooks, both fresh
 * request modes (`message` vs structured `messages`), and the `extractResult`
 * unwrapping.
 *
 * The public surface (`runAgentLoop`, `AgentLoopOptions`, `AgentLoopResult`) is
 * unchanged. Behavior deltas from the previous hand-rolled loop (all documented
 * in CHANGELOG): the client round limit is now the SDK's 10 (was 12); errors are
 * the SDK's typed `NoukaiError` subclasses (still `instanceof Error`); resume
 * requests carry the SDK's standard fields (server-ignored).
 */

import {
  createRelayFlow,
  ToolCallLimitError,
  FlowExecutionError,
  NoukaiError,
} from "@noukai/sdk";
import type { AgentTurn, ToolCall, ToolDefinition, ToolResolver, ToolResult } from "./types.js";
import {
  toWireToolDefs,
  parseWireToolCall,
  toWireToolResult,
  toChatMessages,
} from "./wire-adapters.js";
import type { WireToolCall } from "./wire-adapters.js";

// ─── Types ───────────────────────────────────────────────────

export interface AgentLoopOptions<M = Record<string, unknown>> {
  /** API endpoint to POST to (BFF relay route) */
  endpoint: string;
  /** Tool definitions in internal format (converted to OpenAI format on the wire) */
  tools: ToolDefinition[];
  /** Function to resolve tool calls locally */
  resolveToolCall: ToolResolver;
  /** Max tool-calling loop rounds (default: 10 — the SDK's `DEFAULT_MAX_TOOL_ROUNDS`) */
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

// ─── Loop ────────────────────────────────────────────────────

/** The client round limit. Reconciled to the SDK's `DEFAULT_MAX_TOOL_ROUNDS` (was 12). */
const DEFAULT_MAX_ITERATIONS = 10;

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
    fetch: fetchFn,
    onToolCallStart,
    parameters,
    toolChoice,
    messages,
  } = options;

  // WireToolDef carries an index signature, so it is structurally a
  // Record<string, unknown> — no `as unknown` cast needed at the SDK seam.
  const wireTools = toWireToolDefs(tools);

  // Local tool resolution, keeping this package's dedup + progress-hook value-adds.
  // Key: "toolName:serializedArgs" → cached result string (persists across rounds).
  const resolvedCache = new Map<string, string>();

  const toolHandler = async (
    rawCalls: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> => {
    const allCalls = rawCalls.map((c) => parseWireToolCall(c as unknown as WireToolCall));

    const cached: { call: ToolCall; result: string }[] = [];
    const fresh: ToolCall[] = [];
    for (const call of allCalls) {
      const key = `${call.name}:${JSON.stringify(call.arguments)}`;
      const hit = resolvedCache.get(key);
      if (hit !== undefined) cached.push({ call, result: hit });
      else fresh.push(call);
    }

    const results: Record<string, unknown>[] = [];
    // Cached results first (matches the previous loop's ordering).
    for (const { call, result } of cached) {
      results.push(toWireToolResult(call.id, result));
    }
    // Resolve fresh calls one at a time, notifying before each so thinking
    // labels appear sequentially.
    for (const call of fresh) {
      onToolCallStart?.([call]);
      const result: ToolResult = await Promise.resolve(resolveToolCall(call));
      const key = `${call.name}:${JSON.stringify(call.arguments)}`;
      resolvedCache.set(key, result.result);
      results.push(toWireToolResult(call.id, result.result));
    }
    return results;
  };

  const flow = createRelayFlow({
    url: endpoint,
    ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
  });

  // Fresh call. Chat-flow mode sends structured `messages`; the default (Nana)
  // path sends `message` + `parameters`. Resume shape is owned by the SDK loop.
  const common = {
    tools: wireTools,
    ...(toolChoice != null ? { toolChoice } : {}),
    toolHandler,
    maxToolRounds: maxIterations,
    ...(signal !== undefined ? { signal } : {}),
  };

  try {
    const result =
      messages != null
        ? await flow.execute({ messages: toChatMessages(messages), ...common })
        : await flow.execute({
            message,
            ...(parameters != null ? { parameters } : {}),
            ...common,
          });

    // Defensive guard for the no-handler case: with a `toolHandler` passed (as
    // we always do here) the SDK loop auto-resumes to a terminal result or
    // throws ToolCallLimitError, so a residual pause is unreachable. Kept — not
    // removed — to preserve the type-narrowing on `result` for the code below.
    if (result.requiresToolCalls) {
      return { type: "max_iterations" };
    }
    // A flow that completes with status:"failed" (HTTP 200) is an execution
    // failure, not a message. The pre-rewire loop threw on any status that was
    // neither "completed" nor "tool_calls_required"; preserve that contract so
    // a failed run is not silently surfaced as an (often empty) assistant
    // message. (design 20260903-SDK-agent-relay, PR-3 — regression fix.)
    if (result.status === "failed") {
      const detail = result.result !== undefined ? `: ${JSON.stringify(result.result)}` : "";
      throw new FlowExecutionError(`Flow execution failed${detail}`, {
        statusCode: 200,
        responseBody: result.result,
        code: "FLOW_EXECUTION_FAILED",
      });
    }
    return extractResult<M>(result.result);
  } catch (err) {
    // The SDK throws ToolCallLimitError at the client round limit; the public
    // contract here is the `max_iterations` sentinel, not a throw.
    if (err instanceof ToolCallLimitError) {
      return { type: "max_iterations" };
    }
    throw withFriendlyMessage(err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Recover a friendly server message the SDK's error mapping dropped.
 *
 * The SDK only lifts `detail.message` onto the error when the body carries BOTH
 * a string `code` AND a string `message` (`parseErrorDetail`). A
 * `{detail:{message}}` body *without* a `code` therefore regresses to the SDK's
 * generic fallback (the JSON-stringified body / `HTTP <status>`). When the
 * caught error carries no `code`, prefer the body's `detail.message` so the
 * user-facing text stays friendly. When a `code` IS present the SDK already
 * surfaced `detail.message` — leave it untouched (existing behavior).
 */
function withFriendlyMessage(err: unknown): unknown {
  if (!(err instanceof NoukaiError) || err.code !== undefined) return err;
  const friendly = detailMessage(err.responseBody) ?? detailMessage(err);
  if (friendly !== undefined && friendly !== err.message) {
    err.message = friendly;
  }
  return err;
}

/** Read a string `detail.message` off an unknown value, or undefined. */
function detailMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const detail = (value as { detail?: unknown }).detail;
  if (detail === null || typeof detail !== "object") return undefined;
  const message = (detail as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

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
