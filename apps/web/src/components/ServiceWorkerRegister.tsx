"use client";

import { useEffect } from "react";

// Register the service worker only in production builds — during `next
// dev` a stale cached shell is more confusing than useful while iterating.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* best effort — the app still works without it */
      });
    });
  }, []);
  return null;
}
