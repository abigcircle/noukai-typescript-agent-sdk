/**
 * @noukai/agent — Generic Agent Framework
 *
 * Provides the yield/resume tool-calling protocol for building AI agents.
 * Domain-agnostic — consumers bring their own tools and resolvers.
 *
 * Key exports:
 *   - Types: ToolDefinition, ToolCall, ToolResult, AgentResponse, AgentTurn
 *   - Hook: useAgentChat — manages the tool-calling loop
 *   - Registry: createToolRegistry — declarative tool registration
 *
 * @example
 *   import { useAgentChat, createToolRegistry } from "@noukai/agent";
 *
 *   const registry = createToolRegistry();
 *   registry.register({ definition: myTool, resolve: myResolver });
 *
 *   const agent = useAgentChat({
 *     endpoint: "/api/my-agent",
 *     tools: registry.definitions(),
 *     resolveToolCall: (call) => registry.resolve(call),
 *   });
 */

// ─── Types ────────────────────────────────────────────────────
export type {
  ToolParameterSchema,
  ToolPropertySchema,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentResponse,
  AgentTurn,
  AgentMessage,
  ToolResolver,
  AgentChatOptions,
  AgentChatReturn,
} from "./types.js";

// ─── Agent Loop (pure async, no React) ───────────────────────
export { runAgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions, AgentLoopResult } from "./agent-loop.js";

// ─── Hook (React) ─────────────────────────────────────────────
export { useAgentChat } from "./use-agent-chat.js";

// ─── Background (detached) turns ──────────────────────────────
// Turns that keep running after the active sessionId moves away (opt-in via
// `useAgentChat({ backgroundTurns: true })`). The hook is the primary surface;
// these helpers are the minimal committed public seam:
//   - observe which sessions have a live turn (for a tab strip rendered outside
//     the chat hook), and
//   - abort every in-flight turn on a hard teardown (logout).
// The turn manager itself stays internal so its shape can evolve.
export { subscribeBackgroundSessions, abortAllTurns } from "./turn-manager.js";
export type { LiveTurn, LiveTurnStatus } from "./turn-manager.js";
export { useBackgroundSessions } from "./use-background-sessions.js";

// ─── Registry ─────────────────────────────────────────────────
export { createToolRegistry } from "./tool-registry.js";
export type { ToolEntry, ToolRegistry } from "./tool-registry.js";

// ─── Tool Label Formatter ─────────────────────────────────────
export { ToolLabelFormatter } from "./tool-label-formatter.js";
export type { VerbLabels, ToolCallContextResolver } from "./tool-label-formatter.js";

// ─── Stateless Protocol (wire types for yield/resume) ─────────
export { isStartRequest, isResumeRequest } from "./protocol.js";
export type {
  AgentStartRequest,
  AgentResumeRequest,
  AgentRequest,
  AgentYieldResponse,
  AgentCompleteResponse,
  AgentErrorResponse,
  AgentErrorCode,
  AgentProtocolResponse,
} from "./protocol.js";

// ─── Wire Adapters (LLM wire format conversions) ─────────────
export {
  toWireToolDef,
  toWireToolDefs,
  toWireToolCall,
  parseWireToolCall,
  toWireToolResult,
  toChatMessages,
} from "./wire-adapters.js";
export type {
  WireToolDef,
  WireToolCall,
  WireToolResult,
} from "./wire-adapters.js";

// ─── Session Store (optional chat persistence) ────────────────
export { MemorySessionStore } from "./session-store.js";
export type {
  ChatSession,
  ChatSessionStore,
  ChatSessionSummary,
} from "./session-store.js";
