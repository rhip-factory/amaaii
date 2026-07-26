"use client";

// P3-D: consent gate. Shown right after OTP login for a brand-new user
// (GET /me/consent -> needsConsent:true), and reachable any time the
// (app) route group's AppShell notices needsConsent has flipped back to
// true (useConsentGuard — e.g. CONSENT_VERSION was bumped and this
// user's prior grant is now stale). Two purposes, per the locked
// two-tier model in packages/core/src/consent.ts:
//   - data_processing: REQUIRED. Continue is disabled until it's checked.
//   - ai_responses: OPTIONAL. Declining it still lets the mother journal,
//     see her trends, and get urgent-symptom alerts — that's stated
//     plainly here so declining doesn't feel like it breaks the app.
// Neither box starts pre-checked (a version bump re-consent DOES restore
// a previously-active ai_responses choice — see the effect below — but a
// brand-new user sees two honest, unticked checkboxes; DPA-style consent
// should never be opt-out-by-default).
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "./consent.module.css";
import { ApiError, fetchConsent, submitConsent } from "@/lib/api";
import { getToken } from "@/lib/storage";
import { useLogout } from "@/lib/useSession";

export default function ConsentPage() {
  const router = useRouter();
  const logout = useLogout();

  const [checking, setChecking] = useState(true);
  const [isReconsent, setIsReconsent] = useState(false);
  const [dataProcessing, setDataProcessing] = useState(false);
  const [aiResponses, setAiResponses] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const consent = await fetchConsent();
        if (cancelled) return;
        if (!consent.needsConsent) {
          router.replace("/home");
          return;
        }
        setIsReconsent(consent.isStale);
        // Re-consent after a version bump: respect whatever this user
        // had previously chosen for the OPTIONAL purpose rather than
        // silently resetting it to off — they already made that choice
        // once. The REQUIRED purpose is never pre-checked either way
        // (see file header): they still have to actively re-affirm it.
        const priorAi = consent.purposes.find((p) => p.purpose === "ai_responses");
        if (priorAi?.granted) setAiResponses(true);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : "Could not check your consent status. Check your connection and try again."
          );
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onContinue() {
    if (!dataProcessing || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitConsent({ data_processing: true, ai_responses: aiResponses });
      router.replace("/home");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your choice. Please try again.");
      setSubmitting(false);
    }
  }

  if (checking) {
    return <div className={styles.page} aria-busy="true" />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Image
          src="/img/logo-lockup-purple.png"
          alt="Amaaii"
          width={148}
          height={49}
          className={styles.lockup}
          priority
        />
        <h1 className={styles.title}>
          {isReconsent ? "We've updated our privacy notice" : "Before we begin"}
        </h1>
        <p className={styles.lead}>
          {isReconsent
            ? "Please review these two choices to keep using Amaaii."
            : "Amaaii needs your permission for two things before it can support you."}
        </p>

        <div className={styles.consentItem}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={dataProcessing}
              onChange={(e) => setDataProcessing(e.target.checked)}
            />
            <span className={styles.checkText}>
              Store my health information so Amaaii works
              <span className={styles.tag}>Required</span>
            </span>
          </label>
          <p className={styles.itemBody}>
            We store your profile, journal check-ins, and conversation history so Amaaii can recognise
            patterns in how you&rsquo;re doing and watch for urgent danger signs. Without this, there&rsquo;s
            nothing for the app to work from.
          </p>
        </div>

        <div className={styles.consentItem}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={aiResponses}
              onChange={(e) => setAiResponses(e.target.checked)}
            />
            <span className={styles.checkText}>
              Use AI to give me personalised replies
              <span className={`${styles.tag} ${styles.tagOptional}`}>Optional</span>
            </span>
          </label>
          <p className={styles.itemBody}>
            Sends what you type to our AI provider to write a reply tailored to you (your phone number,
            full name, and other identifying details are stripped out first). Leave this off and you can
            still journal, see your trends, and get urgent-symptom alerts — you&rsquo;ll just get
            straightforward guidance instead of an AI-written reply.
          </p>
        </div>

        <Link href="/privacy" target="_blank" rel="noopener noreferrer" className={styles.privacyLink}>
          Read the full privacy notice ↗
        </Link>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className={styles.continueBtn}
          onClick={onContinue}
          disabled={!dataProcessing || submitting}
        >
          {submitting ? "Saving…" : "Continue"}
        </button>

        <button type="button" className={styles.signOutLink} onClick={logout}>
          Sign out instead
        </button>
      </div>
    </div>
  );
}
