# 20260914-SDK-agent-background-turns — Detached (background) turns in `@noukai/agent`

- **Status:** **Implemented** (uncommitted — pending human review). Approved with
  the recommended decisions: opt-in flag named `backgroundTurns`; manager-layer
  (React-free) test suite, no new test deps. Shipped as `@noukai/agent@0.3.0`
  (version bumped, CHANGELOG dated; **not published** — awaiting sign-off).
- **Date:** 2026-09-14
- **Author:** kii (with Claude)
- **Package:** `@noukai/agent` (TS agent SDK). Depends on `@noukai/sdk` ≥ 0.4.0.
- **Scope:** `@noukai/agent` **only**. No `@noukai/sdk` change (justified in Q8). No Python peer (React-bound consumer).
- **Design-doc convention:** referenced from code as `20260914-SDK-agent-background-turns` (matches `20260903-SDK-agent-relay`). Lives in the agent SDK repo's own `docs/design-logs/` so it is version-controlled with the code it changes.
- **Expected release:** MINOR bump (`0.2.0` → `0.3.0`) — purely additive, opt-in, drop-in.

> **Repo note:** the agent SDK is its own git repo (`noukai-typescript-agent-sdk`, npm `@noukai/agent`) with its own CHANGELOG/RELEASING and its own version line — it is **not** in the two-SDK `check_parity.py` gate. This doc lives with that repo.

---

## TL;DR

The Noukai web app's **Nana chat** multiplexes many chat tabs through **one**
`useAgentChat({ sessionId, store })` instance, swapping `sessionId` to the active
tab. Today a turn is welded to the hook's **single `AbortController`**, and the
Session-Load effect hard-wires *"sessionId changed ⇒ abort"* (`use-agent-chat.ts:225`).
So switching tabs mid-turn **kills and loses** the running turn.

The fix: move a turn's *execution* out of the hook and into a **module-level
`TurnManager`** keyed by `(store, sessionId)`. A turn started for session **A**
owns its own `AbortController` and runs `runAgentLoop` to completion regardless of
which session is active, appending its output to a **live turn record** and
flushing the finished conversation to the **store**. The hook becomes a *view*
that **subscribes** to the active session's record (if live) or **loads** from the
store (if not). Switching sessions never aborts; only an explicit
`stop(sessionId?)` does.

This is **opt-in** (`backgroundTurns: true`, requires `sessionId` + `store`) and
**drop-in** — with the flag off, `useAgentChat` behaves byte-for-byte as it does
today. Because a turn produces **no token-level stream** (only thinking-bubble
events + one terminal result), the "re-attach without dropped/duplicated deltas"
problem reduces to *"render from one authoritative record."*

---

## Background — what exists today (read the code first)

`useAgentChat` (`src/use-agent-chat.ts`) binds an entire turn to **one hook
instance**:

- **One `AbortController` for the whole hook** — `abortRef` (`:55`), opened fresh
  in `sendMessage` after aborting the previous (`:88-91`), aborted by `stop()`
  (`:207-210`), and aborted on unmount (`:271`).
- **`sessionId` change ⇒ abort.** The Session-Load effect (deps `[sessionId, store]`,
  `:216-263`) calls `abortRef.current?.abort()` on **every** sessionId change
  (`:225`) then loads the new session. **This is the abort-on-tab-switch.**
- **Turn state lives in the hook**: `messages` / `isLoading` (`useState`) and
  `conversationRef` (`useRef`) — all bound to this instance. When `sessionId`
  changes, the effect swaps all of it.
- **Save is already correctly guarded.** `hydratedIdRef` (`:69`) blocks the save
  effect during the switch window; `isDirtyRef` (A3, `:75`) stops a mere open from
  re-saving; the save effect (`:277-310`) writes `{ conversation, displayMessages }`
  only when hydrated, settled (`!isLoading`), dirty, and non-empty
  (`shouldSaveSession`, `session-sync.ts`).

