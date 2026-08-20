"use client";

// Route group for the two authed provider pages (panel at /provider,
// patient detail at /provider/patient — the "(dashboard)" segment is
// invisible in the URL). Kept sibling-but-separate from
// app/provider/login/page.tsx so the login screen never gets wrapped in
// ProviderShell's authed chrome — same shape as the mother app's
// app/(app)/layout.tsx next to app/login/page.tsx.

import type { ReactNode } from "react";
import ProviderShell from "@/components/ProviderShell";

export default function ProviderDashboardLayout({ children }: { children: ReactNode }) {
  return <ProviderShell>{children}</ProviderShell>;
}
