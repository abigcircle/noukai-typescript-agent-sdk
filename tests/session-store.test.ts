import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session-store.js";
import type { ChatSession } from "../src/session-store.js";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "s1",
    conversation: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
    displayMessages: [
      { id: "msg-1", role: "user", content: "hello", timestamp: 1 },
      { id: "msg-2", role: "assistant", content: "hi there", timestamp: 2 },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemorySessionStore", () => {
  it("round-trips a saved session", async () => {
    const store = new MemorySessionStore();
    const s = session();
    await store.save(s);
    expect(await store.load("s1")).toEqual(s);
  });

  it("returns null for an unknown session", async () => {
    const store = new MemorySessionStore();
    expect(await store.load("nope")).toBeNull();
  });

  it("isolates the stored copy — mutating a loaded session doesn't leak into a later load", async () => {
    const store = new MemorySessionStore();
    await store.save(session());

    const first = await store.load("s1");
    // Mutate the returned object as a careless caller might.
    first!.conversation.push({ role: "user", content: "injected" });
    first!.displayMessages[0]!.content = "tampered";
    first!.updatedAt = "3000-01-01T00:00:00.000Z";

    const second = await store.load("s1");
    expect(second!.conversation).toHaveLength(2);
    expect(second!.displayMessages[0]!.content).toBe("hello");
    expect(second!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("isolates the stored copy — mutating the saved object after save doesn't leak into a load", async () => {
    const store = new MemorySessionStore();
    const s = session();
    await store.save(s);
    // Mutate the object the caller still holds after handing it to save().
    s.conversation.push({ role: "user", content: "late edit" });

    const loaded = await store.load("s1");
    expect(loaded!.conversation).toHaveLength(2);
  });

  it("upserts on save (same id overwrites)", async () => {
    const store = new MemorySessionStore();
    await store.save(session());
    await store.save(session({ conversation: [{ role: "user", content: "changed" }] }));
    const loaded = await store.load("s1");
    expect(loaded?.conversation).toEqual([{ role: "user", content: "changed" }]);
  });

  it("delete removes a session and is a no-op for a missing one", async () => {
    const store = new MemorySessionStore();
    await store.save(session());
    await store.delete("s1");
    expect(await store.load("s1")).toBeNull();
    await expect(store.delete("s1")).resolves.toBeUndefined(); // no throw
  });

  it("list summarizes without the heavy arrays; title = first user turn", async () => {
    const store = new MemorySessionStore();
    await store.save(session());
    await store.save(
      session({
        sessionId: "s2",
        conversation: [
          { role: "user", content: "make it kinder" },
          { role: "assistant", content: "done" },
          { role: "user", content: "again" },
        ],
      }),
    );
    const summaries = await store.list();
    expect(summaries).toHaveLength(2);
    const s2 = summaries.find((x) => x.sessionId === "s2")!;
    expect(s2.title).toBe("make it kinder"); // first user turn
    expect(s2.messageCount).toBe(2); // two user turns
    expect(s2).not.toHaveProperty("conversation");
    expect(s2).not.toHaveProperty("displayMessages");
  });

  it("list title falls back to 'New chat' when there is no user turn", async () => {
    const store = new MemorySessionStore();
    await store.save(session({ conversation: [], displayMessages: [] }));
    const [only] = await store.list();
    expect(only!.title).toBe("New chat");
    expect(only!.messageCount).toBe(0);
  });
});
