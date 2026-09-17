/**
 * Optional, opt-in OpenTelemetry integration for the client-side agent loop.
 *
 * When `runAgentLoop` is called with `otel: true`, each loop emits ONE parent
 * span of kind INTERNAL — `invoke_agent` — into the caller's own OpenTelemetry
 * provider, with two kinds of child span:
 *
 *   - `noukai.agent.round` (kind CLIENT) — one per relay round-trip. Emitted by
 *     wrapping the loop's `fetch`; it also **injects a W3C `traceparent`** header
 *     on the outbound POST so a downstream (OTel-instrumented) relay continues
 *     the SAME trace — this is what makes the browser↔relay trace unified.
 *   - `execute_tool {name}` (kind INTERNAL) — one per local tool resolution. This
 *     is the only place the client-side tool execution is observable: the server
 *     never sees how long `resolveToolCall` ran or whether it threw.
 *
 * With `toolPayloads: true` each tool span additionally carries a size-bounded
 * copy of the call arguments and result string (off by default — this can
 * contain PII), mirroring the base SDK's `otelStepPayloads`.
 *
 * When `otel` is falsy (the default) this module hands back a no-op factory that
 * never imports `@opentelemetry/api`; the off path emits nothing and adds only a
 * couple of trivial allocations per loop.
 *
 * `@opentelemetry/api` is an optional peer dependency, imported dynamically and
 * only when otel is on. Because ESM dynamic import is async, it is resolved
 * lazily on the first traced loop; a missing dependency then surfaces as a clear
 * {@link NoukaiError} there.
 *
 * This module is the package's ONLY point of contact with `@opentelemetry/api`;
 * the rest of the package talks to the language-neutral {@link AgentSpanFactory}
 * / {@link TurnSpan}. Follows OTel semantic conventions: span kind INTERNAL for
 * the agent invocation and each tool execution, CLIENT for each relay round-trip,
 * and `gen_ai.*` for the tool name / call id.
 */

import type * as OtelApi from "@opentelemetry/api";

import { NoukaiError } from "@noukai/sdk";

// Cap the serialized size of a tool argument/result payload attribute so a large
// tool context can't blow past OTel backends' attribute-size limits. Mirrors the
// base SDK's `MAX_STEP_PAYLOAD_CHARS`.
const MAX_TOOL_PAYLOAD_CHARS = 4096;

const TRACER_NAME = "@noukai/agent";

/** Attributes known when the turn (loop) starts. */
export interface TurnAttrs {
  /** Names of the tools offered to the model this loop. */
  tools: string[];
  /** Fresh-call request shape: single `message` vs structured `messages`. */
  mode: "message" | "messages";
  /** The client round limit for this loop. */
  maxRounds: number;
  /** Originating session id (background/multi-tab turns), if any. */
  sessionId?: string;
}

