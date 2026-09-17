# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> `@noukai/agent` is versioned **independently** of `@noukai/sdk` /
> `noukai-sdk`. It is not part of the two-SDK release-parity gate
> (`check_parity.py`); its version line starts fresh at `0.1.0`.

## [Unreleased]

## [0.3.1] — 2026-09-17

### Added

- **Opt-in OpenTelemetry for the agent loop (design `20260917-SDK-agent-otel`).**
  `runAgentLoop` / `useAgentChat` accept `otel: true` to emit client-side spans
  into your own OTel provider — the only place the browser-side loop and its
  **local tool executions** are observable (a server-side trace never sees how
  long `resolveToolCall` ran or whether it threw). Off by default and a **true
  no-op** when off (never imports `@opentelemetry/api`).
  - **Span tree.** One `invoke_agent` span (kind INTERNAL) per loop, carrying
    `noukai.agent.tools` (the tool list), `noukai.agent.request_mode`,
    `noukai.agent.max_rounds`, and — at the end — `noukai.agent.rounds` and
    `noukai.agent.termination` (`completed` | `max_iterations` | `error`). Two
    kinds of child: `noukai.agent.round` (kind CLIENT) per relay round-trip with
    `http.response.status_code`, and `execute_tool {name}` (kind INTERNAL) per
    local resolution with `gen_ai.tool.name` / `gen_ai.tool.call.id` and a
    `noukai.tool.cache_hit` flag for dedup-cache serves.
  - **Unified trace (browser↔relay).** Each relay POST is wrapped so a W3C
    `traceparent` is injected from the round span — an OTel-instrumented relay
    continues the SAME trace. Pair with the base SDK's relay `traceparent`
    forwarding to reach the Noukai ingress.
  - **`tracer?`** — pass an explicit OTel `Tracer` instead of the global
    provider's. **`otelContext?`** — an OTel `Context` to parent the turn span
    under (snapshotted at send for detached background turns, which run with no
    ambient context). **`toolPayloads?`** — opt in to bounded (4096-char)
    `noukai.tool.arguments` / `noukai.tool.result` attributes (may contain PII;
    off by default). **`sessionId`** is recorded as `session.id` on the span.
  - `@opentelemetry/api` is a new **optional** peer dependency — install it only
    if you turn `otel` on.

## [0.3.0] — 2026-09-14

### Added

- **Background (detached) turns for `useAgentChat` (opt-in; design
  `20260914-SDK-agent-background-turns`).** A turn started for a session can now
  keep running to completion even after the active `sessionId` moves away — so a
  consumer multiplexing many chat tabs through one `useAgentChat` instance
  (swapping `sessionId` to the active tab) no longer loses an in-flight turn on a
  tab switch. Enable with `useAgentChat({ sessionId, store, backgroundTurns: true })`
  (requires both `sessionId` and `store`). When you return to the session, its
  live/updated/completed state is shown from a still-attached live stream and/or
  the store.
  - **New module-level turn manager** (`src/turn-manager.ts`, React-free) owns a
    turn's execution — its own `AbortController`, a live record, and the store
    flush on completion — keyed by `(store identity, sessionId)`. Turns survive a
    hook unmount/remount (they live in module scope); a page reload keeps only
    what the store persisted, exactly as before. Browser + SSR safe: no top-level
    Node built-ins, no import side effects.
  - **`stop(sessionId?)`** — widened from `stop()`. With no argument it aborts the
    ACTIVE session's turn (unchanged); pass a `sessionId` to abort a specific
    backgrounded session's turn. **Switching sessions never aborts** in background
    mode — aborting is explicit.
  - **`backgroundSessions: readonly string[]`** on the hook return — sessionIds
    (for this store) with an in-flight background turn, for showing a spinner on
    backgrounded tabs.
  - **`onTurnError?(error, { sessionId })`** option — a backgrounded turn that
    fails surfaces the error on return (as an assistant error bubble, persisted)
    and, if provided, fires this callback in real time even while another session
    is active.
  - **Callback session context.** `onMetadata` and `onToolCallStart` now receive
    an optional `{ sessionId }` second argument, and `ToolResolver` an optional
    `{ sessionId }` ctx — so a single multiplexed resolver/handler can route a
    backgrounded turn's tool resolution and metadata to the RIGHT session's state
    instead of "whatever tab is focused". **Backward compatible** — code that
    ignores the extra argument is unaffected.
  - **New exports:** `subscribeBackgroundSessions` / `useBackgroundSessions`
    (observe live turns for a tab strip rendered outside the chat hook),
    `abortAllTurns` (hard teardown, e.g. logout), and the `LiveTurn` /
    `LiveTurnStatus` types. The turn manager itself stays internal.

### Changed

- **Drop-in / no behavior change with the flag off.** `backgroundTurns` defaults
  `false`; every existing path (inline `sendMessage`, abort-on-sessionId-change,
  abort-on-unmount, the save-gate) is byte-for-byte the prior behavior. The
  existing test suite is unchanged and green. Enabling the flag without a `store`
  is a no-op (a dev-mode warning is logged) and falls back to inline turns.
- **Persistence in background mode is owned by the turn manager** (it saves the
  finished `{ conversation, displayMessages }` once on completion). The hook's own
  save effect is inert while a background turn runs, avoiding a double-write.
