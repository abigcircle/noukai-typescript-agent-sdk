# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> `@noukai/agent` is versioned **independently** of `@noukai/sdk` /
> `noukai-sdk`. It is not part of the two-SDK release-parity gate
> (`check_parity.py`); its version line starts fresh at `0.1.0`.

## [Unreleased]

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
