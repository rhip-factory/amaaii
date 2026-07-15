"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { addToOutbox, flushOutbox, getOutboxItems, type FlushSummary, type OutboxItem } from "./outbox";
import { submitJournalEntry } from "./api";
import type { JournalEntryInput } from "./types";

interface DroppedNotice {
  clientEntryId: string;
  message: string;
}

interface OutboxContextValue {
  pendingItems: OutboxItem[];
  /** Bumped whenever a flush finishes having synced >=1 item — screens
   * showing a "waiting to sync" badge watch this to know when to
   * re-fetch server state and drop the badge (design item 3). */
  syncedVersion: number;
  /** Queue a submission that failed to reach the network. */
  queue: (payload: JournalEntryInput) => Promise<void>;
  flush: () => Promise<FlushSummary>;
  droppedNotice: DroppedNotice | null;
  dismissDroppedNotice: () => void;
}

const OutboxContext = createContext<OutboxContextValue | null>(null);

const noopValue: OutboxContextValue = {
  pendingItems: [],
  syncedVersion: 0,
  queue: async () => {},
  flush: async () => ({ synced: [], dropped: [], remaining: 0 }),
  droppedNotice: null,
  dismissDroppedNotice: () => {},
};

// Mounted once per authed session (see (app)/layout.tsx) so the outbox is
// flushed on app start / 'online' regardless of which tab the mother
// happens to be on — a queued check-in shouldn't need the Journal tab
// open to sync.
export function OutboxProvider({ children }: { children: ReactNode }) {
  const [pendingItems, setPendingItems] = useState<OutboxItem[]>([]);
  const [syncedVersion, setSyncedVersion] = useState(0);
  const [droppedNotice, setDroppedNotice] = useState<DroppedNotice | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      setPendingItems(await getOutboxItems());
    } catch {
      /* best effort — the queue still works, just without a live count */
    }
  }, []);

  const flush = useCallback(async (): Promise<FlushSummary> => {
    const summary = await flushOutbox({
      submit: submitJournalEntry,
      onItemDropped: (item, message) => setDroppedNotice({ clientEntryId: item.clientEntryId, message }),
    });
    await refreshPending();
    if (summary.synced.length > 0) setSyncedVersion((v) => v + 1);
    return summary;
  }, [refreshPending]);

  const queue = useCallback(
    async (payload: JournalEntryInput) => {
      await addToOutbox(payload);
      await refreshPending();
    },
    [refreshPending]
  );

  useEffect(() => {
    refreshPending();
    void flush(); // app start (design item 1's third flush trigger)

    function onOnline() {
      void flush();
    }
    window.addEventListener("online", onOnline);

    // Wakes on the service worker's Background Sync 'sync' event (see
    // public/sw.js) — the SW can't perform the authenticated POST itself
    // (no access to the bearer token in localStorage), so it just pings
    // any open tab to run this same flush.
    function onSwMessage(event: MessageEvent) {
      if (event.data?.type === "amaaii-flush-outbox") void flush();
    }
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
    }

    return () => {
      window.removeEventListener("online", onOnline);
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onSwMessage);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring
  }, []);

  const dismissDroppedNotice = useCallback(() => setDroppedNotice(null), []);

  return (
    <OutboxContext.Provider value={{ pendingItems, syncedVersion, queue, flush, droppedNotice, dismissDroppedNotice }}>
      {children}
    </OutboxContext.Provider>
  );
}

export function useOutbox(): OutboxContextValue {
  // Defensive default (rather than throwing) so a consumer rendered
  // outside the provider degrades to "no queue" instead of crashing the
  // page — matches the rest of this app's "never crash offline" goal.
  return useContext(OutboxContext) ?? noopValue;
}
