"use client";

// P3-D: "Privacy & data" section of the Profile screen — consent status
// + AI toggle, the DPA transparency "who's accessed your data" activity
// list, data export, and account deletion. Kept as its own component
// (rather than inlined into profile/page.tsx) since it owns a fair bit
// of independent state across four sub-features that don't share data
// with the profile-edit form above it.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./PrivacySection.module.css";
import {
  ApiError,
  UnauthorizedError,
  deleteAccount,
  downloadMyData,
  fetchActivity,
  fetchConsent,
  revokeConsentPurpose,
  submitConsent,
} from "@/lib/api";
import { clearSession, setDeletedFlag } from "@/lib/storage";
import type { AuditEvent, ConsentResponse } from "@/lib/types";

const DELETE_CONFIRM_WORD = "DELETE";

// AuditEvent.created_at comes straight from SQLite's `datetime('now')`
// (see auditRepository.ts) — a bare "YYYY-MM-DD HH:MM:SS" string in UTC
// with NO timezone marker. `new Date()` on a string shaped like that is
// parsed as LOCAL time (no 'T'/'Z' means no offset info to the JS Date
// parser), which silently shifts every timestamp by the browser's UTC
// offset. That's not a rounding-error edge case here — Amaaii's actual
// market is Kenya (UTC+3/EAT), so every event would misreport itself as
// ~3 hours further in the past than it really is. Detect exactly that
// SQLite shape and treat it as UTC explicitly; anything already carrying
// a 'T'/'Z'/offset (e.g. a genuine `.toISOString()` value from
// elsewhere) passes through untouched.
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function parseServerTimestamp(raw: string): Date {
  const normalized = SQLITE_DATETIME_RE.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  return new Date(normalized);
}

