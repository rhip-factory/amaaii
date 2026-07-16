"use client";

import { useEffect } from "react";

// Register the service worker only in production builds — during `next
// dev` a stale cached shell is more confusing than useful while iterating.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* best effort — the app still works without it */
      });
    };
    // P2-F fix: this effect runs after hydration, which on a fast load is
    // AFTER the window 'load' event has already fired — a listener added
    // then never fires, so the SW silently never registered. Register
    // immediately in that case; only defer to 'load' when it's still
    // pending (the original intent: don't compete with initial paint).
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
