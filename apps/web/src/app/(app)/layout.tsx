"use client";

import type { ReactNode } from "react";
import AppShell from "@/components/AppShell";
import { MeProvider } from "@/lib/MeContext";

// Shared shell (nav + help strip + sheet) for every authed tab. Auth
// itself is enforced inside AppShell via useSession() (redirects to
// /login when there's no token).
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <AppShell>{children}</AppShell>
    </MeProvider>
  );
}