function formatRelativeTime(iso: string): string {
  const then = parseServerTimestamp(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.round(month / 12);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}

function purposeLabel(purpose: unknown): string {
  if (purpose === "ai_responses") return "AI replies";
  if (purpose === "data_processing") return "storing your health data";
  return typeof purpose === "string" ? purpose : "a permission";
}

// Honest, human-readable phrasing for one audit row. actor is only ever
// 'system' (the deterministic danger-sign engine — see audit.ts's
// auditDangerEscalation) or the caller's own phone (every other
// recordAuditSafe call site in app.ts passes actor: userPhone) — so "who"
// only ever needs these two branches to stay truthful.
function describeEvent(e: AuditEvent): string {
  const who = e.actor === "system" ? "Amaaii" : "You";
  let metadata: Record<string, unknown> = {};
  if (e.metadata) {
    try {
      metadata = JSON.parse(e.metadata);
    } catch {
      /* malformed metadata shouldn't break the list — fall through with {} */
    }
  }
  switch (`${e.action}:${e.resource}`) {
    case "login:account":
      return "You signed in";
    case "read:profile":
      return "You viewed your profile";
    case "write:profile":
      return "You updated your profile";
    case "read:journal":
      return "You viewed your journal";
    case "write:journal":
      return "You saved a journal check-in";
    case "read:medical_history":
      return "You viewed your medical history";
    case "write:medical_history":
      return "You updated your medical history";
    case "read:insights":
      return "You viewed your insights";
    case "read:account":
      return "You viewed your account activity";
    case "export:account":
      return "You exported your data";
    case "delete:account":
      return "Your account and data were deleted";
    case "write:conversation":
      return "You sent a message";
    case "ai_call:conversation":
      return "AI generated a reply for you";
    case "consent_grant:consent":
      return `${who} agreed to ${purposeLabel(metadata.purpose)}`;
    case "consent_revoke:consent":
      return `${who} withdrew consent for ${purposeLabel(metadata.purpose)}`;
    case "danger_escalation:conversation":
      return "Amaaii flagged an urgent symptom in what you shared";
    default:
      return `${who} — ${e.action.replace(/_/g, " ")} (${e.resource.replace(/_/g, " ")})`;
  }
}

type DeleteStep = "idle" | "confirming" | "deleting";

export default function PrivacySection() {
  const router = useRouter();

  const [consent, setConsent] = useState<ConsentResponse | null>(null);
  const [consentLoading, setConsentLoading] = useState(true);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [aiSaving, setAiSaving] = useState(false);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDone, setExportDone] = useState(false);

  const [deleteStep, setDeleteStep] = useState<DeleteStep>("idle");
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setConsentLoading(true);
      try {
        setConsent(await fetchConsent());
        setConsentError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) return;
        setConsentError(err instanceof ApiError ? err.message : "Could not load your consent status.");
      } finally {
        setConsentLoading(false);
      }
    })();

    (async () => {
      setActivityLoading(true);
      try {
        const { events: rows } = await fetchActivity();
        setEvents(rows);
        setActivityError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) return;
        setActivityError(err instanceof ApiError ? err.message : "Could not load your activity.");
      } finally {
        setActivityLoading(false);
      }
    })();
  }, []);

  const dataProcessingActive =
    consent?.purposes.find((p) => p.purpose === "data_processing")?.active ?? false;
  const aiActive = consent?.purposes.find((p) => p.purpose === "ai_responses")?.active ?? false;

  async function onToggleAi() {
    if (aiSaving || !consent) return;
    setAiSaving(true);
    setConsentError(null);
    try {
      const updated = aiActive
        ? await revokeConsentPurpose("ai_responses")
        : await submitConsent({ ai_responses: true });
      setConsent(updated);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setConsentError(err instanceof ApiError ? err.message : "Could not update your AI preference. Please try again.");
    } finally {
      setAiSaving(false);
    }
  }

  async function onExport() {
    setExporting(true);
    setExportError(null);
    setExportDone(false);
    try {
      await downloadMyData();
      setExportDone(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setExportError(
        err instanceof ApiError ? err.message : "Could not download your data. Check your connection and try again."
      );
    } finally {
      setExporting(false);
    }
  }

  function startDelete() {
    setDeleteStep("confirming");
    setDeleteInput("");
    setDeleteError(null);
  }

  function cancelDelete() {
    setDeleteStep("idle");
    setDeleteInput("");
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (deleteInput.trim().toUpperCase() !== DELETE_CONFIRM_WORD) return;
    setDeleteStep("deleting");
    setDeleteError(null);
    try {
      await deleteAccount();
      // P3-C flagged that the stateless bearer token still resolves after
      // server-side erasure, and /me-family routes would otherwise
      // resurrect a blank profile via getOrCreateUser. Client-side
      // mitigation (server-side hardening is deferred — see P3-E):
      // clear the session immediately and never fetch again.
      setDeletedFlag();
      clearSession();
      router.replace("/login");
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setDeleteError(
        err instanceof ApiError ? err.message : "Could not delete your account. Check your connection and try again."
      );
      setDeleteStep("confirming");
    }
  }

  return (
    <div className={styles.wrap}>
      <h2 className={styles.sectionTitle}>Privacy &amp; data</h2>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Your consent</h3>
          {consent && <span className={styles.versionTag}>Notice v{consent.version}</span>}
        </div>

        {consentLoading && !consent ? (
          <p className={styles.muted}>Loading…</p>
        ) : (
          <>
            <div className={styles.consentRow}>
              <div>
                <p className={styles.consentLabel}>Store my health information</p>
                <p className={styles.consentSub}>Required — this is what makes Amaaii work.</p>
              </div>
              <span className={styles.statusPill}>{dataProcessingActive ? "Active" : "Needs attention"}</span>
            </div>

            <div className={styles.consentRow}>
              <div>
                <p className={styles.consentLabel}>Use AI for personalised replies</p>
                <p className={styles.consentSub}>Optional — off still keeps journaling and danger alerts.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={aiActive}
                aria-label="Use AI for personalised replies"
                className={`${styles.switch} ${aiActive ? styles.switchOn : ""}`}
                onClick={onToggleAi}
                disabled={aiSaving || consentLoading}
              >
                <span className={styles.switchKnob} />
              </button>
            </div>
          </>
        )}

        {consentError && <p className={styles.errorText}>{consentError}</p>}

        <Link href="/privacy" target="_blank" rel="noopener noreferrer" className={styles.link}>
          Read the privacy notice ↗
        </Link>
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Who&rsquo;s accessed your data</h3>
        {activityLoading && events.length === 0 ? (
          <p className={styles.muted}>Loading…</p>
        ) : events.length === 0 ? (
          <p className={styles.muted}>No recorded activity yet.</p>
        ) : (
          <ul className={styles.activityList}>
            {events.slice(0, 20).map((e) => (
              <li key={e.id} className={styles.activityItem}>
                <span className={styles.activityText}>{describeEvent(e)}</span>
                <span className={styles.activityTime}>{formatRelativeTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
        {activityError && <p className={styles.errorText}>{activityError}</p>}
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Export my data</h3>
        <p className={styles.muted}>Download everything Amaaii holds about you as a single file.</p>
        <button type="button" className={styles.secondaryBtn} onClick={onExport} disabled={exporting}>
          {exporting ? "Preparing…" : "Export my data"}
        </button>
        {exportDone && <p className={styles.successText}>Downloaded ✓</p>}
        {exportError && <p className={styles.errorText}>{exportError}</p>}
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Delete my account</h3>
        <p className={styles.muted}>
          Permanently deletes your profile, journal history, conversations, and consent records. This
          cannot be undone.
        </p>

        {deleteStep === "idle" && (
          <button type="button" className={styles.dangerOutlineBtn} onClick={startDelete}>
            Delete my account
          </button>
        )}

        {deleteStep !== "idle" && (
          <div className={styles.confirmBox}>
            <p className={styles.confirmLead}>
              Type <strong>{DELETE_CONFIRM_WORD}</strong> to confirm. Everything you&rsquo;ve shared with
              Amaaii will be permanently removed — there is no undo.
            </p>
            <input
              type="text"
              className={styles.confirmInput}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              placeholder={DELETE_CONFIRM_WORD}
              autoFocus
              disabled={deleteStep === "deleting"}
              aria-label={`Type ${DELETE_CONFIRM_WORD} to confirm account deletion`}
            />
            {deleteError && <p className={styles.errorText}>{deleteError}</p>}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={cancelDelete}
                disabled={deleteStep === "deleting"}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.dangerConfirmBtn}
                onClick={confirmDelete}
                disabled={deleteStep === "deleting" || deleteInput.trim().toUpperCase() !== DELETE_CONFIRM_WORD}
              >
                {deleteStep === "deleting" ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
