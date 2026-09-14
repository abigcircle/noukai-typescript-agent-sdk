import { describe, expect, it } from "vitest";
import { shouldSaveSession, isStaleLoad } from "../src/session-sync.js";
import type { SaveGateInput } from "../src/session-sync.js";

// A "ready to save" baseline: hydrated session matches the active one, no turn
// in flight, a real mutation happened, and there is content to persist.
function saveGate(overrides: Partial<SaveGateInput> = {}): SaveGateInput {
  return {
    hydratedId: "s1",
    activeSessionId: "s1",
    isLoading: false,
    isDirty: true,
    messageCount: 2,
    ...overrides,
  };
}

describe("isStaleLoad (load supersession)", () => {
  it("(a) ignores a load whose sequence token was superseded", () => {
    expect(isStaleLoad({ loadSeqAtStart: 1, currentLoadSeq: 2 })).toBe(true);
  });

  it("(a) accepts a load that is still the latest", () => {
    expect(isStaleLoad({ loadSeqAtStart: 2, currentLoadSeq: 2 })).toBe(false);
  });
});

describe("shouldSaveSession (save-gate)", () => {
  it("saves when hydrated, settled, dirty, and non-empty", () => {
    expect(shouldSaveSession(saveGate())).toBe(true);
  });

  it("(b) blocks writes while a turn is in flight", () => {
    expect(shouldSaveSession(saveGate({ isLoading: true }))).toBe(false);
  });

  it("(b) blocks writes during a hydration-id mismatch (tab-switch window)", () => {
    expect(
      shouldSaveSession(saveGate({ hydratedId: "s1", activeSessionId: "s2" })),
    ).toBe(false);
  });

  it("(c) does not re-save immediately after opening a session (not dirty)", () => {
    // Right after a load hydrates state, isDirty is false → opening a session
    // must not bump its updatedAt / trigger a write.
    expect(shouldSaveSession(saveGate({ isDirty: false }))).toBe(false);
  });

  it("(c) saves once a real mutation marks the conversation dirty", () => {
    expect(shouldSaveSession(saveGate({ isDirty: true }))).toBe(true);
  });

  it("(d) does not persist an empty conversation", () => {
    expect(shouldSaveSession(saveGate({ messageCount: 0 }))).toBe(false);
  });

  it("(d) an empty conversation is skipped even when marked dirty (post-clear)", () => {
    // clearChat marks the state dirty but empties it; the empty-content guard
    // still prevents re-saving over the delete().
    expect(
      shouldSaveSession(saveGate({ isDirty: true, messageCount: 0 })),
    ).toBe(false);
  });
});
