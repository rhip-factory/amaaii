"use client";

import styles from "./OfflineBanner.module.css";
import { WifiOffIcon } from "./icons";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import type { Language } from "@/lib/types";

interface OfflineBannerProps {
  language?: Language;
}

// Slim, honest truth-telling strip (P2-D design item 3) shown whenever
// navigator.onLine is false. Deliberately NOT coral: coral is reserved
// for the danger/escalation language used elsewhere in this app
// (HelpSheet, JournalCheckIn's escalation card) — being offline isn't an
// emergency, so this uses the same neutral lavender/deep chrome as the
// rest of the app shell.
export default function OfflineBanner({ language = "en" }: OfflineBannerProps) {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div className={styles.banner} role="status">
      <WifiOffIcon width={16} height={16} />
      <span>
        {language === "sw"
          ? "Huna mtandao — ukaguzi wako utahifadhiwa kwenye simu hii na kutumwa baadaye."
          : "You're offline — check-ins will be saved on this phone and sent later."}
      </span>
    </div>
  );
}
