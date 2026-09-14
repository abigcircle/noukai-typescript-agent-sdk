import { describe, it, expect } from "vitest";
import {
  toWireToolDef,
  toWireToolDefs,
  toWireToolCall,
  parseWireToolCall,
  toWireToolResult,
  toChatMessages,
} from "../src/wire-adapters";
import type { AgentTurn } from "../src/types";

describe("toWireToolDef", () => {
  it("wraps a ToolDefinition in the wire envelope", () => {
    const def = {
      name: "get_weather",
      description: "Get current weather",
      parameters: {
        type: "object" as const,
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    };

    expect(toWireToolDef(def)).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string", description: "City name" } },
          required: ["city"],
        },
      },
    });
  });
});

describe("toWireToolDefs", () => {
  it("wraps multiple definitions", () => {
    const defs = [
      { name: "a", description: "A", parameters: { type: "object" as const, properties: {} } },
      { name: "b", description: "B", parameters: { type: "object" as const, properties: {} } },
    ];
    const result = toWireToolDefs(defs);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("a");
    expect(result[1].function.name).toBe("b");
  });
});

describe("parseWireToolCall", () => {
  it("parses valid JSON arguments", () => {
    const raw = {
      id: "call_123",
      type: "function" as const,
      function: {
        name: "get_weather",
        arguments: '{"city":"Paris","units":"metric"}',
      },
    };

    expect(parseWireToolCall(raw)).toEqual({
      id: "call_123",
      name: "get_weather",
      arguments: { city: "Paris", units: "metric" },
    });
  });

  it("handles empty object arguments", () => {
    const raw = {
      id: "call_456",
      type: "function" as const,
      function: { name: "get_overview", arguments: "{}" },
    };

    expect(parseWireToolCall(raw)).toEqual({
      id: "call_456",
      name: "get_overview",
      arguments: {},
    });
  });

  it("handles malformed JSON by setting _parseError", () => {
    const raw = {
      id: "call_789",
      type: "function" as const,
      function: { name: "get_data", arguments: "not json{" },
    };

    const result = parseWireToolCall(raw);
    expect(result.id).toBe("call_789");
    expect(result.name).toBe("get_data");
    expect(result.arguments).toEqual({ _parseError: "not json{" });
  });

  it("handles empty string arguments", () => {
    const raw = {
      id: "call_000",
      type: "function" as const,
      function: { name: "get_data", arguments: "" },
    };

    const result = parseWireToolCall(raw);
    expect(result.arguments).toEqual({ _parseError: "" });
  });
});

describe("toWireToolResult", () => {
  it("produces wire-format tool result with camelCase toolCallId", () => {
    const result = toWireToolResult("call_123", '{"temp":14}');

    expect(result).toEqual({
      role: "tool",
      toolCallId: "call_123",
      content: '{"temp":14}',
    });
  });
});

describe("toChatMessages", () => {
  it("maps text turns straight through (camelCase, no cast)", () => {
    const turns: AgentTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toChatMessages(turns)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("serializes an assistant tool-call turn to the wire envelope (object args → JSON string)", () => {
    const turns: AgentTurn[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc-1", name: "get_data", arguments: { k: "v" } }],
      },
    ];
    expect(toChatMessages(turns)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "tc-1", type: "function", function: { name: "get_data", arguments: '{"k":"v"}' } },
        ],
      },
    ]);
  });

  it("maps a tool result turn with camelCase toolCallId", () => {
    const turns: AgentTurn[] = [{ role: "tool", toolCallId: "tc-1", content: "ok" }];
    expect(toChatMessages(turns)).toEqual([{ role: "tool", toolCallId: "tc-1", content: "ok" }]);
  });
});

describe("toWireToolCall", () => {
  it("serializes an internal ToolCall to the nested function envelope", () => {
    expect(toWireToolCall({ id: "c1", name: "lookup", arguments: { q: "x" } })).toEqual({
      id: "c1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
  });
});
