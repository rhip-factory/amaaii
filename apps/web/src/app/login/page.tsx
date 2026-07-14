"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import styles from "./login.module.css";
import { LoginError, login } from "@/lib/authLogin";
import { setSession, getToken } from "@/lib/storage";

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in? Skip straight to the app.
  useEffect(() => {
    if (getToken()) router.replace("/home");
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { token, user } = await login(phone.trim());
      setSession(token, user);
      router.replace("/home");
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Network trouble. Please try again.");
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
          width={168}
          height={56}
          className={styles.lockup}
          priority
        />
        <h1 className={styles.title}>Welcome to Amaaii</h1>
        <p className={styles.lead}>Your pregnancy companion — through every week.</p>

        <form onSubmit={onSubmit} noValidate>
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
            {submitting ? "Signing in…" : "Continue"}
          </button>

          <p className={styles.fineprint}>
            Use the phone number you message Amaaii with on WhatsApp.
          </p>
        </form>
      </div>
      <footer className={styles.foot}>By RHIP Factory</footer>
    </div>
  );
}