/** The minimal tool-call shape a span needs. */
export interface ToolSpanInput {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** How the loop ended — set on the turn span at the end. */
export type TerminationReason = "completed" | "max_iterations" | "error";

/** Language-neutral handle the loop drives the turn's spans through. */
export interface TurnSpan {
  /**
   * Wrap the loop's `fetch` so each relay round-trip becomes a CLIENT child span
   * and carries an injected `traceparent`/`tracestate`. The no-op turn returns
   * `fetchFn` unchanged (so the off path is byte-for-byte the original).
   */
  wrapFetch(fetchFn: typeof fetch | undefined): typeof fetch | undefined;
  /** Run a local tool resolution inside a child span. `fn` resolves to the
   *  tool's result string, which (payloads on) is attached to the span. */
  toolSpan(call: ToolSpanInput, fn: () => Promise<string>): Promise<string>;
  /** Record a tool call served from the loop's dedup cache (no resolver ran). */
  recordCachedTool(call: ToolSpanInput): void;
  /** Set the loop's termination reason at the end; rounds are auto-counted. */
  setTermination(reason: TerminationReason): void;
}

/** Opens one parent `invoke_agent` span per loop, handing it a {@link TurnSpan}. */
export interface AgentSpanFactory {
  readonly enabled: boolean;
  turnSpan<T>(
    attrs: TurnAttrs,
    fn: (turn: TurnSpan) => Promise<T>,
    parentContext?: unknown,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Helpers (no @opentelemetry/api import)
// ---------------------------------------------------------------------------

/** Serialize to JSON, truncating to `maxChars` chars with a marker. */
function boundedJson(obj: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(obj) ?? String(obj);
  } catch {
    text = String(obj);
  }
  return boundedText(text, maxChars);
}

function boundedText(text: string, maxChars: number): string {
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}…[truncated ${String(text.length - maxChars)} chars]`;
  }
  return text;
}

/** Merge an injected header carrier onto a request's existing headers. Accepts
 *  every `HeadersInit` shape the SDK transport might pass. */
function mergeHeaders(
  existing: HeadersInit | undefined,
  carrier: Record<string, string>,
): Headers {
  const headers = new Headers(existing);
  for (const [k, v] of Object.entries(carrier)) headers.set(k, v);
  return headers;
}

// ---------------------------------------------------------------------------
// No-op (default; never imports @opentelemetry/api)
// ---------------------------------------------------------------------------

const NOOP_TURN: TurnSpan = {
  wrapFetch(fetchFn) {
    return fetchFn;
  },
  toolSpan(_call, fn) {
    return fn();
  },
  recordCachedTool() {
    /* no-op */
  },
  setTermination() {
    /* no-op */
  },
};

export class NoopAgentSpanFactory implements AgentSpanFactory {
  readonly enabled = false;

  turnSpan<T>(_attrs: TurnAttrs, fn: (turn: TurnSpan) => Promise<T>): Promise<T> {
    return fn(NOOP_TURN);
  }
}

// ---------------------------------------------------------------------------
// Real implementation (only reached when otel is enabled)
// ---------------------------------------------------------------------------

class OtelTurnSpan implements TurnSpan {
  /** Relay round-trips this loop made — the wrapped fetch increments it. */
  private rounds = 0;

  constructor(
    private readonly span: OtelApi.Span,
    private readonly api: typeof OtelApi,
    private readonly tracer: OtelApi.Tracer,
    /** A context with THIS turn span active — children are parented through it
     *  explicitly, so nesting is correct even with no registered ContextManager
     *  (the usual browser case). */
    private readonly turnContext: OtelApi.Context,
    private readonly clientKind: OtelApi.SpanKind,
    private readonly internalKind: OtelApi.SpanKind,
    private readonly errorCode: OtelApi.SpanStatusCode,
    private readonly payloads: boolean,
    private readonly maxChars: number,
  ) {}

  wrapFetch(fetchFn: typeof fetch | undefined): typeof fetch {
    const base = fetchFn ?? globalThis.fetch;
    // Arrow fn so `this` is captured lexically (no `this` alias).
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      this.rounds += 1;
      const round = this.tracer.startSpan(
        "noukai.agent.round",
        { kind: this.clientKind },
        this.turnContext,
      );
      round.setAttribute("noukai.agent.round_index", this.rounds);
      // Inject W3C trace context from the round span so an OTel-instrumented
      // relay continues the SAME trace (the browser↔relay join).
      const roundContext = this.api.trace.setSpan(this.turnContext, round);
      const carrier: Record<string, string> = {};
      this.api.propagation.inject(roundContext, carrier);
      const headers = mergeHeaders(init?.headers, carrier);
      try {
        const resp = await base(input, { ...init, headers });
        round.setAttribute("http.response.status_code", resp.status);
        if (resp.status >= 400) {
          round.setStatus({ code: this.errorCode, message: `HTTP ${String(resp.status)}` });
        }
        return resp;
      } catch (e) {
        round.recordException(e instanceof Error ? e : new Error(String(e)));
        round.setStatus({ code: this.errorCode, message: String(e) });
        throw e;
      } finally {
        round.end();
      }
    };
  }

  async toolSpan(call: ToolSpanInput, fn: () => Promise<string>): Promise<string> {
    const span = this.startToolSpan(call, false);
    if (this.payloads) {
      span.setAttribute("noukai.tool.arguments", boundedJson(call.arguments, this.maxChars));
    }
    try {
      const result = await fn();
      if (this.payloads) {
        span.setAttribute("noukai.tool.result", boundedText(result, this.maxChars));
      }
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({ code: this.errorCode, message: String(e) });
      throw e;
    } finally {
      span.end();
    }
  }

  recordCachedTool(call: ToolSpanInput): void {
    this.startToolSpan(call, true).end();
  }

  setTermination(reason: TerminationReason): void {
    this.span.setAttribute("noukai.agent.termination", reason);
    this.span.setAttribute("noukai.agent.rounds", this.rounds);
    if (reason === "error") this.span.setStatus({ code: this.errorCode });
  }

  private startToolSpan(call: ToolSpanInput, cacheHit: boolean): OtelApi.Span {
    const span = this.tracer.startSpan(
      `execute_tool ${call.name}`,
      { kind: this.internalKind },
      this.turnContext,
    );
    span.setAttribute("gen_ai.operation.name", "execute_tool");
    span.setAttribute("gen_ai.tool.name", call.name);
    span.setAttribute("gen_ai.tool.call.id", call.id);
    span.setAttribute("noukai.tool.cache_hit", cacheHit);
    return span;
  }
}

class OtelAgentSpanFactory implements AgentSpanFactory {
  readonly enabled = true;

  constructor(
    private readonly api: typeof OtelApi,
    private readonly tracer: OtelApi.Tracer,
    private readonly payloads: boolean,
  ) {}

  async turnSpan<T>(
    attrs: TurnAttrs,
    fn: (turn: TurnSpan) => Promise<T>,
    parentContext?: unknown,
  ): Promise<T> {
    const api = this.api;
    const parent = (parentContext as OtelApi.Context | undefined) ?? api.context.active();
    const span = this.tracer.startSpan("invoke_agent", { kind: api.SpanKind.INTERNAL }, parent);
    span.setAttribute("gen_ai.operation.name", "invoke_agent");
    span.setAttribute("noukai.agent.tools", attrs.tools);
    span.setAttribute("noukai.agent.request_mode", attrs.mode);
    span.setAttribute("noukai.agent.max_rounds", attrs.maxRounds);
    if (attrs.sessionId !== undefined) span.setAttribute("session.id", attrs.sessionId);

    const turnContext = api.trace.setSpan(parent, span);
    const turn = new OtelTurnSpan(
      span,
      api,
      this.tracer,
      turnContext,
      api.SpanKind.CLIENT,
      api.SpanKind.INTERNAL,
      api.SpanStatusCode.ERROR,
      this.payloads,
      MAX_TOOL_PAYLOAD_CHARS,
    );
    try {
      return await fn(turn);
    } catch (e) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(e) });
      span.setAttribute("noukai.agent.termination", "error");
      throw e;
    } finally {
      span.end();
    }
  }
}

/**
 * Wraps {@link OtelAgentSpanFactory}, resolving `@opentelemetry/api` on the first
 * traced loop (ESM dynamic import is async). Throws {@link NoukaiError} if the
 * peer dep is absent.
 */
class LazyAgentSpanFactory implements AgentSpanFactory {
  readonly enabled = true;
  private resolved: AgentSpanFactory | null = null;

  constructor(
    private readonly tracer: unknown,
    private readonly payloads: boolean,
  ) {}

  async turnSpan<T>(
    attrs: TurnAttrs,
    fn: (turn: TurnSpan) => Promise<T>,
    parentContext?: unknown,
  ): Promise<T> {
    this.resolved ??= await this.resolve();
    return this.resolved.turnSpan(attrs, fn, parentContext);
  }

  private async resolve(): Promise<AgentSpanFactory> {
    const api = await import("@opentelemetry/api").catch(() => {
      throw new NoukaiError(
        "runAgentLoop({ otel: true }) requires @opentelemetry/api. Install it " +
          "(`npm i @opentelemetry/api`) or pass an explicit `tracer`.",
      );
    });
    const tracer = (this.tracer as OtelApi.Tracer | undefined) ?? api.trace.getTracer(TRACER_NAME);
    return new OtelAgentSpanFactory(api, tracer, this.payloads);
  }
}

export interface AgentSpanFactoryOptions {
  /** Attach bounded tool arguments/result to each tool span (may contain PII). */
  toolPayloads?: boolean;
}

/**
 * Build the span factory for a loop. `enabled=false` → a {@link NoopAgentSpanFactory}
 * that never imports OpenTelemetry. `enabled=true` → a lazy factory that emits the
 * `invoke_agent` span (with round + tool children) into the caller's provider or
 * the explicit `tracer`.
 */
export function makeAgentSpanFactory(
  enabled: boolean,
  tracer?: unknown,
  opts: AgentSpanFactoryOptions = {},
): AgentSpanFactory {
  if (!enabled) return new NoopAgentSpanFactory();
  return new LazyAgentSpanFactory(tracer, opts.toolPayloads ?? false);
}
