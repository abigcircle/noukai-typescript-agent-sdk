import { describe, it, expect } from "vitest";
import {
  toWireToolDef,
  toWireToolDefs,
  parseWireToolCall,
  toWireToolResult,
} from "../src/wire-adapters";

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
  it("produces wire-format tool result with snake_case tool_call_id", () => {
    const result = toWireToolResult("call_123", '{"temp":14}');

    expect(result).toEqual({
      role: "tool",
      tool_call_id: "call_123",
      content: '{"temp":14}',
    });
  });
});
