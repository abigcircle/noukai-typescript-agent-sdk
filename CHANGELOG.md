# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> `@noukai/agent` is versioned **independently** of `@noukai/sdk` /
> `noukai-sdk`. It is not part of the two-SDK release-parity gate
> (`check_parity.py`); its version line starts fresh at `0.1.0`.

## [Unreleased]

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
