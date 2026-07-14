"use client";

import { useEffect, useRef } from "react";
import styles from "./HelpSheet.module.css";
import { AlertIcon, CloseIcon, PhoneCallIcon } from "./icons";
import { CRISIS_TEL, DANGER_SIGN_LIST, EMERGENCY_COPY, EMERGENCY_TEL } from "@/lib/dangerSignsCopy";
import type { Language } from "@/lib/types";

interface HelpSheetProps {
  open: boolean;
  onClose: () => void;
  language?: Language;
}

export default function HelpSheet({ open, onClose, language = "en" }: HelpSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const copy = EMERGENCY_COPY[language];

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="help-sheet-title">
        <div className={styles.head}>
          <h2 id="help-sheet-title" className={styles.title}>
            {language === "sw" ? "Ukiona dalili hizi" : "If you notice these signs"}
          </h2>
          <button ref={closeRef} className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>
        <p className={styles.lead}>
          {language === "sw"
            ? "Tafuta huduma ya afya papo hapo ukiona dalili yoyote kati ya hizi — usisubiri."
            : "Get medical care right away if you notice any of these — don't wait it out."}
        </p>

        <div className={styles.listScroll}>
          <ul className={styles.list}>
            {DANGER_SIGN_LIST.map((sign) => (
              <li key={sign.en} className={styles.listItem}>
                <span className={styles.dot} aria-hidden="true" />
                {language === "sw" ? sign.sw : sign.en}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.emergencyBox}>
          <p className={styles.emergencyHeading}>
            <AlertIcon width={16} height={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            {copy.heading}
          </p>
          <p className={styles.emergencyBody}>{copy.body}</p>
          <div className={styles.callRow}>
            <a className={styles.callBtn} href={EMERGENCY_TEL}>
              <PhoneCallIcon width={16} height={16} />
              {language === "sw" ? "Piga 999" : "Call 999"}
            </a>
            <a className={`${styles.callBtn} ${styles.secondary}`} href={CRISIS_TEL}>
              <PhoneCallIcon width={16} height={16} />
              Befrienders Kenya
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
