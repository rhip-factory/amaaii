"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe } from "./api";
import { useSession } from "./useSession";
import type { MeResponse } from "./types";

interface MeContextValue {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  /** true when `me` came from the offline cache rather than a fresh /me response. */
  stale: boolean;
  /** Re-fetch /me — call after a profile save so the rest of the app sees fresh data. */
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextValue>({
  me: null,
  loading: true,
  error: null,
  stale: false,
  refresh: async () => {},
});

// One /me fetch shared by every (app) page + the AppShell (which needs
// the user's language for the help sheet copy). Avoids every tab
// re-fetching the same profile on mount.
export function MeProvider({ children }: { children: ReactNode }) {
  const { ready } = useSession();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, stale: isStale } = await fetchMe();
      setMe(data);
      setStale(isStale);
    } catch (err) {
      // No cache and no network (offlineCache.ts's OfflineNoDataError, or
      // a genuine fetch failure with nothing to fall back on) — surface
      // it, but `loading` still flips to false below so the UI never
      // spins forever waiting on a request that isn't coming back.
      setError(err instanceof Error ? err.message : "Could not load your profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    refresh();
  }, [ready, refresh]);

  // Stale-while-revalidate's "revalidate": once connectivity returns,
  // re-fetch so a page that's been sitting on cached data all along picks
  // up whatever changed server-side (P2-D design item 2).
  useEffect(() => {
    if (!ready) return;
    function onOnline() {
      refresh();
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [ready, refresh]);

  return <MeContext.Provider value={{ me, loading, error, stale, refresh }}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  return useContext(MeContext);
}
