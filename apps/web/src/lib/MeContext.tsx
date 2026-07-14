"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe } from "./api";
import { useSession } from "./useSession";
import type { MeResponse } from "./types";

interface MeContextValue {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch /me — call after a profile save so the rest of the app sees fresh data. */
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextValue>({
  me: null,
  loading: true,
  error: null,
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMe();
      setMe(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    refresh();
  }, [ready, refresh]);

  return <MeContext.Provider value={{ me, loading, error, refresh }}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  return useContext(MeContext);
}
