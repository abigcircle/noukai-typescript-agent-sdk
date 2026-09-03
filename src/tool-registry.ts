/**
 * Tool Registry
 *
 * A declarative registry for mapping tool names to resolver functions.
 * Consumers register tools with their definitions and resolvers,
 * then pass the registry's `resolve` method into useAgentChat.
 *
 * @example
 *   const registry = createToolRegistry();
 *
 *   registry.register({
 *     definition: { name: "get_user", description: "...", parameters: { ... } },
 *     resolve: (args) => `User: ${db.getUser(args.userId)}`,
 *   });
 *
 *   const agent = useAgentChat({
 *     tools: registry.definitions(),
 *     resolveToolCall: (call) => registry.resolve(call),
 *   });
 */

import type { ToolCall, ToolDefinition, ToolResult } from "./types.js";

// ─── Types ────────────────────────────────────────────────────

/** A tool entry: definition (sent to LLM) + resolver (runs locally) */
export interface ToolEntry {
  /** The tool definition sent to the LLM */
  definition: ToolDefinition;
  /** Resolver function: receives parsed arguments, returns human-readable text */
  resolve: (args: Record<string, unknown>) => string | Promise<string>;
}

/** A registry of tools with their definitions and resolvers */
export interface ToolRegistry {
  /** Register a tool with its definition and resolver */
  register(entry: ToolEntry): void;
  /** Get all registered tool definitions (to send to the LLM) */
  definitions(): ToolDefinition[];
  /** Resolve a tool call. Returns a ToolResult with the resolver's output. */
  resolve(call: ToolCall): ToolResult | Promise<ToolResult>;
}

// ─── Implementation ───────────────────────────────────────────

/** Create a new tool registry */
export function createToolRegistry(): ToolRegistry {
  const entries = new Map<string, ToolEntry>();

  return {
    register(entry: ToolEntry): void {
      entries.set(entry.definition.name, entry);
    },

    definitions(): ToolDefinition[] {
      return Array.from(entries.values()).map((e) => e.definition);
    },

    resolve(call: ToolCall): ToolResult | Promise<ToolResult> {
      const entry = entries.get(call.name);
      if (!entry) {
        return {
          toolCallId: call.id,
          result: `Unknown tool: "${call.name}"`,
        };
      }

      const resultOrPromise = entry.resolve(call.arguments);

      // Handle both sync and async resolvers
      if (resultOrPromise instanceof Promise) {
        return resultOrPromise.then((result) => ({
          toolCallId: call.id,
          result,
        }));
      }

      return { toolCallId: call.id, result: resultOrPromise };
    },
  };
}
