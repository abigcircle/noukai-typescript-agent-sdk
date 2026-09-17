import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  SpanKind,
  SpanStatusCode,
  propagation,
  trace,
  type Context,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";

import { runAgentLoop } from "../src/agent-loop";
import type { ToolCall, ToolResult } from "../src/types";

/**
 * Opt-in client-side OpenTelemetry for the agent loop.
 * Verifies the `invoke_agent` turn span, `noukai.agent.round` + `execute_tool`
 * children, termination attributes, `traceparent` injection on the outbound POST,
 * the PII-gated tool payloads, and the true no-op-when-off path.
 */

// A minimal W3C-shaped propagator so `propagation.inject` (used by the round
// wrapper) emits a real `traceparent` in the unit test without pulling in
// @opentelemetry/core. Emulates only what the assertions need.
class TestPropagator implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(context);
    if (!sc) return;
    setter.set(carrier, "traceparent", `00-${sc.traceId}-${sc.spanId}-01`);
  }
  extract(context: Context): Context {
    return context;
  }
  fields(): string[] {
    return ["traceparent"];
  }
}

propagation.setGlobalPropagator(new TestPropagator());

const TOOLS = [
  {
    name: "get_data",
    description: "Get data",
    parameters: { type: "object" as const, properties: {}, required: [] },
  },
];

function simpleResolver(call: ToolCall): ToolResult {
  return { toolCallId: call.id, result: `resolved:${call.name}` };
}

/** A completed relay response. */
function completed(result: unknown): Record<string, unknown> {
  return { status: "completed", result, flowId: "f1", blockCount: 1, executionId: "exec-1" };
}

/** A pause-for-tools relay response (round-trips once per fetch). */
function paused(tool: { id: string; name: string }): Record<string, unknown> {
  const call = {
    id: tool.id,
    type: "function",
    function: { name: tool.name, arguments: "{}" },
  };
  return {
    status: "tool_calls_required",
    executionId: "exec-1",
    pausedAtStep: "step-1",
    iterationsUsed: 1,
    toolCallMessages: [{ role: "assistant", content: null, toolCalls: [call] }],
    toolCalls: [call],
    accumulatedOutputs: {},
    flowId: "f1",
  };
}

interface RecordedCall {
  headers: Headers;
}

/** A mock fetch that records each call's headers and returns a sequence of
 *  responses (clamped to the last when exhausted). */
function recordingFetch(responses: Array<Record<string, unknown>>) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers) });
    const data = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => JSON.parse(JSON.stringify(data)),
    } as Response;
  });
  return { fn, calls };
}

let exporter: InMemorySpanExporter;
let tracer: ReturnType<BasicTracerProvider["getTracer"]>;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  tracer = provider.getTracer("test");
});

