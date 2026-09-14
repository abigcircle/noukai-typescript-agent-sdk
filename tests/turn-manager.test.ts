import { describe, it, expect, vi, afterEach } from "vitest";
import {
  startTurn,
  getTurn,
  subscribeTurn,
  abortTurn,
  abortAllTurns,
  liveTurnSessionIds,
  subscribeBackgroundSessions,
} from "../src/turn-manager.js";
import type { ExecutionSnapshot, LiveTurn, LoopRunner } from "../src/turn-manager.js";
import { MemorySessionStore } from "../src/session-store.js";
import { ToolLabelFormatter } from "../src/tool-label-formatter.js";
import type { AgentLoopResult } from "../src/agent-loop.js";
import type { ToolCall } from "../src/types.js";

// ─── Fixtures ────────────────────────────────────────────────
// The turn-manager is a React-free module singleton — every acceptance
// criterion is provable by driving it directly with a fake `loopRunner` and a
// MemorySessionStore. Each test uses a FRESH store (its identity keys the
// manager), so no per-test state leaks; afterEach aborts any turn a test left
// running as a backstop.

const callA: ToolCall = { id: "a", name: "get_block", arguments: {} };
const callB: ToolCall = { id: "b", name: "update_block", arguments: {} };

function makeDeferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

/** Let queued promise chains settle (the manager runs turns fire-and-forget). */
async function settle(n = 15): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * A programmable loop runner. For each `step` it announces the step's tool
 * calls (→ thinking bubbles), resolves them (exercising the injected ctx), then
 * awaits the step's gate. After all steps it awaits `finalGate`, then throws
 * `error` or returns `result`. Honors `options.signal` → AbortError, so
 * `abortTurn` cancels it like a real fetch would.
 */
function scriptedLoop(opts: {
  steps?: Array<{ toolCalls: ToolCall[]; gate: Promise<void> }>;
  finalGate?: Promise<void>;
  result?: AgentLoopResult;
  error?: Error;
}): { runner: LoopRunner } {
  const runner: LoopRunner = async (_message, options) => {
    const waitAbortable = (p: Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const onAbort = () => {
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        p.then(
          () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          (e: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      });

    for (const step of opts.steps ?? []) {
      options.onToolCallStart?.(step.toolCalls);
      for (const call of step.toolCalls) {
        await Promise.resolve(options.resolveToolCall(call));
      }
      await waitAbortable(step.gate);
    }
    if (opts.finalGate) await waitAbortable(opts.finalGate);
    if (opts.error) throw opts.error;
    return opts.result ?? { type: "message", content: "done" };
  };
  return { runner };
}

function makeSnapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    endpoint: "/api/agent",
    tools: [],
    resolveToolCall: () => ({ toolCallId: "x", result: "ok" }),
    formatter: new ToolLabelFormatter(),
    sendStructuredMessages: false,
    conversation: [],
    displayMessages: [],
    createdAt: null,
    ...overrides,
  };
}

afterEach(async () => {
  // Backstop: abort anything a test left running so it can't leak into the next.
  abortAllTurns();
  await settle();
});

// ─── Acceptance criteria ─────────────────────────────────────

