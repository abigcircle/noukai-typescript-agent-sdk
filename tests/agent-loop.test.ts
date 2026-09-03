import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop";
import type { ToolCall, ToolResult } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_data",
    description: "Get data",
    parameters: { type: "object" as const, properties: {}, required: [] },
  },
];

/** Create a mock fetch that returns a sequence of responses */
function mockFetch(responses: Array<Record<string, unknown>>) {
  let callIndex = 0;
  const fn = vi.fn(async () => {
    const data = responses[callIndex++];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => data,
    } as Response;
  });
  return fn;
}

/** Simple sync resolver */
function simpleResolver(call: ToolCall): ToolResult {
  return { toolCallId: call.id, result: `resolved:${call.name}` };
}

// ─── Tests ────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  it("returns a final message on completed status", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "Hello!", flowId: "f1", blockCount: 1 },
    ]);

    const result = await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch,
    });

    expect(result).toEqual({
      type: "message",
      content: "Hello!",
    });

    // Verify fresh request shape
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/agent");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.message).toBe("Hi");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("get_data");
  });

  it("extracts content and metadata from the flow result shape", async () => {
    const flowResult = {
      type: "message",
      content: "Done!",
      metadata: { operations: [{ op: "create_block" }] },
    };
    const fetch = mockFetch([
      { status: "completed", result: flowResult, flowId: "f1", blockCount: 1 },
    ]);

    const result = await runAgentLoop("Do something", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch,
    });

    expect(result).toEqual({
      type: "message",
      content: "Done!",
      metadata: flowResult,
    });
  });

  it("unwraps the chat-flow result shape ({message}) instead of stringifying it", async () => {
    const flowResult = { message: "# こんにちは！" };
    const fetch = mockFetch([
      { status: "completed", result: flowResult, flowId: "f1", blockCount: 1 },
    ]);

    const result = await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: [],
      resolveToolCall: simpleResolver,
      fetch,
    });

    expect(result).toEqual({
      type: "message",
      content: "# こんにちは！",
      metadata: flowResult,
    });
  });

  it("resolves tool calls then continues the loop", async () => {
    const fetch = mockFetch([
      // Backend pauses with tool calls
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [
          { role: "user", content: "Get data" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "get_data", arguments: '{"key":"value"}' },
              },
            ],
          },
        ],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: '{"key":"value"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      // Backend completes after resume
      { status: "completed", result: "Got the data!", flowId: "f1", blockCount: 1 },
    ]);

    const resolver = vi.fn(simpleResolver);

    const result = await runAgentLoop("Get data", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: resolver,
      fetch,
    });

    expect(result).toEqual({ type: "message", content: "Got the data!" });

    // Resolver was called with parsed arguments
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith({
      id: "tc-1",
      name: "get_data",
      arguments: { key: "value" },
    });

    // Fetch called twice (fresh → resume)
    expect(fetch).toHaveBeenCalledTimes(2);

    // Verify resume request shape
    const resumeBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(resumeBody.executionId).toBe("exec-1");
    expect(resumeBody.pausedAtStep).toBe("step-1");
    expect(resumeBody.iterationsUsed).toBe(1);
    // Should have original messages + our tool result appended
    expect(resumeBody.toolCallMessages).toHaveLength(3);
    expect(resumeBody.toolCallMessages[2]).toEqual({
      role: "tool",
      tool_call_id: "tc-1",
      content: "resolved:get_data",
    });
    // Tools are resent on resume
    expect(resumeBody.tools).toHaveLength(1);
  });

  it("resolves multiple tool calls in a single pause", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: '{"k":"a"}' },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "get_data", arguments: '{"k":"b"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "All done", flowId: "f1", blockCount: 1 },
    ]);

    const resolver = vi.fn(simpleResolver);
    await runAgentLoop("Get both", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: resolver,
      fetch,
    });

    expect(resolver).toHaveBeenCalledTimes(2);

    // Resume should have 2 tool result messages appended
    const resumeBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(resumeBody.toolCallMessages).toHaveLength(2);
    expect(resumeBody.toolCallMessages[0].tool_call_id).toBe("tc-1");
    expect(resumeBody.toolCallMessages[1].tool_call_id).toBe("tc-2");
  });

  it("handles multiple rounds of tool calls", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: '{"k":"a"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 2,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-2",
            type: "function",
            function: { name: "get_data", arguments: '{"k":"b"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "After two rounds", flowId: "f1", blockCount: 1 },
    ]);

    const resolver = vi.fn(simpleResolver);
    const result = await runAgentLoop("Go", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: resolver,
      fetch,
    });

    expect(result).toEqual({ type: "message", content: "After two rounds" });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns max_iterations when limit is reached", async () => {
    const makePause = (i: number) => ({
      status: "tool_calls_required",
      executionId: "exec-1",
      pausedAtStep: "step-1",
      iterationsUsed: i + 1,
      toolCallMessages: [],
      toolCalls: [
        {
          id: `tc-${i}`,
          type: "function",
          function: { name: "get_data", arguments: `{"i":${i}}` },
        },
      ],
      accumulatedOutputs: {},
      flowId: "f1",
      blockCount: 1,
    });

    const fetch = mockFetch([makePause(0), makePause(1), makePause(2)]);

    const result = await runAgentLoop("Go", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      maxIterations: 3,
      fetch,
    });

    expect(result).toEqual({ type: "max_iterations" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("throws on non-ok HTTP response", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ detail: { message: "Server error" } }),
    })) as unknown as typeof globalThis.fetch;

    await expect(
      runAgentLoop("Hi", {
        endpoint: "/api/agent",
        tools: TOOLS,
        resolveToolCall: simpleResolver,
        fetch,
      }),
    ).rejects.toThrow("Server error");
  });

  it("throws on non-ok HTTP response without detail", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;

    await expect(
      runAgentLoop("Hi", {
        endpoint: "/api/agent",
        tools: TOOLS,
        resolveToolCall: simpleResolver,
        fetch,
      }),
    ).rejects.toThrow("API error: 500 Internal Server Error");
  });

  it("supports async resolvers", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: '{"q":"test"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "Done", flowId: "f1", blockCount: 1 },
    ]);

    const asyncResolver = async (call: ToolCall): Promise<ToolResult> => {
      await new Promise((r) => setTimeout(r, 5));
      return { toolCallId: call.id, result: `async:${call.arguments.q}` };
    };

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: asyncResolver,
      fetch,
    });

    const resumeBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(resumeBody.toolCallMessages[0].content).toBe("async:test");
  });

  it("sends parameters on the fresh request", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "Hello", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      parameters: { conversation: [{ role: "user", content: "prior" }] },
      fetch,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.parameters).toEqual({
      conversation: [{ role: "user", content: "prior" }],
    });
  });

  it("does not send parameters on resume requests", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: "{}" },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "Done", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      parameters: { conversation: [] },
      fetch,
    });

    // Resume request should NOT have parameters
    const resumeBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(resumeBody.parameters).toBeUndefined();
    expect(resumeBody.executionId).toBe("exec-1");
  });

  it("passes AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const fetch = mockFetch([
      { status: "completed", result: "Hello", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      signal: controller.signal,
      fetch,
    });

    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("defaults to 12 max iterations", async () => {
    const responses = Array.from({ length: 12 }, (_, i) => ({
      status: "tool_calls_required",
      executionId: "exec-1",
      pausedAtStep: "step-1",
      iterationsUsed: i + 1,
      toolCallMessages: [],
      toolCalls: [
        {
          id: `tc-${i}`,
          type: "function",
          function: { name: "get_data", arguments: `{"i":${i}}` },
        },
      ],
      accumulatedOutputs: {},
      flowId: "f1",
      blockCount: 1,
    }));
    const fetch = mockFetch(responses);

    const result = await runAgentLoop("Go", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch,
    });

    expect(result).toEqual({ type: "max_iterations" });
    expect(fetch).toHaveBeenCalledTimes(12);
  });

  it("deduplicates repeated tool calls with identical args", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: '{"key":"x"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      {
        // LLM repeats the exact same tool call
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 2,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-2",
            type: "function",
            function: { name: "get_data", arguments: '{"key":"x"}' },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "Done", flowId: "f1", blockCount: 1 },
    ]);

    const resolver = vi.fn(simpleResolver);
    const onToolCallStart = vi.fn();

    await runAgentLoop("Go", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: resolver,
      fetch,
      onToolCallStart,
    });

    // Resolver should only be called once — the second call is a cache hit
    expect(resolver).toHaveBeenCalledOnce();
    // onToolCallStart should only fire for the first (fresh) call
    expect(onToolCallStart).toHaveBeenCalledOnce();
  });

  it("handles malformed tool call arguments gracefully", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-1",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: "not valid json{" },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "Recovered", flowId: "f1", blockCount: 1 },
    ]);

    const resolver = vi.fn(simpleResolver);
    await runAgentLoop("Go", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: resolver,
      fetch,
    });

    // Resolver should be called with _parseError
    expect(resolver).toHaveBeenCalledWith({
      id: "tc-1",
      name: "get_data",
      arguments: { _parseError: "not valid json{" },
    });
  });

  it("sends toolChoice when provided", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "Hello", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      toolChoice: "required",
      fetch,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.toolChoice).toBe("required");
  });

  it("omits toolChoice when not provided", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "Hello", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.toolChoice).toBeUndefined();
  });

  // ── Structured messages mode (chat flows) ─────────────────

  it("sends top-level `messages` and omits `message`/`parameters` in messages mode", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "Hi back", flowId: "f1", blockCount: 1 },
    ]);

    const conversation = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ];

    await runAgentLoop("", {
      endpoint: "/api/ai/acme/proj/chat/execute",
      tools: [],
      resolveToolCall: simpleResolver,
      messages: conversation,
      // parameters must be IGNORED when messages mode is active
      parameters: { conversation: [{ role: "user", content: "SHOULD-NOT-SEND" }] },
      fetch,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.messages).toEqual(conversation);
    expect(body.message).toBeUndefined();
    expect(body.parameters).toBeUndefined();
    expect(body.tools).toEqual([]);
  });

  it("still forwards toolChoice in messages mode", async () => {
    const fetch = mockFetch([
      { status: "completed", result: "ok", flowId: "f1", blockCount: 1 },
    ]);

    await runAgentLoop("", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "required",
      fetch,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.toolChoice).toBe("required");
  });

  it("resumes a tool-call pause identically in messages mode (chat + client tools)", async () => {
    const fetch = mockFetch([
      {
        status: "tool_calls_required",
        executionId: "exec-9",
        pausedAtStep: "step-1",
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_data", arguments: "{}" },
          },
        ],
        accumulatedOutputs: {},
        flowId: "f1",
        blockCount: 1,
      },
      { status: "completed", result: "resolved via tools", flowId: "f1", blockCount: 1 },
    ]);

    const result = await runAgentLoop("", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      messages: [{ role: "user", content: "use a tool" }],
      fetch,
    });

    expect(result).toEqual({ type: "message", content: "resolved via tools" });
    // Fresh call is messages-shaped; resume is the standard echo-back shape.
    const freshBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(freshBody.messages).toHaveLength(1);
    const resumeBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(resumeBody.executionId).toBe("exec-9");
    expect(resumeBody.messages).toBeUndefined();
  });
});
