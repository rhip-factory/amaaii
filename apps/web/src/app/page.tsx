"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/storage";

// Entry route: bounces to /home if a session token exists, /login otherwise.
// There's no server-rendered auth state to hydrate into (the token lives
// in localStorage), so this is unavoidably a client-side redirect.
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getToken() ? "/home" : "/login");
  }, [router]);

  return <div style={{ minHeight: "100dvh", background: "var(--shell-bg)" }} aria-busy="true" />;
}
