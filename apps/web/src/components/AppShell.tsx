"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import styles from "./AppShell.module.css";
import HelpSheet from "./HelpSheet";
import { AlertIcon, ChatIcon, HomeIcon, InsightsIcon, JournalIcon, LogoutIcon, ProfileIcon } from "./icons";
import { useLogout, useSession } from "@/lib/useSession";
import { useMe } from "@/lib/MeContext";

const NAV_ITEMS = [
  { href: "/home", label: "Leo", Icon: HomeIcon },
  { href: "/chat", label: "Chat", Icon: ChatIcon },
  { href: "/journal", label: "Journal", Icon: JournalIcon },
  { href: "/insights", label: "Insights", Icon: InsightsIcon },
  { href: "/profile", label: "Profile", Icon: ProfileIcon },
] as const;

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const { ready, user } = useSession();
  const logout = useLogout();
  const pathname = usePathname();
  const { me } = useMe();
  const language = me?.user.language ?? "en";
  const [helpOpen, setHelpOpen] = useState(false);

  if (!ready) {
    return <div className={styles.shell} aria-busy="true" />;
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/home" className={styles.sidebarBrand}>
          <Image src="/img/logo-lockup-purple.png" alt="Amaaii" width={140} height={46} priority />
        </Link>
        <nav className={styles.sidebarNav} aria-label="Primary">
          {NAV_ITEMS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`${styles.navLink} ${pathname?.startsWith(href) ? styles.active : ""}`}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className={styles.sidebarFoot}>
          {user?.phone && <span className={styles.userBadge}>{user.phone.replace(/^whatsapp:/, "")}</span>}
          <button className={styles.ghostBtn} onClick={logout}>
            <LogoutIcon width={16} height={16} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <div className={styles.mainCol}>
        <header className={styles.topbar}>
          <Image src="/img/logo-lockup-purple.png" alt="Amaaii" width={110} height={36} className={styles.topbarLockup} priority />
          <button className={`${styles.ghostBtn} ${styles.iconOnly}`} onClick={logout} aria-label="Sign out">
            <LogoutIcon width={18} height={18} />
          </button>
        </header>

        <main className={styles.content}>{children}</main>

        <div className={styles.helpStrip}>
          <span className={styles.helpStripText}>
            <AlertIcon width={16} height={16} />
            Feeling unwell?
          </span>
          <button className={styles.helpStripBtn} onClick={() => setHelpOpen(true)}>
            Get help now
          </button>
        </div>

        <nav className={styles.bottomNav} aria-label="Primary">
          {NAV_ITEMS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`${styles.bnavLink} ${pathname?.startsWith(href) ? styles.active : ""}`}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
      </div>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} language={language} />
    </div>
  );
}
