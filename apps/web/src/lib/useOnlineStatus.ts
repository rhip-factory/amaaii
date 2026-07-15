"use client";

import { useEffect, useState } from "react";

// navigator.onLine, kept in React state via the 'online'/'offline'
// window events. This is deliberately the ONLY thing that drives the
// offline banner (AppShell/OfflineBanner) — connectivity truth-telling
// is a separate concern from whether any particular fetched screen is
// showing stale cached data (see offlineCache.ts's `stale` flag).
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    function goOnline() {
      setOnline(true);
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