const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
const parentIdOf = (s: ReadableSpan): string | undefined =>
  (s as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
    .parentSpanContext?.spanId ??
  (s as unknown as { parentSpanId?: string }).parentSpanId;

describe("runAgentLoop OTel (opt-in)", () => {
  it("emits one invoke_agent turn span on a completed loop", async () => {
    const { fn } = recordingFetch([completed("Hi there")]);

    const result = await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      otel: true,
      tracer,
    });

    expect(result).toEqual({ type: "message", content: "Hi there" });

    const turn = spans().find((s) => s.name === "invoke_agent")!;
    expect(turn).toBeDefined();
    expect(turn.kind).toBe(SpanKind.INTERNAL);
    expect(turn.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(turn.attributes["noukai.agent.tools"]).toEqual(["get_data"]);
    expect(turn.attributes["noukai.agent.request_mode"]).toBe("message");
    expect(turn.attributes["noukai.agent.max_rounds"]).toBe(10);
    expect(turn.attributes["noukai.agent.termination"]).toBe("completed");
    expect(turn.attributes["noukai.agent.rounds"]).toBe(1);
    expect(turn.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("emits a CLIENT round span per relay POST and injects traceparent", async () => {
    const { fn, calls } = recordingFetch([paused({ id: "tc-1", name: "get_data" }), completed("done")]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      otel: true,
      tracer,
    });

    const rounds = spans().filter((s) => s.name === "noukai.agent.round");
    // Two round-trips: fresh (pause) + resume (complete).
    expect(rounds).toHaveLength(2);
    for (const r of rounds) {
      expect(r.kind).toBe(SpanKind.CLIENT);
      expect(r.attributes["http.response.status_code"]).toBe(200);
    }

    // Each POST carries a traceparent, and the first one's spanId matches the
    // first round span — proving the ROUND span's context is what's injected
    // (so a downstream relay nests under the right span).
    const tp0 = calls[0].headers.get("traceparent");
    expect(tp0).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const round0 = rounds.find(
      (r) => r.attributes["noukai.agent.round_index"] === 1,
    )!;
    expect(tp0).toContain(round0.spanContext().spanId);

    // Rounds are children of the turn span, sharing its trace.
    const turn = spans().find((s) => s.name === "invoke_agent")!;
    for (const r of rounds) {
      expect(parentIdOf(r)).toBe(turn.spanContext().spanId);
      expect(r.spanContext().traceId).toBe(turn.spanContext().traceId);
    }
  });

  it("emits an execute_tool span nested under the turn for each resolution", async () => {
    const { fn } = recordingFetch([paused({ id: "tc-1", name: "get_data" }), completed("done")]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      otel: true,
      tracer,
    });

    const turn = spans().find((s) => s.name === "invoke_agent")!;
    const tool = spans().find((s) => s.name === "execute_tool get_data")!;
    expect(tool).toBeDefined();
    expect(tool.kind).toBe(SpanKind.INTERNAL);
    expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(tool.attributes["gen_ai.tool.name"]).toBe("get_data");
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("tc-1");
    expect(tool.attributes["noukai.tool.cache_hit"]).toBe(false);
    // No payloads by default (PII-safe).
    expect(tool.attributes["noukai.tool.arguments"]).toBeUndefined();
    expect(tool.attributes["noukai.tool.result"]).toBeUndefined();
    expect(parentIdOf(tool)).toBe(turn.spanContext().spanId);
  });

  it("attaches bounded arguments/result when toolPayloads is on", async () => {
    const { fn } = recordingFetch([paused({ id: "tc-1", name: "get_data" }), completed("done")]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      otel: true,
      tracer,
      toolPayloads: true,
    });

    const tool = spans().find((s) => s.name === "execute_tool get_data")!;
    expect(tool.attributes["noukai.tool.arguments"]).toBe("{}");
    expect(tool.attributes["noukai.tool.result"]).toBe("resolved:get_data");
  });

  it("marks termination max_iterations when the round limit is hit", async () => {
    // Always pauses → the SDK loop exceeds maxToolRounds and throws
    // ToolCallLimitError, which the loop maps to the max_iterations sentinel.
    const { fn } = recordingFetch([paused({ id: "tc-1", name: "get_data" })]);

    const result = await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      maxIterations: 1,
      otel: true,
      tracer,
    });

    expect(result).toEqual({ type: "max_iterations" });
    const turn = spans().find((s) => s.name === "invoke_agent")!;
    expect(turn.attributes["noukai.agent.termination"]).toBe("max_iterations");
  });

  it("marks termination error and records the exception on a failed flow", async () => {
    const { fn } = recordingFetch([
      { status: "failed", result: { detail: "boom" }, flowId: "f1", blockCount: 1 },
    ]);

    await expect(
      runAgentLoop("Hi", {
        endpoint: "/api/agent",
        tools: TOOLS,
        resolveToolCall: simpleResolver,
        fetch: fn,
        otel: true,
        tracer,
      }),
    ).rejects.toThrow();

    const turn = spans().find((s) => s.name === "invoke_agent")!;
    expect(turn.attributes["noukai.agent.termination"]).toBe("error");
    expect(turn.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("is a true no-op when otel is off: no spans, no traceparent", async () => {
    const { fn, calls } = recordingFetch([completed("Hi there")]);

    await runAgentLoop("Hi", {
      endpoint: "/api/agent",
      tools: TOOLS,
      resolveToolCall: simpleResolver,
      fetch: fn,
      // otel omitted
    });

    expect(spans()).toHaveLength(0);
    expect(calls[0].headers.get("traceparent")).toBeNull();
  });
});
