# @noukai/agent

Generic client-side **agent framework** for [Noukai](https://noukai.dev) flows.
It implements the slug `/execute` **yield/resume tool-calling protocol**: the
model yields tool calls, your client resolves them locally, and the loop resumes
— repeating until a final message or the round limit. Domain-agnostic: you bring
an endpoint, tool definitions, and a resolver.

```
Your component
 └─ useAgentChat(options)          ← optional React binding
      └─ runAgentLoop(message, options)   ← pure async loop (no React)
           ├─ POST { message|messages, tools } → your endpoint
           ├─ response: tool_calls_required → resolve locally → resume
           └─ response: completed → done
```

- [Install](#install)
- [Quick start (React)](#quick-start-react)
- [The pure loop (no React)](#the-pure-loop-no-react)
- [Two request modes](#two-request-modes)
- [Surface](#surface)
- [Tool registry](#tool-registry)
- [Tool label formatter](#tool-label-formatter)
- [Endpoint contract](#endpoint-contract)
- [OpenTelemetry (opt-in)](#opentelemetry-opt-in)
- [Scripts](#scripts)

## Install

```bash
pnpm add @noukai/agent
# or
npm install @noukai/agent
# or
yarn add @noukai/agent
```

Ships **ESM + CJS** with type declarations. Requires a modern runtime with
`fetch` and `AbortController` (Node 18+, browsers, Bun, Deno). Prefer ESM: the
package depends on `@noukai/sdk` (ESM-only), so `require()`-ing this package on
Node < 22.12 (no `require(esm)`) needs an ESM consumer or a bundler.

`@noukai/sdk` (`^0.5.0`) is a dependency — as of `0.2.0` the yield/resume loop,
the request/response models, and the round limit come from the SDK
(`createRelayFlow`); this package adds local tool resolution, dedup, progress
labels, and the React hook on top. `react ^18` is an **optional** peer — install
it only if you use `useAgentChat`. The pure `runAgentLoop` has no React dependency.

## Quick start (React)

```tsx
import { useAgentChat, createToolRegistry } from "@noukai/agent";

// 1. Register tools (resolved locally, in the browser)
const registry = createToolRegistry();
registry.register({
  definition: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
  resolve: (args) => `72°F and sunny in ${args.city}`,
});

// 2. Drive the loop from a component
function ChatPanel() {
  const { messages, isLoading, sendMessage } = useAgentChat({
    endpoint: "/api/ai/chat", // your keyholder relay route
    tools: registry.definitions(),
    resolveToolCall: (call) => registry.resolve(call),
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id} data-role={m.role}>
          {m.content}
        </div>
      ))}
      <input
        disabled={isLoading}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            sendMessage(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
      />
    </div>
  );
}
```

## The pure loop (no React)

`runAgentLoop` is a plain async function — use it in a server action, a CLI, a
test, or vanilla JS.

```ts
import { runAgentLoop } from "@noukai/agent";

const result = await runAgentLoop("Hello", {
  endpoint: "/api/ai/chat",
  tools: registry.definitions(),
  resolveToolCall: (call) => registry.resolve(call),
  maxIterations: 5,
  signal: abortController.signal, // optional
});

if (result.type === "message") {
  console.log(result.content); // final response
  console.log(result.metadata); // optional domain metadata (generic M)
} else {
  console.log("Max iterations reached");
}
```

## Two request modes

The fresh call has two shapes; **client-tool pause/resume is identical in both**,
and the resume shape is shared.

- **Single message (default / "Nana"):** pass a `message` string. The fresh body
  is `{ message, tools, parameters? }`; conversation history reaches the model
  flattened through the flow's prompt (`parameters: { conversation }`).
- **Structured messages (chat / agent flows):** pass `messages` — an
  `AgentTurn[]` already ending with the current user turn. The fresh body becomes
  `{ messages, tools, toolChoice? }` with **no** `message`/`parameters`, and the
  backend consumes the top-level `messages` field as real `role:user/assistant`
  turns. In `useAgentChat`, opt in with `sendStructuredMessages: true`.

On completion the loop unwraps both result shapes — Nana's `{ content }` and the
chat block's `{ message }` — falling back to `JSON.stringify` for anything else.

## Background turns (multi-tab)

By default, changing `sessionId` (e.g. switching chat tabs on one `useAgentChat`
instance) **aborts** the in-flight turn. Opt into **background turns** to let a
turn keep running to completion after you switch away, and see its result when
you return:

```ts
const chat = useAgentChat({
  endpoint: "/api/nana/execute",
  tools: registry.definitions(),
  // ctx.sessionId lets one resolver route to the turn's OWN session's state
  // instead of the focused tab (absent on the default, non-background path):
  resolveToolCall: (call, ctx) => resolveForSession(ctx?.sessionId ?? activeTabId, call),
  sessionId: activeTabId,      // swap this to switch tabs
  store: myStore,              // required — where a detached turn persists
  backgroundTurns: true,       // opt in (default false = abort-on-switch)
  onMetadata: (meta, ctx) => applyOpsTo(ctx?.sessionId ?? activeTabId, meta),
  onTurnError: (err, { sessionId }) => flagTab(sessionId, err),
});

// Show a spinner on backgrounded tabs:
chat.backgroundSessions;       // sessionIds (for this store) with a live turn
chat.stop();                   // abort the ACTIVE session's turn
chat.stop("other-tab-id");     // abort a specific backgrounded turn
```

- **Requires `sessionId` + `store`.** The turn runs in a module-level manager
  keyed by `(store, sessionId)`, so it survives a hook unmount/remount. A page
  reload keeps only what the store persisted (unchanged). Enabling the flag
  without a store is a no-op.
- **Switching never aborts** — only `stop(sessionId?)` does. Persistence is
  handled by the manager (it saves the finished exchange once on completion).
- **Route by session.** For a consumer multiplexing many tabs, `onMetadata` /
  `onToolCallStart` receive `{ sessionId }` and `resolveToolCall` an optional
  `ctx.sessionId`, so a backgrounded turn's tool resolution and metadata reach the
  right tab's state rather than the focused one. (All backward compatible — ignore
  the extra argument and nothing changes.)
- **Observe from elsewhere.** A tab strip rendered outside the chat hook can call
  `useBackgroundSessions(store)` (React) or `subscribeBackgroundSessions(store, cb)`
  (framework-free).

Design notes: `docs/design-logs/2026/09Sep/20260914-SDK-agent-background-turns.md`.

## Surface

| Export | Kind | Role |
|--------|------|------|
| `runAgentLoop(message, options)` | async fn | Pure yield/resume loop. Fresh POST + resume; no React. |
| `useAgentChat(options)` | React hook | Display messages, `isLoading`, abort, multi-turn conversation, optional background turns. |
| `useBackgroundSessions(store)` | React hook | sessionIds with a live background turn (for tab spinners outside the chat hook). |
| `subscribeBackgroundSessions(store, cb)` | fn | Framework-free version of the above; returns an unsubscribe. |
| `createToolRegistry()` | factory | Declarative tool register + resolve. |
| `ToolLabelFormatter` | class | Progress labels for in-flight tool calls. |
| wire adapters | fns | `toWireToolDef(s)`, `parseWireToolCall`, `toWireToolResult` — internal ↔ OpenAI tool wire format. |
| types | — | `ToolDefinition`, `ToolCall`, `ToolResult`, `AgentTurn`, `AgentMessage`, `ToolPropertySchema`, `AgentChatOptions`, `AgentChatReturn`, … |

`ToolPropertySchema` is **recursive** — array `items`, nested object
`properties`, and `enum` are all admitted, so nested tool parameters type-check.

> `protocol.ts` / `session-store.ts` export **aspirational, currently unused**
> wire types (opaque `stateToken`, optional chat persistence). They have no
> importers today — don't build new code against them without a plan.

## Tool registry

```ts
const registry = createToolRegistry();

registry.register({
  definition: {
    name: "search_docs",
    description: "Search documentation",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  resolve: async (args) => JSON.stringify(await searchIndex(args.query, args.limit ?? 10)),
});

registry.definitions(); // → send to the model
await registry.resolve({ id: "call_1", name: "search_docs", arguments: { query: "auth" } });
```

- Resolvers receive parsed `arguments` and return `string | Promise<string>`.
- Unknown tool names return an error result (no throw).
- Re-registering a name overwrites it.

## Tool label formatter

Turns `get_user_profile` into `"Reading user profile"` for progress UI.

```ts
const f = new ToolLabelFormatter();
f.formatOne("get_pipeline_data"); // "Reading pipeline data"
f.format([
  { id: "1", name: "get_data", arguments: {} },
  { id: "2", name: "update_config", arguments: {} },
]); // → ["*Reading data*", "*Updating config*"]
```

Default verbs: `get`→Reading, `create`→Creating, `write`→Writing,
`update`→Updating, `delete`→Deleting, `set`→Setting, `add`→Adding,
`remove`→Removing, `run`→Running, `execute`→Executing, `validate`→Validating.
Override with the constructor or `setVerb`.

## Endpoint contract

Your endpoint (typically a keyholder relay in front of Noukai's
`/seq/{org}/{project}/{slug}/execute`) accepts a fresh or resume payload and
returns one of two shapes:

```jsonc
// Model wants tools (loop continues)
{ "status": "tool_calls_required", "toolCalls": [ { "id": "call_1", "name": "get_data", "arguments": {} } ], /* …resume state… */ }

// Model is done (loop ends)
{ "status": "completed", "result": { "message": "Here's what I found…" } }
```

The `metadata` channel on a final message is generic (`M`) — use it to pass
structured data (e.g. pending operations) alongside the chat text without
polluting the message content.

> **Building the keyholder relay this endpoint points at?** This package is the
> browser half. The server half — a verbatim relay that holds `nk_`, bounds
> abuse, and runs your `authorize` hook — plus the full wire contract and an
> implementation checklist live in the SDK relay guide:
> [`@noukai/sdk` docs/AGENT_RELAY.md](../noukai-typescript-sdk/docs/AGENT_RELAY.md)
> (Python: [`noukai-sdk` docs/AGENT_RELAY.md](../noukai-python-sdk/docs/AGENT_RELAY.md)).

## OpenTelemetry (opt-in)

The loop can emit [OpenTelemetry](https://opentelemetry.io/) spans into **your
own** OTel provider. This is the only place the browser-side loop is
observable — a server-side trace never sees your local `resolveToolCall`
executions (how long they ran, whether they threw, dedup-cache hits). It is
**off by default** and a true no-op when off (the package never imports
OpenTelemetry unless you opt in).

`@opentelemetry/api` is an optional peer dependency — install it and turn it on
with `otel: true`:

```bash
npm install @opentelemetry/api
```

```ts
import { runAgentLoop } from "@noukai/agent";

const result = await runAgentLoop("Hi", {
  endpoint: "/api/ai/chat",
  tools: registry.definitions(),
  resolveToolCall: (call) => registry.resolve(call),
  otel: true,            // emit spans into the globally-configured provider
  // tracer,             // …or pass an explicit OTel Tracer
  // toolPayloads: true, // attach bounded tool args/result (may contain PII)
});
```

`useAgentChat({ …, otel: true })` works the same way; when a `sessionId` is set
it is recorded on the turn span as `session.id`.

**Span tree.** One `invoke_agent` span per loop, with two kinds of child:

| Span | Kind | Key attributes |
|------|------|----------------|
| `invoke_agent` | INTERNAL | `noukai.agent.tools` (the tool list), `noukai.agent.request_mode`, `noukai.agent.max_rounds`, `noukai.agent.rounds`, `noukai.agent.termination` (`completed` \| `max_iterations` \| `error`) |
| `noukai.agent.round` | CLIENT | `http.response.status_code`, `noukai.agent.round_index` — one per relay round-trip |
| `execute_tool {name}` | INTERNAL | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `noukai.tool.cache_hit` (+ `noukai.tool.arguments`/`noukai.tool.result` when `toolPayloads`) |

**Unified trace (browser → relay → Noukai).** Each relay POST is wrapped to
inject a W3C `traceparent` from the round span, so an OTel-instrumented relay
continues the **same** trace. Note this uses your app's globally-configured
propagator — the standard `provider.register()` sets W3C by default. To extend
the trace through the relay to the Noukai ingress, pair this with the base SDK's
relay `traceparent` forwarding (`@noukai/sdk` ≥ the OTel release). The trace ends
at Noukai's ingress — the flow's server-side execution has no OTel today.

**Background turns.** For a detached turn (`backgroundTurns: true`), pass
`otelContext` (an OTel `Context`) if you want the turn span parented under a
specific UI span — it is snapshotted at send, since a detached turn runs with no
ambient context. Without it, the turn span roots at the active context when the
send fires.

## Scripts

```bash
pnpm build         # tsup → dist/ (ESM + CJS + .d.ts)
pnpm test          # vitest run
pnpm test:watch    # vitest watch
pnpm check-types   # tsc --noEmit
pnpm lint          # eslint
```

See [`RELEASING.md`](./RELEASING.md) to cut a release, and
[`CHANGELOG.md`](./CHANGELOG.md) for the version history.
