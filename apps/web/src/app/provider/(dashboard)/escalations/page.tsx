"use client";

// P6: escalation feed — every danger-sign escalation across this
// facility's enrolled AND consented mothers, newest first, with a
// persistent Acknowledge action. Reuses the existing `danger_escalation`
// audit trail as its source (see audit.ts#auditDangerEscalation on the
// backend — critical/high only by construction), NOT a second store.
//
// Acknowledged items stay visible but de-emphasised (opacity + muted
// copy) — never hidden. Hiding an acknowledged escalation would make
// this feed lie about what actually happened to a mother who was, say,
// critical last week; a midwife reviewing the week needs the full
// record, just with the handled ones visually receding.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import UrgencyBadge from "@/components/UrgencyBadge";
import { CheckIcon } from "@/components/icons";
import { ProviderApiError, ackEscalation, fetchProviderEscalations } from "@/lib/providerApi";
import { formatDateTime, stripWhatsappPrefix } from "@/lib/providerFormat";
import type { ProviderEscalationFeedItem } from "@/lib/providerTypes";
import { useProviderSession } from "@/lib/useProviderSession";
import styles from "./escalations.module.css";

// The natural key is (phone, createdAt) — mirrors escalation_acks'
// UNIQUE(facility_id, user_phone, escalation_at) on the backend.
function itemKey(item: ProviderEscalationFeedItem): string {
  return `${item.phone}|${item.createdAt}`;
}

export default function EscalationsPage() {
  const { provider } = useProviderSession();
  const [items, setItems] = useState<ProviderEscalationFeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ackingKey, setAckingKey] = useState<string | null>(null);
  const [ackError, setAckError] = useState<{ key: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProviderEscalations();
      // Defensive re-sort, newest first — don't trust wire order (same
      // discipline as providerApi.ts's normalizeDailySeries).
      setItems([...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)));
    } catch (err) {
      setError(
        err instanceof ProviderApiError ? err.message : "Could not load the escalation feed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAck(item: ProviderEscalationFeedItem) {
    const key = itemKey(item);
    if (ackingKey) return;
    setAckError(null);
    setAckingKey(key);
    try {
      const res = await ackEscalation(item.phone, item.createdAt);
      setItems((prev) =>
        prev
          ? prev.map((it) =>
              itemKey(it) === key
                ? {
                    ...it,
                    acknowledged: res.acknowledged ?? true,
                    acknowledgedBy: res.acknowledgedBy ?? provider?.id ?? null,
                    acknowledgedAt: res.acknowledgedAt ?? new Date().toISOString(),
                  }
                : it
            )
          : prev
      );
    } catch (err) {
      setAckError({
        key,
        message:
          err instanceof ProviderApiError
            ? err.message
            : "Could not acknowledge this escalation. Please try again.",
      });
    } finally {
      setAckingKey(null);
    }
  }

  return (
    <PageContainer
      title="Escalation feed"
      subhead="Danger-sign escalations across your consented patients, newest first."
    >
      <div className={styles.stack}>
        {error && <p className={styles.errorNote}>{error}</p>}

        {loading && !items && <div className={styles.skeleton} aria-hidden="true" />}

        {items && items.length === 0 && (
          <div className={styles.emptyCard}>
            <p className={styles.emptyTitle}>No escalations yet</p>
            <p className={styles.emptyBody}>
              Critical or high-urgency danger signs from your consented patients will appear here as soon as
              they&rsquo;re detected.
            </p>
          </div>
        )}

        {items && items.length > 0 && (
          <ul className={styles.list}>
            {items.map((item) => {
              const key = itemKey(item);
              const isSelf = provider != null && item.acknowledgedBy === provider.id;
              return (
                <li
                  key={key}
                  className={`${styles.item} ${item.acknowledged ? styles.itemAcked : ""}`}
                >
                  <div className={styles.itemMain}>
                    <UrgencyBadge urgency={item.urgency} />
                    <div className={styles.motherCell}>
                      <Link
                        href={`/provider/patient?phone=${encodeURIComponent(item.phone)}`}
                        className={styles.motherName}
                      >
                        {item.displayName}
                      </Link>
                      <span className={styles.motherPhone}>{stripWhatsappPrefix(item.phone)}</span>
                    </div>
                    <span className={styles.when}>{formatDateTime(item.createdAt)}</span>
                  </div>

                  <div className={styles.itemAction}>
                    {item.acknowledged ? (
                      <span className={styles.ackedNote}>
                        <CheckIcon width={13} height={13} />
                        Acknowledged{isSelf ? " by you" : ""}
                        {item.acknowledgedAt ? ` · ${formatDateTime(item.acknowledgedAt)}` : ""}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.ackBtn}
                        disabled={ackingKey === key}
                        onClick={() => handleAck(item)}
                      >
                        {ackingKey === key ? "Acknowledging…" : "Acknowledge"}
                      </button>
                    )}
                    {ackError && ackError.key === key && (
                      <p className={styles.ackError} role="alert">
                        {ackError.message}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PageContainer>
  );
}
