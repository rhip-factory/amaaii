"use client";

// Shared /insights read (P2-E) for the Insights tab + the Home trends
// card. Goes through offlineCache's stale-while-revalidate path
// (fetchInsights), so:
//  - offline: last-known insights render immediately, marked stale;
//  - a window switch keeps the PREVIOUS render on screen (dimmed by the
//    caller via `fetching`) instead of flashing a skeleton — dataviz
//    interaction rule "refetch keeps the frame";
//  - if a switch fails with nothing cached for that window, `data`
//    resets to null rather than mislabeling the old window's series.

import { useCallback, useEffect, useState } from "react";
import { fetchInsights } from "./api";
import { OfflineNoDataError } from "./offlineCache";
import type { InsightsResponse, InsightsWindow } from "./types";

interface UseInsightsResult {
  data: InsightsResponse | null;
  /** true when `data` came from the offline cache, not a fresh response. */
  stale: boolean;
  /** true while a (re)fetch is in flight — callers dim, never unmount. */
  fetching: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useInsights(days: InsightsWindow): UseInsightsResult {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setFetching(true);
    setError(null);
    try {
      const result = await fetchInsights(days);
      setData(result.data);
      setStale(result.stale);
    } catch (err) {
      // Nothing fetched AND nothing cached for this window — showing the
      // previous window's charts under the new window label would lie, so
      // clear instead.
      setData(null);
      setStale(false);
      setError(
        err instanceof OfflineNoDataError
          ? "Nothing saved on this phone for this window yet — reconnect to load it."
          : "Could not load your trends. Please try again."
      );
    } finally {
      setFetching(false);
    }
  }, [days]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Stale-while-revalidate's "revalidate": refresh when connectivity returns.
  useEffect(() => {
    function onOnline() {
      reload();
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [reload]);

  return { data, stale, fetching, error, reload };
}