`runAgentLoop` (`src/agent-loop.ts`) is a thin adapter over the SDK's
`createRelayFlow(...).execute({ ..., signal })`. It is **request/response, not a
token stream**: fresh POST → `tool_calls_required` pause → resolve locally via
`resolveToolCall` → resume → … → one terminal `{ type:"message" | "max_iterations" }`
(or a thrown typed `NoukaiError`). Its only *progress* signal is
`onToolCallStart(toolCalls)` — the source of the "thinking…" bubbles.

**Root cause:** a turn is bound to the single hook instance + its single
`AbortController`, and *"session changed ⇒ abort"* is hard-wired. There is no
notion of a turn that outlives being the active session.

---

## The problem, precisely (findings)

- **F1 — A turn cannot outlive being the active session.** Its lifetime is the
  hook instance's `abortRef`, and the Session-Load effect aborts it on the next
  `sessionId` change (`:225`). Backgrounding is structurally impossible.
- **F2 — Turn state is React-instance state.** `messages`/`isLoading`/`conversationRef`
  are per-hook; there is nowhere for a non-active session's turn to accumulate
  output that the hook can re-attach to later.
- **F3 — Unmount aborts unconditionally** (`:271`). Correct *today* (avoids
  `setState`-after-unmount + stray `resolveToolCall` side effects), but it means a
  transient unmount/remount of the multiplexer also kills in-flight work.
- **F4 — Consumer callbacks carry no session identity.** `onMetadata(metadata)`
  and `onToolCallStart(calls)` implicitly belong to "the active session" because
  switching aborts. Once turns background, a callback can fire for session **A**
  while **B** is active — and the consumer (which routes operations into a
  **per-tab overlay**) has no way to know which tab it belongs to.
- **F5 — Tool resolution is single-flighted through the hook.** `resolveToolCall`
  and `tools` are captured per render from the *active* options; a backgrounded
  turn must keep resolving against **its own** session, not whatever tab is
  currently focused.

---

## Goals / Non-goals

**Goals**
1. A turn started for session **S** runs to completion even when the active
   `sessionId` moves away from S; its result is present when the consumer returns.
2. **Switching sessions never aborts a turn.** Aborting is explicit
   (`stop(sessionId?)`), or when the user re-sends is a no-op — never a side effect
   of navigation.
3. Concurrent turns on different sessions **never cross-contaminate**
   messages/state/metadata.
4. A backgrounded turn that **errors** surfaces the error on return without
   crashing.
5. **Drop-in + opt-in.** Existing single-session `useAgentChat` behavior and tests
   are byte-for-byte unchanged; new behavior is behind a flag and safe defaults.
6. Expose **which sessions have a live turn** so the consumer can show a spinner on
   backgrounded tabs.
7. **Browser + SSR safe**; no top-level Node built-ins; import side-effect-free.

**Non-goals**
- **No token streaming.** The loop has none (see TL;DR); we do not add per-token
  deltas or a streaming re-attach cursor. If token streaming ever lands in the SDK
  loop, the record grows a `contentSoFar` field — out of scope here.
- **No cross-page-reload turn survival.** A turn in flight when the page reloads is
  lost (the module dies); the store's last *completed* exchange survives — exactly
  today's contract (`session-store.ts`: "if the page refreshes mid-yield, the cycle
  restarts from the last completed exchange — which is fine").
- **No global turn scheduler / queue / cap** beyond per-session single-flight. If a
  product later needs a concurrency cap, it layers on top of the manager.
- **No change to `@noukai/sdk`** (Q8).
- **No change to the persisted `ChatSession` shape** — background turns reuse the
  existing `{ conversation, displayMessages }` contract.

---

## Design overview

One idea: **a turn's *execution* is not the hook's — it belongs to a module-level
manager. The hook is just a *view* onto the active session.**