- **No `@noukai/sdk` change required** — `createRelayFlow().execute({ signal })` is
  already a fire-and-await, abort-aware promise; detachment is entirely about
  where that promise is awaited and where its output lands, both inside
  `@noukai/agent`.

## [0.2.0] — 2026-09-14

### Changed

- **Rewired onto `@noukai/sdk` (the F1 kill; design `20260903-SDK-agent-relay`,
  PR-3).** `runAgentLoop` is now a thin adapter over the SDK's `createRelayFlow`
  — the yield/resume loop, the request/response models, and the round limit live
  in **one** place (the SDK) instead of being re-declared here. Deleted the
  hand-rolled loop and the local `PausedResponse`/`CompletedResponse` wire
  shapes. Added `@noukai/sdk` (`^0.4.0`) as a dependency.
- **Public surface is unchanged.** `runAgentLoop`, `useAgentChat`,
  `createToolRegistry`, `ToolLabelFormatter`, and the full type surface are
  identical. Both fresh-call modes (`message` / `messages`), local tool
  resolution, duplicate-call de-duplication, `onToolCallStart` progress hooks,
  and `extractResult` unwrapping are preserved. The two web-app consumers compile
  against the new surface unchanged (verified).
- **Wire contents are camelCase (design `20260903-SDK-agent-relay`, camelCase
  alignment).** The whole Noukai wire is now camelCase, matching the SDK and the
  router-ai-slugs execute API (snake_case now lives only at the external
  LLM-provider boundary). `toWireToolResult` emits `toolCallId` (was
  `tool_call_id`) and `WireToolResult.tool_call_id` is renamed to `toolCallId`.
  The dangerous `messages as unknown as ChatMessage[]` cast in `runAgentLoop` is
  replaced by a real `toChatMessages` converter that also serializes an assistant
  tool-call turn's object arguments into the wire's JSON-string envelope. New
  exports: `toChatMessages`, `toWireToolCall`. The `Wire*` types gained index
  signatures so they're structurally assignable to the SDK's
  `Record<string, unknown>` slots (removing the internal `as unknown` casts).
  Requires `@noukai/sdk` with the matching camelCase `ChatMessage`.

### Behavior deltas (intentional, from re-expressing over the SDK loop)

- **Client round limit: 10 (was 12).** Reconciled onto the SDK's
  `DEFAULT_MAX_TOOL_ROUNDS`. The counter is now "resume rounds" (1 fresh call +
  up to 10 resumes), matching the SDK, rather than "total `/execute` calls".
  `maxIterations` still overrides it. Reaching the limit still returns
  `{ type: "max_iterations" }` (the SDK throws `ToolCallLimitError` internally;
  `runAgentLoop` maps it back to the sentinel).
- **Errors are the SDK's typed `NoukaiError` subclasses** (e.g.
  `FlowExecutionError`, `InsufficientCreditsError`) instead of a plain `Error`.
  They are still `instanceof Error`, and for standard `{detail:{code,message}}`
  server bodies the `.message` is the server's `detail.message` (unchanged UX).
- **Resume requests carry the SDK's standard fields** (e.g. echoed
  `parameters`/`toolChoice`); the server ignores them on resume (it keys on
  `executionId` + `pausedAtStep` + `toolCallMessages`).

### Fixed

- **A failed execution now throws instead of being surfaced as a message.** When
  a flow completes with `status: "failed"` (HTTP 200), `runAgentLoop` throws a
  typed `FlowExecutionError`, restoring the pre-rewire contract. The rewire had
  dropped the status check, coercing a failed run into an (often empty)
  `{ type: "message" }` and silently masking the failure. (Regression caught in
  review.)

## [0.1.0] — 2026-09-03

### Added

- Initial standalone release. Promoted **verbatim** from the noutai monorepo
  (`development/sdk/agent`, previously `@noukai/agent@0.0.0`, `private`,
  consumed as raw TS source via `link:`) into its own releasable package.
  Runtime behavior is unchanged.
- Domain-agnostic yield/resume tool-calling loop:
  - `runAgentLoop(message | messages, options)` — the pure async loop (no React):
    fresh POST → `tool_calls_required` pause → resolve client-side → resume →
    `completed`.
  - `useAgentChat(options)` — thin React hook over the loop (conversation state,
    `isLoading`, abort, multi-turn history). React is an **optional** peer.
  - `createToolRegistry()` — declarative tool register/resolve.
  - `ToolLabelFormatter` — progress labels for in-flight tool calls.
  - Wire adapters (internal ↔ OpenAI tool wire format) and the full type surface
    (`ToolDefinition`, `ToolCall`, `ToolResult`, `AgentTurn`, `AgentMessage`,
    `AgentResponse`, `ToolPropertySchema`, …). `ToolPropertySchema` is recursive
    (array `items`, nested object `properties`, `enum`).
- Two fresh-call request modes against the slug `/execute` contract: single
  `message` (default / Nana) and structured `messages` (chat / agent flows).
- Dual **ESM + CJS** build with type declarations, produced by `tsup`;
  tree-shakeable (`sideEffects: false`).

### Notes

- The `protocol.ts` and `session-store.ts` wire types remain **aspirational /
  unused** (no importers) — carried over unchanged; do not build against them
  without a plan.
- Not yet rewired onto `@noukai/sdk` (its re-declared wire types are still
  local). That consolidation is PR-2/PR-3 of design log
  `20260903-SDK-agent-relay` and is intentionally out of scope for this move.
