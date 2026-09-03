/**
 * Stateless Agent Protocol — Wire types for yield/resume
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ HOW THE STATELESS PROTOCOL WORKS                               │
 * │                                                                │
 * │ The server holds NO state between requests. All execution      │
 * │ context is passed back and forth via an opaque state token.    │
 * │                                                                │
 * │ This is the same model as every major LLM API (OpenAI, Claude, │
 * │ Gemini) — the caller sends the full conversation each time.   │
 * │ The state token extends this by also carrying iteration count, │
 * │ pending context, and server-side metadata.                     │
 * │                                                                │
 * │ The token is:                                                  │
 * │   - Opaque to the caller (encrypted + signed by the server)   │
 * │   - Tamper-proof (HMAC-SHA256 signature)                       │
 * │   - Compressed (gzip, since conversation text compresses ~80%) │
 * │   - Bounded (max size enforced, summarization if exceeded)     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ REQUEST FLOW                                                   │
 * │                                                                │
 * │ Exchange 1 (new user message):                                 │
 * │   POST { messages, tools }                                     │
 * │     → Server runs agent loop                                   │
 * │     → Hits a client tool → yields                              │
 * │     → Response: { type: "tool_calls", toolCalls, stateToken }  │
 * │                                                                │
 * │ Exchange 1 (resume with tool results):                         │
 * │   POST { stateToken, toolResults }                             │
 * │     → Server decrypts token, restores conversation             │
 * │     → Appends tool results, continues loop                     │
 * │     → Hits final message → completes                           │
 * │     → Response: { type: "message", content }                   │
 * │                                                                │
 * │ Exchange 2 (next user message):                                │
 * │   POST { messages, tools }      ← full history again           │
 * │     → No stateToken (fresh exchange, not a resume)             │
 * │     → ...                                                      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ STATE TOKEN LIFECYCLE                                          │
 * │                                                                │
 * │   Created:   when server yields tool calls                     │
 * │   Used:      when caller resumes with tool results             │
 * │   Discarded: after resume (new token issued if yielding again) │
 * │   Expired:   never (no TTL — resume whenever)                  │
 * │   Lost:      if page refreshes mid-yield, exchange restarts    │
 * │              from the last completed message (no data loss,    │
 * │              just re-execution of the current exchange)         │
 * └─────────────────────────────────────────────────────────────────┘
 */

import type { AgentTurn, ToolCall, ToolDefinition, ToolResult } from "./types.js";

// ─── Requests ──────────────────────────────────────────────────

/**
 * Initial request — starts a new agent exchange.
 *
 * Sent when the user types a new message. Contains the full
 * conversation history so the server can pass it to the LLM.
 * No state token — this is a fresh exchange.
 */
export interface AgentStartRequest {
  /** Full conversation history (accumulated by the caller) */
  messages: AgentTurn[];
  /** Client-side tool definitions the LLM can call */
  tools: ToolDefinition[];
}

/**
 * Resume request — continues a yielded agent exchange.
 *
 * Sent after the caller resolves yielded tool calls. Contains
 * the opaque state token (which encodes conversation + iteration
 * state) and the resolved tool results.
 *
 * The server decrypts the token, appends the tool results, and
 * continues the agent loop from where it left off.
 */
export interface AgentResumeRequest {
  /** Opaque state token from the previous yield */
  stateToken: string;
  /** Resolved tool call results */
  toolResults: ToolResult[];
}

/**
 * Union of both request types.
 *
 * The server distinguishes them by presence of `stateToken`:
 *   - Has `messages` + `tools`     → AgentStartRequest (new exchange)
 *   - Has `stateToken` + `toolResults` → AgentResumeRequest (resume)
 */
export type AgentRequest = AgentStartRequest | AgentResumeRequest;

// ─── Responses ─────────────────────────────────────────────────

/**
 * Server yields tool calls for the caller to resolve.
 *
 * The stateToken captures the full conversation and loop state
 * at this yield point. The caller resolves the tool calls and
 * sends an AgentResumeRequest with this token + results.
 */
export interface AgentYieldResponse {
  type: "tool_calls";
  /** Tool calls for the caller to resolve */
  toolCalls: ToolCall[];
  /**
   * Opaque state token — pass this back in AgentResumeRequest.
   *
   * The caller MUST NOT parse, modify, or depend on the structure
   * of this token. It is encrypted and signed by the server.
   * Treat it as an opaque string.
   */
  stateToken: string;
}

/**
 * Agent completed with a final message.
 *
 * No state token — the exchange is complete. The caller appends
 * this to their conversation history for the next exchange.
 *
 * The `metadata` field carries domain-specific payload (e.g.,
 * pipeline operations for the pipeline agent).
 */
export interface AgentCompleteResponse<M = Record<string, unknown>> {
  type: "message";
  content: string;
  metadata?: M;
}

/**
 * Agent errored during execution.
 *
 * The error may be retryable (rate limit, timeout) or terminal
 * (invalid state token, server error). The `retryable` flag
 * tells the caller whether to retry with the same request.
 *
 * If retryable and a stateToken is provided, the caller can
 * retry the resume. If no stateToken, the caller should restart
 * the exchange from the beginning (re-send messages + tools).
 */
export interface AgentErrorResponse {
  type: "error";
  code: AgentErrorCode;
  message: string;
  /** Whether the caller should retry this request */
  retryable: boolean;
  /** If retryable mid-yield, the token to use for retry */
  stateToken?: string;
}

/**
 * Standardized error codes for agent protocol errors.
 *
 * These map to specific failure modes in the yield/resume cycle:
 *
 *   INVALID_STATE_TOKEN  — token is malformed, expired, or tampered
 *   RATE_LIMITED         — LLM provider rate limit hit
 *   MAX_ITERATIONS       — agent hit iteration limit without completing
 *   TOOL_EXECUTION_ERROR — a platform tool failed during server-side execution
 *   INTERNAL_ERROR       — unexpected server error
 */
export type AgentErrorCode =
  | "INVALID_STATE_TOKEN"
  | "RATE_LIMITED"
  | "MAX_ITERATIONS"
  | "TOOL_EXECUTION_ERROR"
  | "INTERNAL_ERROR";

/**
 * Union of all possible server responses.
 *
 * The caller switches on `type`:
 *   "tool_calls" → resolve tools, send AgentResumeRequest
 *   "message"    → display to user, exchange complete
 *   "error"      → handle error, retry if applicable
 */
export type AgentProtocolResponse<M = Record<string, unknown>> =
  | AgentYieldResponse
  | AgentCompleteResponse<M>
  | AgentErrorResponse;

// ─── Type Guards ───────────────────────────────────────────────

/** Check if a request is a start (new exchange) or resume */
export function isStartRequest(req: AgentRequest): req is AgentStartRequest {
  return "messages" in req;
}

/** Check if a request is a resume (continuing a yield) */
export function isResumeRequest(req: AgentRequest): req is AgentResumeRequest {
  return "stateToken" in req;
}