```
   ┌──────────────────────────── module scope (survives hook unmount/remount) ────────────────────────────┐
   │                                                                                                       │
   │   TurnManager   (one per module; keyed by  (store-identity, sessionId)  →  LiveTurn)                   │
   │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐   │
   │   │  LiveTurn {                                                                                     │   │
   │   │    sessionId, status: 'running'|'done'|'error',                                                 │   │
   │   │    displayMessages: AgentMessage[]   ← user + thinking… + final/error   (single source of truth)│   │
   │   │    conversation:   AgentTurn[]       ← snapshot at send + appended on done                      │   │
   │   │    metadata?, error?, createdAt, controller: AbortController,                                   │   │
   │   │    ctx: ExecutionSnapshot            ← endpoint, tools, resolveToolCall, formatter, mode,        │   │
   │   │  }                                     callbacks — captured AT SEND, immune to tab switches      │   │
   │   │  subscribers: Set<(turn)=>void>                                                                 │   │
   │   └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
   │        ▲ start(ctx,text)        │ runAgentLoop(text, {…ctx, signal, onToolCallStart})                  │
   │        │ subscribe/unsubscribe  │ on terminal → store.save({conversation,displayMessages}) → notify    │
   └────────┼────────────────────────┼──────────────────────────────────────────────────────────────────────┘
            │ (active sessionId)     │
   ┌────────┴────────────────────────▼──────────────┐
   │  useAgentChat  (React view, per active session) │
   │  - sendMessage → manager.start(snapshot,text)   │
   │  - subscribes to manager[activeSessionId];      │
   │    renders record.displayMessages + isLoading   │
   │  - no live record → loads from store (as today) │
   │  - stop(sessionId?) → manager.abort(id)         │
   │  - backgroundSessions ← manager live-set        │
   └─────────────────────────────────────────────────┘
```

- With `backgroundTurns` **off**, none of this engages — `sendMessage`, the
  Session-Load effect, `stop`, and unmount take today's exact code paths.
- With it **on**, `sendMessage` delegates to the manager; the hook stops owning the
  turn and instead *subscribes* to the active session's record.

---

## The core questions, answered

### Q1 — Where does a turn live relative to the hook view?

A **module-level `TurnManager`** (plain TS, no React), keyed by
**`(store-identity, sessionId)`**. The store is *already required to be
referentially stable* (`types.ts`: "MUST be referentially stable… memoize it"), so
it is a sound discriminator; a `WeakMap<ChatSessionStore, id>` mints a stable id
without leaking. Endpoint/tools/resolver are **not** in the key — they are
snapshotted per turn (Q5-context / F5). Two hooks pointing at the same `store` +
`sessionId` genuinely denote the same logical session, so sharing one live turn is
correct, not a collision.

Why keyed by store, not just sessionId: two unrelated `useAgentChat` instances
(different agents, different endpoints) can legitimately reuse the id `"chat-1"`.
Keying by store identity keeps them isolated.

