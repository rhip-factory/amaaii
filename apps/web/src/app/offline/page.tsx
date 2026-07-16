import Image from "next/image";
import styles from "./offline.module.css";

export const metadata = { title: "You're offline — Amaaii" };

// Served by the service worker as the navigation fallback when a fetch
// fails entirely offline. Deliberately has no client-side dependencies —
// it needs to render from the cached HTML alone.
export default function OfflinePage() {
  return (
    <main className={styles.wrap}>
      <Image src="/img/logo-mark-purple.png" alt="" width={56} height={56} priority />
      <h1 className={styles.title}>You&apos;re offline</h1>
      <p className={styles.body}>
        Amaaii still works on WhatsApp — message the same number and I&apos;ll reply as usual over SMS
        data. Reconnect here whenever you&apos;re back online.
      </p>
    </main>
  );
}
