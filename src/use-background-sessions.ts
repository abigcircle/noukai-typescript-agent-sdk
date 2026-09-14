/**
 * useBackgroundSessions — React view of "which sessions have an in-flight
 * background turn" for a given store.
 *
 * Lives apart from `turn-manager.ts` (which is React-free) so importing the
 * manager's non-React API never pulls in React, and apart from `useAgentChat`
 * so a tab strip can observe background turns without instantiating a chat hook.
 * React is an optional peer; this module is only loaded by consumers that import
 * this hook.
 */

import { useEffect, useState } from "react";
import { subscribeBackgroundSessions } from "./turn-manager.js";
import type { ChatSessionStore } from "./session-store.js";

/**
 * Returns the sessionIds (for `store`) that currently have an in-flight
 * background turn. Re-renders when a turn starts or finishes. Pass the SAME
 * referentially-stable `store` you gave `useAgentChat` (memoize it).
 */
export function useBackgroundSessions(store: ChatSessionStore): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(
    () => subscribeBackgroundSessions(store, setIds),
    [store],
  );
  return ids;
}
