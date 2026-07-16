"use client";

import type { ReactNode } from "react";
import AppShell from "@/components/AppShell";
import { MeProvider } from "@/lib/MeContext";
import { OutboxProvider } from "@/lib/OutboxContext";

// Shared shell (nav + help strip + sheet) for every authed tab. Auth
// itself is enforced inside AppShell via useSession() (redirects to
// /login when there's no token).
//
// OutboxProvider (P2-D) is mounted here, not just inside JournalCheckIn,
// so a queued check-in flushes on app start / 'online' regardless of
// which tab is open — it shouldn't need the Journal tab visible to sync.
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <OutboxProvider>
        <AppShell>{children}</AppShell>
      </OutboxProvider>
    </MeProvider>
  );
}
