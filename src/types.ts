/**
 * @noukai/agent — Generic Agent Protocol Types
 *
 * Defines the contract for the yield/resume tool-calling loop between
 * any caller (frontend, backend runner, mobile app) and the agent platform.
 *
 * These types are domain-agnostic. Application-specific concerns (like
 * pipeline operations) are passed via the generic metadata parameter.
 */

// ─── Tool Schema ──────────────────────────────────────────────

/** JSON Schema for a single tool parameter. Recursive so array `items` and
 *  nested object `properties` can be described. */
export interface ToolPropertySchema {
  type: string;
  description?: string;
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  enum?: readonly unknown[];
}

/** JSON Schema definition for a tool's parameters */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

/** A tool definition sent to the LLM */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ─── Tool Calls & Results ─────────────────────────────────────

/** A tool call request from the LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A resolved tool result to send back to the LLM */
export interface ToolResult {
  toolCallId: string;
  result: string;
}

// ─── Agent Response ───────────────────────────────────────────

/**
 * Response from the agent endpoint — either tool calls to resolve
 * or a final message.
 *
 * The `metadata` field is generic — each agent type passes its own
 * domain payload. For example, the pipeline agent passes operations.
 */
export type AgentResponse<M = Record<string, unknown>> =
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "message"; content: string; metadata?: M };

// ─── Conversation Turns ───────────────────────────────────────

/** A turn in the conversation sent to/from the LLM */
export type AgentTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; content: null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

// ─── Display Message ──────────────────────────────────────────

/** Minimal message for display. Consumer can map to their own UI type. */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "thinking";
  content: string;
  timestamp: number;
}

// ─── Hook Types ───────────────────────────────────────────────

/** Function that resolves a tool call locally. Can be sync or async. */
export type ToolResolver = (
  call: ToolCall,
) => ToolResult | Promise<ToolResult>;

/** Configuration for the useAgentChat hook */
export interface AgentChatOptions<M = Record<string, unknown>> {
  /** API endpoint to POST conversation turns to */
  endpoint: string;
  /** Tool definitions to send with each request */
  tools: ToolDefinition[];
  /** Function to resolve tool calls locally */
  resolveToolCall: ToolResolver;
  /** Max tool-calling loop iterations (default: 5) */
  maxIterations?: number;
  /** Formatter for tool-call progress labels. Pass a custom ToolLabelFormatter
   *  to control the verbs shown during tool resolution (e.g. whimsical labels).
   *  Defaults to a standard ToolLabelFormatter instance. */
  toolLabelFormatter?: import("./tool-label-formatter.js").ToolLabelFormatter;
  /** Extracts display context from a tool call (e.g. block name from blockId).
   *  The returned string is inserted into the progress label. */
  toolCallContext?: (call: ToolCall) => string | undefined;
  /** Called when the agent returns a final message with metadata */
  onMetadata?: (metadata: M | undefined) => void;
  /** Called when tool calls are about to be resolved — use for progress UI */
  onToolCallStart?: (toolCalls: ToolCall[]) => void;
  /**
   * Chat-flow mode. When true, each send passes the growing conversation as
   * structured top-level `messages` (role:user/role:assistant turns) instead of
   * the default `parameters.conversation` (flattened) path. Default false keeps
   * the existing behavior byte-identical.
   */
  sendStructuredMessages?: boolean;
}

/** Return value from the useAgentChat hook */
export interface AgentChatReturn {
  /** Messages for display */
  messages: AgentMessage[];
  /** Whether the agent is processing */
  isLoading: boolean;
  /** Send a user message */
  sendMessage: (content: string) => void;
  /** Abort the in-flight turn (e.g. user pressed Escape) so a new send is allowed. */
  stop: () => void;
  /** Clear conversation */
  clearChat: () => void;
  /** Full conversation history (for advanced use) */
  conversation: readonly AgentTurn[];
}