describe("turn-manager — background turns", () => {
  it("AC1: a turn started for A completes and its result is present on return", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    const { runner } = scriptedLoop({
      steps: [{ toolCalls: [callA], gate: Promise.resolve() }],
      finalGate: gate.promise,
      result: { type: "message", content: "answer for A", metadata: { ops: 1 } },
    });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "hi A");
    await settle();

    // Switch away (no subscriber). A keeps running.
    expect(getTurn(store, "A")?.status).toBe("running");

    gate.resolve();
    await settle();

    // Returned: record gone, store has the completed exchange.
    expect(getTurn(store, "A")).toBeUndefined();
    const saved = await store.load("A");
    expect(saved?.conversation).toEqual([
      { role: "user", content: "hi A" },
      { role: "assistant", content: "answer for A" },
    ]);
    // Thinking bubbles are transient — persisted display is user + assistant only.
    expect(saved?.displayMessages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi A"],
      ["assistant", "answer for A"],
    ]);
  });

  it("Q3: re-attaching mid-turn re-reads the record with no dropped/duplicated messages", async () => {
    const store = new MemorySessionStore();
    const g1 = makeDeferred();
    const g2 = makeDeferred();
    const { runner } = scriptedLoop({
      steps: [
        { toolCalls: [callA], gate: g1.promise },
        { toolCalls: [callB], gate: g2.promise },
      ],
      result: { type: "message", content: "final" },
    });

    let unsub = subscribeTurn(store, "A", () => undefined);
    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "hi");
    await settle();

    expect(getTurn(store, "A")!.displayMessages.map((m) => m.role)).toEqual([
      "user",
      "thinking",
    ]);

    // Switch AWAY, advance while gone.
    unsub();
    g1.resolve();
    await settle();

    // Switch BACK: the immediate snapshot equals the current record exactly —
    // nothing missed, nothing doubled.
    const reattached: LiveTurn[] = [];
    unsub = subscribeTurn(store, "A", (t) => {
      if (t) reattached.push(t);
    });
    expect(reattached).toHaveLength(1);
    expect(reattached[0]!.displayMessages).toEqual(getTurn(store, "A")!.displayMessages);
    expect(reattached[0]!.displayMessages.map((m) => m.role)).toEqual([
      "user",
      "thinking",
      "thinking",
    ]);

    g2.resolve();
    await settle();
    unsub();

    // No duplicate ids anywhere in the persisted display.
    const saved = await store.load("A");
    const ids = saved!.displayMessages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(saved!.displayMessages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "final"],
    ]);
  });

  it("AC3: concurrent turns on different sessions don't cross-contaminate", async () => {
    const store = new MemorySessionStore();
    const gA = makeDeferred();
    const gB = makeDeferred();
    const { runner: rA } = scriptedLoop({
      finalGate: gA.promise,
      result: { type: "message", content: "A!", metadata: { who: "A" } },
    });
    const { runner: rB } = scriptedLoop({
      finalGate: gB.promise,
      result: { type: "message", content: "B!", metadata: { who: "B" } },
    });

    const metaA: unknown[] = [];
    const metaB: unknown[] = [];
    startTurn(store, "A", makeSnapshot({ loopRunner: rA, onMetadata: (m) => metaA.push(m) }), "ask A");
    startTurn(store, "B", makeSnapshot({ loopRunner: rB, onMetadata: (m) => metaB.push(m) }), "ask B");
    await settle();

    expect(liveTurnSessionIds(store).sort()).toEqual(["A", "B"]);

    // Finish B first, then A — order must not bleed state across sessions.
    gB.resolve();
    await settle();
    gA.resolve();
    await settle();

    const sA = await store.load("A");
    const sB = await store.load("B");
    expect(sA!.conversation).toEqual([
      { role: "user", content: "ask A" },
      { role: "assistant", content: "A!" },
    ]);
    expect(sB!.conversation).toEqual([
      { role: "user", content: "ask B" },
      { role: "assistant", content: "B!" },
    ]);
    expect(metaA).toEqual([{ who: "A" }]);
    expect(metaB).toEqual([{ who: "B" }]);
  });

  it("AC2: subscribe/unsubscribe (tab switches) never aborts a running turn", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    const { runner } = scriptedLoop({
      finalGate: gate.promise,
      result: { type: "message", content: "done" },
    });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "hi");
    await settle();

    for (let i = 0; i < 3; i++) {
      const u = subscribeTurn(store, "A", () => undefined);
      u();
    }
    await settle();
    expect(getTurn(store, "A")?.status).toBe("running"); // survived the "switches"

    gate.resolve();
    await settle();
    // Reaching a persisted completion proves it was never aborted.
    const saved = await store.load("A");
    expect(saved?.conversation.at(-1)).toEqual({ role: "assistant", content: "done" });
  });

  it("AC4: a background turn that errors surfaces + persists the error and fires onTurnError", async () => {
    const store = new MemorySessionStore();
    const errors: Error[] = [];
    let terminal: LiveTurn | undefined;
    subscribeTurn(store, "A", (t) => {
      if (t && t.status !== "running") terminal = t;
    });
    const { runner } = scriptedLoop({ error: new Error("boom") });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner, onTurnError: (e) => errors.push(e) }), "hi");
    await settle();

    expect(getTurn(store, "A")).toBeUndefined(); // finalized + removed, no crash
    expect(terminal?.status).toBe("error");
    expect(terminal?.error?.message).toBe("boom");
    expect(errors.map((e) => e.message)).toEqual(["boom"]);

    const saved = await store.load("A");
    expect(saved!.displayMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Error: boom",
    });
    // The error bubble is display-only — never fed back into the conversation.
    expect(saved!.conversation).toEqual([]);
  });

  it("max_iterations appends the display-only max-steps bubble, not a conversation turn", async () => {
    const store = new MemorySessionStore();
    const metas: unknown[] = [];
    const { runner } = scriptedLoop({ result: { type: "max_iterations" } });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner, onMetadata: (m) => metas.push(m) }), "hi");
    await settle();

    const saved = await store.load("A");
    expect(saved!.displayMessages.at(-1)!.content).toContain("maximum number of steps");
    expect(saved!.conversation).toEqual([]); // not fed back to the model
    expect(metas).toEqual([undefined]); // onMetadata(undefined) preserved from useAgentChat
  });

  it("stop/abortTurn finalizes silently — no bubble, no conversation, no save, record removed", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    const errors: Error[] = [];
    const saveSpy = vi.spyOn(store, "save");
    const { runner } = scriptedLoop({
      finalGate: gate.promise,
      result: { type: "message", content: "unused" },
    });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner, onTurnError: (e) => errors.push(e) }), "hi");
    await settle();
    expect(getTurn(store, "A")?.status).toBe("running");

    abortTurn(store, "A");
    await settle();

    expect(getTurn(store, "A")).toBeUndefined();
    expect(saveSpy).not.toHaveBeenCalled(); // aborted turn is not a completed exchange
    expect(errors).toEqual([]); // abort is not an error
    expect(await store.load("A")).toBeNull();

    gate.resolve(); // resolving after abort is harmless
    await settle();
  });

  it("an AbortError-shaped failure that is NOT an explicit stop (e.g. SDK timeout) surfaces as an error", async () => {
    // The relay transport enforces a timeout by aborting its own controller,
    // producing a DOMException/AbortError identical in shape to a user stop().
    // Because the manager's OWN controller was never aborted, this must be treated
    // as a real failure — persisted + onTurnError — not silently discarded.
    const store = new MemorySessionStore();
    const errors: Error[] = [];
    const { runner } = scriptedLoop({
      error: new DOMException("The operation timed out.", "AbortError"),
    });

    startTurn(store, "A", makeSnapshot({ loopRunner: runner, onTurnError: (e) => errors.push(e) }), "hi");
    await settle();

    expect(errors).toHaveLength(1); // NOT swallowed as an explicit abort
    const saved = await store.load("A");
    expect(saved).not.toBeNull(); // persisted, unlike a real abort
    expect(saved!.displayMessages.at(-1)!.role).toBe("assistant");
    expect(saved!.displayMessages.at(-1)!.content).toContain("Error:");
  });

  it("per-session single-flight: a re-send while a turn is live is a no-op", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    let runs = 0;
    const runner: LoopRunner = async (_m, options) => {
      runs++;
      await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            reject(abortError());
          },
          { once: true },
        );
        gate.promise.then(resolve, (e: unknown) => {
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
      return { type: "message", content: "done" };
    };

    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "first");
    await settle();
    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "second"); // ignored
    await settle();

    expect(runs).toBe(1);
    expect(getTurn(store, "A")?.displayMessages.map((m) => m.content)).toEqual(["first"]);

    gate.resolve();
    await settle();
  });

  it("keys by (store, sessionId): the same id on different stores is isolated", async () => {
    const storeA = new MemorySessionStore();
    const storeB = new MemorySessionStore();
    const gate = makeDeferred();
    const { runner: r1 } = scriptedLoop({
      finalGate: gate.promise,
      result: { type: "message", content: "one" },
    });
    const { runner: r2 } = scriptedLoop({ result: { type: "message", content: "two" } });

    startTurn(storeA, "chat", makeSnapshot({ loopRunner: r1 }), "to A");
    startTurn(storeB, "chat", makeSnapshot({ loopRunner: r2 }), "to B");
    await settle();

    // Same sessionId, different stores → independent. B (ungated) finished; A runs.
    expect(getTurn(storeA, "chat")?.status).toBe("running");
    expect(getTurn(storeB, "chat")).toBeUndefined();
    expect((await store_load(storeB, "chat")).conversation.at(-1)).toEqual({
      role: "assistant",
      content: "two",
    });

    gate.resolve();
    await settle();
    expect((await store_load(storeA, "chat")).conversation.at(-1)).toEqual({
      role: "assistant",
      content: "one",
    });
  });

  it("subscribeBackgroundSessions reflects start→finish; unsubscribe stops updates", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    const snapshots: string[][] = [];
    const unsub = subscribeBackgroundSessions(store, (ids) =>
      snapshots.push([...ids].sort()),
    );
    expect(snapshots).toEqual([[]]); // primed immediately

    const { runner } = scriptedLoop({
      finalGate: gate.promise,
      result: { type: "message", content: "x" },
    });
    startTurn(store, "A", makeSnapshot({ loopRunner: runner }), "hi");
    await settle();
    expect(snapshots.at(-1)).toEqual(["A"]);

    gate.resolve();
    await settle();
    expect(snapshots.at(-1)).toEqual([]);

    unsub();
    const { runner: r2 } = scriptedLoop({ result: { type: "message", content: "y" } });
    startTurn(store, "B", makeSnapshot({ loopRunner: r2 }), "hi B");
    await settle();
    // No further pushes after unsubscribe.
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("F5: snapshots its execution context and passes { sessionId } to resolveToolCall", async () => {
    const store = new MemorySessionStore();
    const gate = makeDeferred();
    const ctxSeen: Array<{ sessionId?: string } | undefined> = [];
    const resolveToolCall = vi.fn((_call: ToolCall, ctx?: { sessionId?: string }) => {
      ctxSeen.push(ctx);
      return { toolCallId: "1", result: "ok" };
    });
    const { runner } = scriptedLoop({
      steps: [{ toolCalls: [callA], gate: Promise.resolve() }],
      finalGate: gate.promise,
      result: { type: "message", content: "done" },
    });

    const snap = makeSnapshot({ loopRunner: runner, resolveToolCall });
    startTurn(store, "sess-1", snap, "hi");
    // Mutate the caller-side conversation AFTER send — the running turn snapshotted
    // it, so this must not leak in.
    snap.conversation.push({ role: "user", content: "late edit" });
    await settle();

    expect(ctxSeen).toEqual([{ sessionId: "sess-1" }]);

    gate.resolve();
    await settle();
    const saved = await store.load("sess-1");
    expect(saved!.conversation).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });
});

/** Small helper: load a session and assert it exists (non-null) for terseness. */
async function store_load(store: MemorySessionStore, id: string) {
  const s = await store.load(id);
  expect(s).not.toBeNull();
  return s!;
}
