/**
 * session-sync — pure decision logic for useAgentChat's persistence effects.
 *
 * The hook's load/save machinery — load-on-sessionId-change, load supersession,
 * the save-gate, and the A3 dirty-flag — is expressed here as small pure
 * predicates so it can be unit-tested without React (no `renderHook`). The hook
 * owns the refs/state and the side effects; the *decisions* live here.
 */

/** Inputs to the save-gate decision. */
export interface SaveGateInput {
  /** The sessionId whose data currently populates messages/conversation. */
  hydratedId: string | undefined;
  /** The sessionId the hook is currently bound to. */
  activeSessionId: string | undefined;
  /** Whether a turn is in flight. */
  isLoading: boolean;
  /** Whether the conversation has un-persisted mutations since the last load. */
  isDirty: boolean;
  /** Count of persistable items (non-thinking display messages + conversation turns). */
  messageCount: number;
}

/**
 * Whether the save effect should persist the current session.
 *
 * Blocks a write when:
 *   - the active session isn't the one currently hydrated (the tab-switch
 *     window, before the new session's load lands);
 *   - a turn is in flight;
 *   - nothing has mutated the conversation since the last load (A3 — merely
 *     opening a session must not re-save it with a fresh `updatedAt`);
 *   - there is nothing to persist (a fresh or just-cleared session).
 */
export function shouldSaveSession({
  hydratedId,
  activeSessionId,
  isLoading,
  isDirty,
  messageCount,
}: SaveGateInput): boolean {
  if (hydratedId !== activeSessionId) return false;
  if (isLoading) return false;
  if (!isDirty) return false;
  if (messageCount === 0) return false;
  return true;
}

/** Inputs to the load-supersession check. */
export interface StaleLoadInput {
  /** The load-sequence token captured when this load() started. */
  loadSeqAtStart: number;
  /** The hook's current load-sequence token. */
  currentLoadSeq: number;
}

/**
 * Whether a resolved load() should be ignored because a newer sessionId change
 * superseded it. Each load captures the load-sequence token at its start; if the
 * token has since advanced, a later load is authoritative and this one is stale.
 */
export function isStaleLoad({
  loadSeqAtStart,
  currentLoadSeq,
}: StaleLoadInput): boolean {
  return loadSeqAtStart !== currentLoadSeq;
}
