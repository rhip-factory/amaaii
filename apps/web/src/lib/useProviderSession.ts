"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearProviderSession, getProviderToken, getStoredProvider } from "./providerStorage";
import type { ProviderSessionUser } from "./providerTypes";

interface ProviderSessionState {
  provider: ProviderSessionUser | null;
  token: string | null;
  /** true once we've checked localStorage (avoids a flash of protected UI) */
  ready: boolean;
}

/**
 * Client-side auth guard for the provider dashboard route group, exactly
 * mirroring lib/useSession.ts's mother-app guard — but reading/redirecting
 * against the SEPARATE provider token store, never the mother one.
 */
export function useProviderSession(): ProviderSessionState {
  const router = useRouter();
  const [state, setState] = useState<ProviderSessionState>({ provider: null, token: null, ready: false });

  useEffect(() => {
    const token = getProviderToken();
    const provider = getStoredProvider();
    if (!token || !provider) {
      router.replace("/provider/login");
      return;
    }
    setState({ provider, token, ready: true });
  }, [router]);

  return state;
}

export function useProviderLogout(): () => void {
  const router = useRouter();
  return () => {
    clearProviderSession();
    router.replace("/provider/login");
  };
}
