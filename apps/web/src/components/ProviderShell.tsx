"use client";

// P5-B: chrome for the authed provider pages — auth-gates via
// useProviderSession the same way AppShell gates the mother app via
// useSession, so every page under app/provider/(dashboard)/ gets the
// guard just by living inside this layout's tree.
//
// P6 added the nav row between Panel / Escalations / Cohort — three
// pages, not two, so this stopped being a single "table + back link"
// portal and needed real primary navigation for the first time. Kept as
// simple underline tabs (not a sidebar like AppShell's — this shell is
// still single-column) so it reads clearly on a projector without
// competing with the topbar's already-pill-heavy identity chrome.

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./ProviderShell.module.css";
import { AlertIcon, InsightsIcon, LogoutIcon, UsersIcon } from "./icons";
import { useProviderLogout, useProviderSession } from "@/lib/useProviderSession";

interface ProviderShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { href: "/provider", label: "Patients", Icon: UsersIcon },
  { href: "/provider/escalations", label: "Escalations", Icon: AlertIcon },
  { href: "/provider/cohort", label: "Cohort", Icon: InsightsIcon },
] as const;

// The panel ("/provider") and the query-param patient detail page
// ("/provider/patient") both belong to the "Patients" tab, so a plain
// `pathname?.startsWith(href)` (AppShell's approach) would be wrong here:
// "/provider" is a PREFIX of every other tab's path too. Each item needs
// its own exact/near-exact match instead.
function isNavActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/provider") return pathname === "/provider" || pathname.startsWith("/provider/patient");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function ProviderShell({ children }: ProviderShellProps) {
  const { ready, provider } = useProviderSession();
  const logout = useProviderLogout();
  const pathname = usePathname();

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

      <nav className={styles.nav} aria-label="Provider portal">
        {NAV_ITEMS.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.navLink} ${isNavActive(pathname, href) ? styles.navLinkActive : ""}`}
            aria-current={isNavActive(pathname, href) ? "page" : undefined}
          >
            <Icon width={16} height={16} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>

      <main className={styles.content}>{children}</main>
    </div>
  );
}
