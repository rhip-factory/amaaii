"use client";

import { useEffect, useState, type FormEvent } from "react";
import PageContainer from "@/components/PageContainer";
import { ApiError, updateMe } from "@/lib/api";
import { useMe } from "@/lib/MeContext";
import type { Language } from "@/lib/types";
import styles from "./profile.module.css";

export default function ProfilePage() {
  const { me, loading, refresh } = useMe();

  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [week, setWeek] = useState("");
  const [location, setLocation] = useState("");
  const [language, setLanguage] = useState<Language>("en");

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);

  // Populate the form once /me resolves. Only runs when the fetched user
  // changes (not on every keystroke) so edits aren't clobbered mid-typing.
  useEffect(() => {
    if (!me?.user) return;
    setName(me.user.name ?? "");
    setAge(me.user.age != null ? String(me.user.age) : "");
    setWeek(me.user.pregnancy_week != null ? String(me.user.pregnancy_week) : "");
    setLocation(me.user.location ?? "");
    setLanguage(me.user.language ?? "en");
  }, [me?.user]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      await updateMe({
        name: name.trim() || undefined,
        age: age ? parseInt(age, 10) : undefined,
        pregnancy_week: week ? parseInt(week, 10) : undefined,
        location: location.trim() || undefined,
        language,
      });
      await refresh();
      setStatus({ text: "Saved ✓", isError: false });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not save. Please try again.";
      setStatus({ text: message, isError: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageContainer title="Your profile" subhead="Keep this up to date so I can give you the most relevant guidance.">
      <form className={styles.formCard} onSubmit={onSubmit}>
        <div className={styles.field}>
          <label htmlFor="profName">Name</label>
          <input
            id="profName"
            type="text"
            autoComplete="given-name"
            placeholder="What should I call you?"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="profAge">Age</label>
            <input
              id="profAge"
              type="number"
              min={13}
              max={60}
              inputMode="numeric"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="profWeek">Pregnancy week</label>
            <input
              id="profWeek"
              type="number"
              min={1}
              max={42}
              inputMode="numeric"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label htmlFor="profLocation">Location</label>
          <input
            id="profLocation"
            type="text"
            autoComplete="address-level2"
            placeholder="City / town"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className={styles.field}>
          <label>Language</label>
          <div className={styles.seg} role="radiogroup" aria-label="Language">
            <button
              type="button"
              className={styles.segOpt}
              role="radio"
              aria-checked={language === "en"}
              onClick={() => setLanguage("en")}
            >
              English
            </button>
            <button
              type="button"
              className={styles.segOpt}
              role="radio"
              aria-checked={language === "sw"}
              onClick={() => setLanguage("sw")}
            >
              Kiswahili
            </button>
          </div>
          <p className={styles.fineprint}>Applies to both the web app and WhatsApp.</p>
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving || loading}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          {status && (
            <span className={`${styles.status} ${status.isError ? styles.errorText : ""}`} role="status">
              {status.text}
            </span>
          )}
        </div>
      </form>

      <div className={styles.subtleCard}>
        <div className={styles.field}>
          <label>Phone</label>
          <span className={styles.phoneValue}>{me?.user.phone?.replace(/^whatsapp:/, "") || "—"}</span>
        </div>
        <p className={styles.fineprint}>
          Your phone is your account. Conversations on WhatsApp and the web stay in sync because they
          share this number.
        </p>
      </div>
    </PageContainer>
  );
}
