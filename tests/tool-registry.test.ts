import { describe, it, expect } from "vitest";
import { createToolRegistry } from "../src/tool-registry";
import type { ToolDefinition } from "../src/types";

const testTool: ToolDefinition = {
  name: "get_user",
  description: "Get user details",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "The user ID" },
    },
    required: ["userId"],
  },
};

const anotherTool: ToolDefinition = {
  name: "get_orders",
  description: "Get user orders",
  parameters: {
    type: "object",
    properties: {},
  },
};

describe("createToolRegistry", () => {
  it("registers a tool and returns its definition", () => {
    const registry = createToolRegistry();
    registry.register({
      definition: testTool,
      resolve: () => "result",
    });

    expect(registry.definitions()).toEqual([testTool]);
  });

  it("returns definitions for all registered tools", () => {
    const registry = createToolRegistry();
    registry.register({ definition: testTool, resolve: () => "a" });
    registry.register({ definition: anotherTool, resolve: () => "b" });

    expect(registry.definitions()).toHaveLength(2);
    expect(registry.definitions().map((d) => d.name)).toEqual([
      "get_user",
      "get_orders",
    ]);
  });

  it("resolves a tool call with the registered resolver", () => {
    const registry = createToolRegistry();
    registry.register({
      definition: testTool,
      resolve: (args) => `User: ${args.userId}`,
    });

    const result = registry.resolve({
      id: "call-1",
      name: "get_user",
      arguments: { userId: "u123" },
    });

    expect(result).toEqual({
      toolCallId: "call-1",
      result: "User: u123",
    });
  });

  it("returns error result for unknown tool name", () => {
    const registry = createToolRegistry();

    const result = registry.resolve({
      id: "call-1",
      name: "nonexistent",
      arguments: {},
    });

    expect(result).toEqual({
      toolCallId: "call-1",
      result: 'Unknown tool: "nonexistent"',
    });
  });

  it("handles async resolvers", async () => {
    const registry = createToolRegistry();
    registry.register({
      definition: testTool,
      resolve: async (args) => {
        await new Promise((r) => setTimeout(r, 10));
        return `Async: ${args.userId}`;
      },
    });

    const result = await registry.resolve({
      id: "call-1",
      name: "get_user",
      arguments: { userId: "u456" },
    });

    expect(result).toEqual({
      toolCallId: "call-1",
      result: "Async: u456",
    });
  });

  it("overwrites a tool when registered with the same name", () => {
    const registry = createToolRegistry();
    registry.register({ definition: testTool, resolve: () => "first" });
    registry.register({ definition: testTool, resolve: () => "second" });

    expect(registry.definitions()).toHaveLength(1);

    const result = registry.resolve({
      id: "call-1",
      name: "get_user",
      arguments: {},
    });
    expect(result).toEqual({ toolCallId: "call-1", result: "second" });
  });

  it("returns empty array when no tools registered", () => {
    const registry = createToolRegistry();
    expect(registry.definitions()).toEqual([]);
  });
});