**Background turns require `sessionId` + `store`.** Without a store there is no
stable identity and nowhere to persist a detached result, so `backgroundTurns` with
no store is a no-op (dev-mode `console.warn`, falls back to today's behavior).

### Q2 — Concurrency

**Per-session single-flight.** One live turn per `(store, sessionId)`. No global
cap. Re-sending to a session that already has a `running` turn is a **no-op**
(mirrors today's `if (isLoading) return`, `:86`). Different sessions run fully
concurrently and independently. (A queue-instead-of-drop policy is a possible
future `onBusy: 'ignore'|'queue'` option — not now.)

### Q3 — Streaming vs store, and the re-attach handoff

There is **no token stream** (see TL;DR), so a turn's entire observable timeline is:
`user msg → [thinking bubbles…] → final assistant msg | max-steps bubble | error bubble`.

- The **live turn record** is the *single source of truth* for a running turn's
  `displayMessages` and `isLoading`. The turn appends to the record; it never
  writes React state directly.
- The **hook re-attaches by subscribing** to the record and rendering
  `record.displayMessages` verbatim (replace, not append). Because there is exactly
  one record and the hook mirrors it, switch-away → switch-back can neither drop nor
  duplicate anything: the hook simply re-reads the current snapshot and receives
  subsequent notifications. **No delta cursor is needed.**
- On **terminal**, the manager flushes the finished `{ conversation, displayMessages }`
  to the **store** (survives reload), notifies subscribers with the final snapshot,
  then deletes the record. A hook that returns *after* completion loads the result
  from the store (already persisted); a hook viewing *at* completion gets it via the
  final notification. Either way, exactly-once.

Handoff precisely (no dropped/duplicated output):

```
send(A)         : manager.start → record{running, [userMsg]} → notify → hook(A) renders userMsg + spinner
switch A→B      : hook unsubscribes A, subscribes B; record(A) keeps running in manager
…thinking(A)    : record(A).displayMessages += thinking; notify → (no A subscriber; nothing rendered)
switch B→A      : hook subscribes A → immediately reads record(A) snapshot (userMsg + thinking) → renders
done(A)         : record(A) += finalMsg, status=done; store.save(A); notify → hook(A) copies final → React state
                  manager deletes record(A)
later return(A) : no record → Session-Load reads store(A) → shows final
```

### Q4 — Lifecycle / GC; unmount vs reload

- **Running** records live in the manager. **Terminal** → flush to store → notify →
  **delete** (no TTL, no leak; terminal state reaches a non-viewing hook via the
  store).
- **Hook unmount does NOT abort** (background mode). The manager is module-level, so
  turns survive an unmount and a later remount re-attaches. F3's original hazards are
  designed out: the turn writes the *record* (not the unmounted hook's `setState`),
  and an unmounted hook has *unsubscribed*, so there is no `setState`-after-unmount;
  `resolveToolCall` continuing is now **intended** (that is the feature).
- **Page reload** kills the module ⇒ store only (unchanged contract).
- Escape hatch: `TurnManager.abortAll(store?)` for a hard teardown (e.g. logout);
  not wired to unmount.

### Q5 — Abort semantics

- `stop(sessionId?)` — **widened** from `() => void`. `stop()` aborts the **active**
  session's turn (backward compatible); `stop("A")` aborts session A's turn even
  while B is active.
- **Switching sessions aborts nothing** (that is the whole point).
- **Unmount aborts nothing** in background mode. In non-background mode, the existing
  unmount-abort (`:271`) is retained unchanged.
- Abort finalizes the record (`status='done'`, no assistant/error bubble appended —
  matching today's silent `AbortError` return, `:168-169`) and removes it. Since
  `conversation` is only appended on a *successful* completion, an aborted turn does
  not persist a half-turn.

### Q6 — Errors on a backgrounded turn

The turn's `catch` appends an **error bubble** to `record.displayMessages`
(display-only, never into `conversation` — identical to today's `:167-179`) and sets
`status='error'`, `error`. It flushes to the store (the error bubble rides in
`displayMessages`, as it does today) and notifies. On return the hook renders the
record/store including the error bubble, `isLoading=false`. No crash: the manager's
turn runner is fully wrapped; a subscriber throwing cannot break the turn (notify is
try/caught per subscriber). Optionally the consumer learns of it in real time via
`onMetadata`/a new `onTurnError(err, { sessionId })` callback (see API diff) so a
backgrounded tab can show an error badge immediately.

### Q7 — API surface & backward compatibility

Purely additive, opt-in (full diff below). `useAgentChat` stays a drop-in:
`backgroundTurns` defaults `false`; callbacks gain an **optional** second `ctx`
argument (existing consumers ignore it); `stop` widens its signature compatibly;
the return gains `backgroundSessions: string[]`.

### Q8 — Does `@noukai/sdk` need to change? (No — justification)

**No.** `createRelayFlow(...).execute({ signal })` is already a fire-and-await
promise that (a) drives the entire yield/resume loop internally, (b) resolves tools
via the caller's `toolHandler`, and (c) accepts an `AbortSignal`. Detachment is
*purely* about **where that promise is awaited** (manager vs hook) and **where its
outputs are stored** (record + store vs React state) — both entirely inside
`@noukai/agent`. The SDK already exposes every seam we need. Adding "background" to
the SDK would wrongly bake a UI/multiplexing concern into the transport layer
(the same principle that kept authorization and bound-values out of the relay
adapter in `20260903-SDK-agent-relay`). Confirmed against `relay-flow.ts` and
`agent-loop.ts`.

---

## Public API diff (`@noukai/agent`)

```diff
  // types.ts — ToolResolver gains an OPTIONAL session context (backward compatible)
- export type ToolResolver = (call: ToolCall) => ToolResult | Promise<ToolResult>;
+ export type ToolResolver = (
+   call: ToolCall,
+   ctx?: { sessionId?: string },   // present for background turns; lets one resolver route by session (F5)
+ ) => ToolResult | Promise<ToolResult>;

  export interface AgentChatOptions<M = Record<string, unknown>> {
    // …existing…
+   /**
+    * Opt in to detached (background) turns. Requires `sessionId` + `store`.
+    * When true, a turn started for a session keeps running after `sessionId`
+    * changes; switching sessions no longer aborts it. Default false = today's
+    * behavior, byte-for-byte. No store ⇒ ignored (dev warn).
+    */
+   backgroundTurns?: boolean;

-   onMetadata?: (metadata: M | undefined) => void;
+   onMetadata?: (metadata: M | undefined, ctx?: { sessionId: string }) => void;
-   onToolCallStart?: (toolCalls: ToolCall[]) => void;
+   onToolCallStart?: (toolCalls: ToolCall[], ctx?: { sessionId: string }) => void;
+   /** Optional: a background turn failed (fires even while another session is active). */
+   onTurnError?: (error: Error, ctx: { sessionId: string }) => void;
  }

  export interface AgentChatReturn {
    // …existing…
-   stop: () => void;
+   stop: (sessionId?: string) => void;   // widened; stop() still aborts the active session
+   /** sessionIds (for this hook's store) with an in-flight background turn — for tab spinners. */
+   backgroundSessions: string[];
  }
```

New module + exports (`src/turn-manager.ts`, surfaced from `index.ts`):

```ts
export type LiveTurnStatus = "running" | "done" | "error";

// Subscribe to the set of sessionIds with a running turn for a given store —
// for a tab strip rendered OUTSIDE the component that holds useAgentChat.
export function subscribeBackgroundSessions(
  store: ChatSessionStore,
  cb: (sessionIds: string[]) => void,
): () => void;                       // returns an unsubscribe

// React convenience wrapper over the above (React is an optional peer).
export function useBackgroundSessions(store: ChatSessionStore): string[];
```

The `TurnManager` itself is an internal singleton (module-scoped); the two helpers
above are the only public seam onto its live-set. (Keeping the manager class
un-exported avoids consumers hand-driving turns and lets us evolve it freely.)

**Nothing is removed or renamed.** `messages`, `isLoading`, `sendMessage`,
`clearChat`, `conversation` keep their exact shapes.

---

## Data model & manager surface (internal)

```ts
interface ExecutionSnapshot<M> {                 // captured at send() — immune to later tab switches (F5)
  endpoint: string;
  tools: ToolDefinition[];
  resolveToolCall: ToolResolver;
  maxIterations?: number;
  formatter: ToolLabelFormatter;
  toolCallContext?: (call: ToolCall) => string | undefined;
  sendStructuredMessages: boolean;
  onToolCallStart?: (calls: ToolCall[], ctx: { sessionId: string }) => void;
  onMetadata?: (m: M | undefined, ctx: { sessionId: string }) => void;
  onTurnError?: (e: Error, ctx: { sessionId: string }) => void;
  loopRunner?: typeof runAgentLoop;              // test seam; defaults to runAgentLoop
}

interface LiveTurn<M> {
  sessionId: string;
  status: LiveTurnStatus;
  displayMessages: AgentMessage[];               // SINGLE source of truth while running
  conversation: AgentTurn[];                     // snapshot at send; user+assistant appended on success
  metadata?: M;
  error?: Error;
  createdAt: string;                             // preserved from the loaded session
  controller: AbortController;
}

// manager (module singleton)
start(store, sessionId, snapshotAtSend, userText): void   // no-op if a running turn exists
subscribe(store, sessionId, cb): () => void               // cb(turn|undefined) now + on change
get(store, sessionId): LiveTurn | undefined
abort(store, sessionId): void
liveSessionIds(store): string[]
subscribeLiveSet(store, cb): () => void
abortAll(store?): void
```

The manager reuses the existing `msg-N` id discipline (`maxMsgIdSuffix`) seeded from
the snapshot's display so a backgrounded turn cannot mint a colliding id.

### Hook integration (background mode)

- **`sendMessage(text)`**: build `ExecutionSnapshot` from current `optionsRef` +
  current `conversationRef`/`messages`/`createdAtRef`; call
  `manager.start(store, sessionId, snapshot, text)`. The subscription (below) is
  what then drives `messages`/`isLoading` — the hook no longer sets them inline.
- **Session-Load effect (deps `[sessionId, store, backgroundTurns]`)**: in background
  mode, **do not abort**. Unsubscribe from the old session; if the new session has a
  live record, subscribe and render from it; else load from the store as today, then
  subscribe (so a turn started later still drives this view). The
  `hydratedIdRef`/`isDirtyRef`/`loadSeq` guards are preserved unchanged.
- **Subscription effect**: `manager.subscribe(store, activeSessionId, turn => { … })`
  maps a `turn` snapshot → `setMessages(turn.displayMessages)` +
  `setIsLoading(turn.status === 'running')`; on a terminal notification it also syncs
  `conversationRef`. When `turn === undefined` (no live turn), the loaded store state
  stands.
- **Save effect**: unchanged predicate (`shouldSaveSession`), and it *stays* gated by
  `isLoading` — while a background turn runs, `isLoading` is true for its session, so
  the hook's own save effect is inert and the **manager** owns that session's
  persistence (it saves once on terminal). No double-write, no fight.
- **`stop(sessionId?)`** → `manager.abort(store, sessionId ?? activeSessionId)`.
- **Unmount**: background mode → unsubscribe only (no abort). Non-background → today's
  `abortRef.abort()`.
- **`backgroundSessions`**: from `manager.subscribeLiveSet(store, …)` into a small
  `useState`.

---

## Migration notes — the Noukai web app (Nana) consumer

1. **Turn the flag on:** `useAgentChat({ sessionId: activeTabId, store, backgroundTurns: true, … })`.
2. **Delete the app-side `stop()` on tab switch / close / new.** That call is what
   currently kills the turn; with the flag on it is not only unnecessary but wrong.
   Keep `stop()` only where the user explicitly stops *the visible* turn.
3. **Route callbacks by session.** `onMetadata`/`onToolCallStart` now receive
   `{ sessionId }`. Update the per-tab overlay for **that** session id, not "the
   active tab." This is the fix for operations/diff-bubbles landing on the right tab
   while backgrounded (F4). Existing code that ignores the 2nd arg still compiles —
   but *should* adopt it, or a backgrounded turn's ops route to the wrong tab.
4. **Make `resolveToolCall` session-correct.** Use the new `ctx.sessionId` (or bind a
   resolver per session) so a backgrounded turn resolves tools against its own
   session's state, not the focused tab (F5). If today's resolver already closes over
   per-tab state captured at send, it keeps working — but `ctx.sessionId` is the
   robust path.
5. **Spinners on backgrounded tabs:** render from `backgroundSessions` (from the
   hook) or `useBackgroundSessions(store)` if the tab strip is a separate component.
6. **Overlay persistence is unchanged** — the app's second per-session store (the
   "domain overlay" recipe in `session-store.ts`) still keys by the same
   `sessionId`; nothing here touches it.

**Consumer contract, restated:** with background turns on, `tools` /
`resolveToolCall` / `onMetadata` must be **pure with respect to the session they
were invoked for** — they must not read "active tab" globals. The manager snapshots
the function references at send and passes `{ sessionId }`; the consumer must not
re-introduce active-tab coupling inside them.

---

## Backward compatibility & safety

- **Drop-in:** flag off ⇒ every existing path (`sendMessage` inline, abort-on-switch,
  abort-on-unmount, save-gate) is the current code, untouched. Existing consumers
  (single-session or the current abort-on-switch multiplexer) see **no change**.
- **Type compatibility:** `ToolResolver`/callbacks add *optional* params; `stop`
  widens to an optional param — all source-compatible. `AgentChatReturn` only *gains*
  a field.
- **Browser-safe:** the manager is a module-level `Map` + `Set` + `WeakMap` and plain
  closures — **no Node built-ins, no `AsyncLocalStorage`**, no top-level side effect
  that touches `window`/`localStorage`/`process`. (Directly heeds the constraint that
  `@noukai/sdk` 0.4.1 hit — no eager Node class at module load.)
- **SSR-safe:** module init allocates empty collections only; all work happens inside
  a user-triggered `sendMessage` on the client. No render-time or import-time
  `window`/storage access. `sideEffects:false` stays honest (the module has no import
  side effects).
- **`useBackgroundSessions`** uses React only inside its body; React stays an
  **optional peer** (the non-React `subscribeBackgroundSessions` is the base).

---

## Test plan (vitest, `node` env — no React needed for the core)

The engine is a **pure, React-free module**, so the acceptance criteria are proven
against the manager directly (mirroring how `session-sync.ts` was extracted). Tests
inject a fake `loopRunner` (or fake `fetch` via `runAgentLoop`) and a
`MemorySessionStore`.

**`turn-manager.test.ts` (new) — the acceptance criteria:**
1. **Switch-away-and-return (AC1).** Start turn A (fake loop: emits 2
   `onToolCallStart`, then resolves `{message}` after a controllable deferral);
   subscribe as "A", unsubscribe (simulate switch to B); resolve the loop; a *new*
   subscribe as "A" receives the **final** displayMessages exactly once; the store
   has A's `{conversation, displayMessages}`.
2. **No dropped/duplicated deltas (AC/Q3).** Subscribe→unsubscribe→resubscribe A
   across each stage (userMsg, each thinking bubble, final); assert the resubscribed
   view equals the record snapshot at that instant — never missing, never doubled.
3. **Concurrent turns don't cross-contaminate (AC3).** Run A and B loops
   interleaved; assert each record/store holds only its own messages, metadata, and
   `conversation`.
4. **Switching sessions never aborts (AC2).** Start A, "switch" (unsubscribe A /
   subscribe B) mid-flight; A's controller is **not** aborted; A completes.
5. **Error on a backgrounded turn (AC4).** Fake loop throws; record → `status:error`
   with an error bubble in `displayMessages`; `store.save` called;
   `onTurnError({sessionId})` fired; a resubscribe renders the error; no throw
   escapes.
6. **`max_iterations`** → the max-steps bubble is appended (display-only, not into
   `conversation`) and persisted.
7. **Abort (`stop`) semantics.** `abort(A)` finalizes without an assistant/error
   bubble; `conversation` not extended; record removed; `stop()` vs `stop("A")`
   target resolution.
8. **Per-session single-flight (Q2).** `start` on a session with a `running` turn is
   a no-op (does not spawn a second loop / second controller).
9. **Keying (Q1).** Same `sessionId` on two different stores ⇒ two independent
   records; same `(store, sessionId)` ⇒ shared.
10. **Live-set subscription (AC6).** `subscribeLiveSet`/`liveSessionIds` reflect
    start→terminal transitions; `subscribeBackgroundSessions` unsubscribe stops
    notifications.
11. **Snapshot immutability (F5).** Changing the "active" options after `start` does
    not change the running turn's endpoint/tools/resolver; `resolveToolCall` receives
    `{ sessionId }`.

**Existing tests unchanged:** `session-sync.test.ts` (save-gate predicates still
hold — the manager reuses them conceptually), `session-store.test.ts`,
`agent-loop*.test.ts`, wire/registry/formatter tests. Drop-in verified by leaving
them green.

**Hook-level (optional, only if we add jsdom):** a thin `renderHook` smoke test that
flag-off behavior is identical and flag-on `sendMessage` routes to the manager. The
vitest env is `node` today; rather than pull in `@testing-library/react` + `jsdom`,
the plan proves the semantics at the manager layer and keeps the hook a thin adapter.
(Call this out for approval — add React test infra, or stay manager-only.)

**Green gate:** `pnpm build && pnpm check-types && pnpm test && pnpm lint`.

---

## Risks & open questions

- **F4/F5 are a consumer contract, not just an API.** The SDK can pass `{ sessionId }`
  and snapshot references, but if the consumer's `resolveToolCall`/`onMetadata` read
  "active tab" globals, backgrounded turns misroute. Mitigation: migration steps 3–4
  + the restated contract; strongly recommend `ctx.sessionId` adoption.
- **Memory of a runaway background turn.** A turn that never terminates (hung relay)
  holds its record until the SDK's per-request timeout (`createRelayFlow` default
  300 s) or an explicit `stop`. Acceptable; the record is small and single-flighted.
- **Two hooks, same `(store, sessionId)`, both `sendMessage`.** Single-flight makes
  the second a no-op; both views subscribe to the one turn — correct, not a race.
- **Reload mid-turn loses the in-flight turn** (non-goal, unchanged contract) — worth
  noting to the consumer so a backgrounded spinner doesn't imply reload-durability.
- **Flag default.** Proposed **opt-in** (`false`) for maximum safety and explicit
  semantics. Alternative: default-on when `sessionId` + `store` + a multi-session
  signal are present — rejected as too implicit for a published package. (Open for
  the reviewer to overrule.)
- **Naming.** `backgroundTurns` vs `detachedTurns` vs `keepTurnsAlive` — open to a
  preference. (Recommendation: `backgroundTurns`.)

---

## Rollout / versioning

1. Land `src/turn-manager.ts` + hook integration + `index.ts` exports + tests.
2. `CHANGELOG.md`: move `[Unreleased]` → `## [0.3.0] — <date>` (Keep a Changelog);
   `Added` (background turns, `backgroundTurns`, `stop(sessionId?)`,
   `backgroundSessions`, `subscribeBackgroundSessions`/`useBackgroundSessions`,
   callback `ctx`); note **no behavior change** with the flag off.
3. Bump `package.json` `0.2.0` → `0.3.0` (MINOR; additive + opt-in). Not part of the
   two-SDK parity gate.
4. `pnpm build && pnpm check-types && pnpm test && pnpm lint`; `pnpm pack --dry-run`.
5. **Do not publish** until asked (per RELEASING.md flow: commit → tag → CI publishes).
6. Consumer adoption (Nana) is a **separate** web-app PR that flips the flag and
   removes the app-side `stop()` on switch — gated on this package publishing.

---

## Appendix — files touched

| File | Change |
|---|---|
| `src/turn-manager.ts` | **new** — the module-level manager, `LiveTurn`, snapshot, live-set, `subscribeBackgroundSessions`, `useBackgroundSessions`. React-free core. |
| `src/use-agent-chat.ts` | background-mode branch in `sendMessage`; Session-Load effect no-abort + subscribe; subscription effect; `stop(sessionId?)`; unmount no-abort in bg mode; `backgroundSessions` in return. Flag-off paths untouched. |
| `src/types.ts` | `backgroundTurns`, `onTurnError`, callback `ctx`, `ToolResolver` `ctx`, `stop` widened, `backgroundSessions` on return. |
| `src/index.ts` | export `subscribeBackgroundSessions`, `useBackgroundSessions`, `LiveTurnStatus`. |
| `tests/turn-manager.test.ts` | **new** — acceptance-criteria suite (above). |
| `CHANGELOG.md`, `package.json` | `[0.3.0]` entry + MINOR bump. |
