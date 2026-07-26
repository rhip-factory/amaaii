"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./login.module.css";
import { OtpError, requestOtp, verifyOtp } from "@/lib/authOtp";
import { fetchConsent } from "@/lib/api";
import { setSession, getToken, consumeDeletedFlag } from "@/lib/storage";

type Step = "phone" | "code";

// Client-side resend cooldown — a friendly nudge distinct from the
// server's real rate limit (3 sends/hour, see POST /auth/otp/request).
// If the server ever returns a longer wait (429 rate_limited), that wins
// — see the retryAfterSeconds handling below.
const RESEND_COOLDOWN_SECONDS = 60;

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [deletedNotice, setDeletedNotice] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Already signed in? Skip straight to the app.
  useEffect(() => {
    if (getToken()) router.replace("/home");
  }, [router]);

  // P3-D: a one-shot "your account and data have been deleted"
  // confirmation, set by the Profile page's delete flow right before it
  // clears the session and redirects here. consumeDeletedFlag() clears
  // the flag on read, so refreshing /login afterwards doesn't re-show it.
  useEffect(() => {
    if (consumeDeletedFlag()) setDeletedNotice(true);
  }, []);

  // Countdown tick for the resend cooldown.
  useEffect(() => {
    if (!cooldownEndsAt) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownEndsAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) setCooldownEndsAt(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownEndsAt]);

  useEffect(() => {
    if (step === "code") codeInputRef.current?.focus();
  }, [step]);

  async function sendCode(targetPhone: string): Promise<boolean> {
    setError(null);
    try {
      const { devCode: dev } = await requestOtp(targetPhone);
      setDevCode(dev ?? null);
      setCooldownEndsAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      return true;
    } catch (err) {
      if (err instanceof OtpError) {
        setError(err.message);
        if (err.code === "rate_limited" && err.retryAfterSeconds) {
          setCooldownEndsAt(Date.now() + err.retryAfterSeconds * 1000);
        }
      } else {
        setError("Network trouble. Please try again.");
      }
      return false;
    }
  }

  async function onPhoneSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const ok = await sendCode(phone.trim());
    setSubmitting(false);
    if (ok) {
      setCode("");
      setStep("code");
    }
  }

  async function onCodeSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { token, user } = await verifyOtp(phone.trim(), code.trim());
      setSession(token, user);
      // P3-D: route straight into the consent gate for a brand-new user
      // (or a returning one whose consent has gone stale — see
      // packages/core/src/consent.ts's isStale) instead of bouncing
      // through /home first. AppShell's useConsentGuard is a second,
      // redundant safety net for this same check (covers a version bump
      // mid-session, or this fetch simply failing offline) — a failure
      // here just falls through to /home and lets that net catch it.
      try {
        const consent = await fetchConsent();
        router.replace(consent.needsConsent ? "/consent" : "/home");
      } catch {
        router.replace("/home");
      }
    } catch (err) {
      setError(
        err instanceof OtpError ? err.message : "Network trouble. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    if (secondsLeft > 0 || submitting) return;
    setSubmitting(true);
    await sendCode(phone.trim());
    setSubmitting(false);
  }

  function onChangeNumber() {
    setError(null);
    setStep("phone");
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Image
          src="/img/logo-lockup-purple.png"
          alt="Amaaii"
          width={168}
          height={56}
          className={styles.lockup}
          priority
        />
        <h1 className={styles.title}>Welcome to Amaaii</h1>
        <p className={styles.lead}>Your pregnancy companion — through every week.</p>

        {deletedNotice && (
          <p className={styles.deletedNotice} role="status">
            Your Amaaii account and data have been permanently deleted.
          </p>
        )}

        {step === "phone" && (
          <form onSubmit={onPhoneSubmit} noValidate>
            <label htmlFor="phone" className={styles.label}>
              Phone number
            </label>
            <div className={styles.phoneRow}>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="07XX XXX XXX or +254 7XX XXX XXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}

            <button type="submit" className={styles.submitBtn} disabled={submitting}>
              {submitting ? "Sending…" : "Send code"}
            </button>

            <p className={styles.fineprint}>
              Use the phone number you message Amaaii with on WhatsApp. We&rsquo;ll send a
              6-digit code there.
            </p>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={onCodeSubmit} noValidate>
            <button type="button" className={styles.backLink} onClick={onChangeNumber}>
              ‹ Change number
            </button>

            <label htmlFor="code" className={styles.label}>
              6-digit code
            </label>
            <div className={styles.codeRow}>
              <input
                id="code"
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
              />
            </div>

            {devCode && (
              <p className={styles.devHint}>
                <strong>Dev code: {devCode}</strong> — SMS delivery is off in this environment.
              </p>
            )}

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={submitting || code.length !== 6}
            >
              {submitting ? "Verifying…" : "Verify"}
            </button>

            <p className={styles.resendRow}>
              {secondsLeft > 0 ? (
                <>Resend code in {secondsLeft}s</>
              ) : (
                <>
                  Didn&rsquo;t get it?{" "}
                  <button
                    type="button"
                    className={styles.resendLink}
                    onClick={onResend}
                    disabled={submitting}
                  >
                    Resend code
                  </button>
                </>
              )}
            </p>
          </form>
        )}
      </div>
      <footer className={styles.foot}>By RHIP Factory</footer>
    </div>
  );
}
