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
`fetch` and `AbortController` (Node 18+, browsers, Bun, Deno).

`react ^18` is an **optional** peer dependency — install it only if you use the
`useAgentChat` hook. The pure `runAgentLoop` has no React dependency.

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

## Surface

| Export | Kind | Role |
|--------|------|------|
| `runAgentLoop(message, options)` | async fn | Pure yield/resume loop. Fresh POST + resume; no React. |
| `useAgentChat(options)` | React hook | Display messages, `isLoading`, abort, multi-turn conversation. |
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
