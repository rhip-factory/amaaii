"use client";

// P5-B: chrome for the two authed provider pages (panel + patient
// detail) — auth-gates via useProviderSession the same way AppShell
// gates the mother app via useSession, so every page under
// app/provider/(dashboard)/ gets the guard just by living inside this
// layout's tree.

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./ProviderShell.module.css";
import { LogoutIcon } from "./icons";
import { useProviderLogout, useProviderSession } from "@/lib/useProviderSession";

interface ProviderShellProps {
  children: ReactNode;
}

export default function ProviderShell({ children }: ProviderShellProps) {
  const { ready, provider } = useProviderSession();
  const logout = useProviderLogout();

  if (!ready) {
    return <div className={styles.shell} aria-busy="true" />;
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/provider" className={styles.brandRow}>
          <Image src="/img/logo-lockup-purple.png" alt="Amaaii" width={130} height={43} priority />
          <span className={styles.portalTag}>Provider portal</span>
        </Link>

        {provider && (
          <div className={styles.identity}>
            <span className={styles.facilityPill}>
              {provider.facility.name} · {provider.facility.code}
            </span>
            <span className={styles.providerName}>
              {provider.name}
              <span className={styles.role}>{provider.role}</span>
            </span>
            <button type="button" className={styles.signOutBtn} onClick={logout}>
              <LogoutIcon width={16} height={16} />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </header>

      <main className={styles.content}>{children}</main>
    </div>
  );
}
