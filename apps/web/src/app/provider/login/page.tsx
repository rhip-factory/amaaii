"use client";

// P5-B: provider (hospital/clinic staff) sign-in. Fully separate flow
// from the mother's OTP login (/login) — email + password against
// apps/server's providerAuth.ts, session stored under the provider-only
// localStorage keys (see lib/providerStorage.ts). A provider never sees
// the mother OTP flow and a mother never sees this page.

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import styles from "./providerLogin.module.css";
import { ProviderApiError, providerLogin } from "@/lib/providerApi";
import { getProviderToken, setProviderSession } from "@/lib/providerStorage";

export default function ProviderLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in as a provider? Skip straight to the panel.
  useEffect(() => {
    if (getProviderToken()) router.replace("/provider");
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { token, provider } = await providerLogin(email.trim(), password);
      setProviderSession(token, provider);
      router.replace("/provider");
    } catch (err) {
      if (err instanceof ProviderApiError && err.status === 401) {
        setError("Incorrect email or password.");
      } else if (err instanceof ProviderApiError) {
        setError(err.message);
      } else {
        setError("Network trouble. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Image
          src="/img/logo-lockup-purple.png"
          alt="Amaaii"
          width={160}
          height={54}
          className={styles.lockup}
          priority
        />
        <p className={styles.eyebrow}>Provider portal</p>
        <h1 className={styles.title}>Facility sign in</h1>
        <p className={styles.lead}>For hospitals and clinics supporting mothers on Amaaii.</p>

        <form onSubmit={onSubmit} noValidate>
          <label htmlFor="provEmail" className={styles.label}>
            Work email
          </label>
          <div className={styles.inputRow}>
            <input
              id="provEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@facility.org"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <label htmlFor="provPassword" className={styles.label}>
            Password
          </label>
          <div className={styles.inputRow}>
            <input
              id="provPassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className={styles.submitBtn} disabled={submitting || !email || !password}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className={styles.fineprint}>
          Mothers sign in on the main Amaaii app, not here — this portal is for facility staff only.
        </p>
      </div>
      <footer className={styles.foot}>By RHIP Factory</footer>
    </div>
  );
}
