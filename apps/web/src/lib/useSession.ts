"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, getStoredUser, getToken } from "./storage";
import type { SessionUser } from "./types";

interface SessionState {
  user: SessionUser | null;
  token: string | null;
  /** true once we've checked localStorage (avoids a flash of protected UI) */
  ready: boolean;
}

/**
 * Client-side auth guard for the (app) route group. Redirects to /login
 * when there's no token. All protected pages are client components anyway
 * (the API lives behind a Bearer token in localStorage, so there is no
 * server-rendered "logged in" state to hydrate into).
 */
export function useSession(): SessionState {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ user: null, token: null, ready: false });

  useEffect(() => {
    const token = getToken();
    const user = getStoredUser();
    if (!token || !user) {
      router.replace("/login");
      return;
    }
    setState({ user, token, ready: true });
  }, [router]);

  return state;
}

export function useLogout(): () => void {
  const router = useRouter();
  return () => {
    clearSession();
    router.replace("/login");
  };
}
