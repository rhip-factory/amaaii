"use client";

// P5-B: "Enroll a mother" action on the provider panel. Collapsed by
// default (a toggle button, same interaction shape as PrivacySection's
// delete-confirm expand) so it never competes with the summary tiles /
// patient table for attention. Enrollment does NOT grant consent — see
// the spec: POST /provider/enroll only creates the enrollment row and
// returns the mother's CURRENT consent status, so the success state
// here is careful to say "awaiting her consent" rather than implying
// the facility can already see her data.

import { useState, type FormEvent } from "react";
import styles from "./EnrollMotherForm.module.css";
import { CloseIcon, PlusIcon } from "./icons";
import { ProviderApiError, enrollPatient } from "@/lib/providerApi";

interface EnrollMotherFormProps {
  /** Called after a successful enroll so the panel can refresh its patient list. */
  onEnrolled: () => void;
}

function consentStatusGranted(status: boolean | string): boolean {
  return status === true || status === "granted" || status === "active";
}

export default function EnrollMotherForm({ onEnrolled }: EnrollMotherFormProps) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ name: string; consentGranted: boolean } | null>(null);

  function reset() {
    setPhone("");
    setName("");
    setError(null);
    setSuccess(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || !phone.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const trimmedName = name.trim();
      const result = await enrollPatient(phone.trim(), trimmedName || undefined);
      if (result.enrolled) {
        setSuccess({ name: trimmedName || "This mother", consentGranted: consentStatusGranted(result.consentStatus) });
        setPhone("");
        setName("");
        onEnrolled();
      } else {
        setError("Could not enroll this mother. Please check the phone number and try again.");
      }
    } catch (err) {
      setError(
        err instanceof ProviderApiError ? err.message : "Network trouble. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.toggleBtn} onClick={() => setOpen(true)}>
        <PlusIcon width={16} height={16} />
        Enroll a mother
      </button>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Enroll a mother</h2>
          <p className={styles.cardSub}>
            Adds her to your facility&rsquo;s ANC bundle. She keeps full control of her clinical data —
            you&rsquo;ll only see it once she grants your facility access from her own privacy settings.
          </p>
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={() => {
            setOpen(false);
            reset();
          }}
          aria-label="Close"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      <form onSubmit={onSubmit} noValidate>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="enrollPhone">Phone number</label>
            <input
              id="enrollPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="07XX XXX XXX or +254 7XX XXX XXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="enrollName">Name (optional)</label>
            <input
              id="enrollName"
              type="text"
              autoComplete="off"
              placeholder="If known"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {success && (
          <p className={styles.success} role="status">
            {success.consentGranted ? (
              <span>
                <strong>Enrolled.</strong> {success.name} has already granted provider access — her record
                will appear in your patient list now.
              </span>
            ) : (
              <span>
                <strong>Enrolled.</strong> {success.name} will appear in your patient list, but her clinical
                data stays hidden until she grants your facility access.
              </span>
            )}
          </p>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.submitBtn} disabled={submitting || !phone.trim()}>
            {submitting ? "Enrolling…" : "Enroll"}
          </button>
        </div>
      </form>
    </div>
  );
}
