"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import styles from "./JournalCheckIn.module.css";
import HelpSheet from "./HelpSheet";
import { AlertIcon, CheckIcon, MinusIcon, PlusIcon } from "./icons";
import { ApiError, fetchJournalHistory, fetchTodayJournal, submitJournalEntry } from "@/lib/api";
import { useMe } from "@/lib/MeContext";
import { resolveGestationalWeek } from "@/lib/pregnancy";
import { APPETITE_OPTIONS, SYMPTOM_OPTIONS } from "@/lib/journalVocab";
import type { Appetite, JournalEntry, JournalEntrySubmitResponse, JournalHistoryDay } from "@/lib/types";

const MOOD_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const BABY_MOVEMENT_MIN_WEEK = 20;

function newClientEntryId(): string {
  // crypto.randomUUID() is available in every browser this PWA targets
  // (secure context, evergreen Chrome/Safari) — generated once at
  // form-mount (and again per fresh check-in) so a double-tap or a
  // network retry replays the SAME id and the server's idempotency check
  // (POST /journal/entries) dedupes it instead of writing twice.
  return crypto.randomUUID();
}

function formatMoodEmoji(mood: number): string {
  if (mood >= 7) return "😊";
  if (mood >= 5) return "😐";
  return "😔";
}

function formatDayLabel(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    if (isToday) return "Today";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

interface FormState {
  mood: number | null;
  symptoms: string[];
  symptomsText: string;
  sleepHours: number;
  appetite: Appetite | null;
  babyMovement: number;
  note: string;
}

function freshFormState(): FormState {
  return {
    mood: null,
    symptoms: [],
    symptomsText: "",
    sleepHours: 7,
    appetite: null,
    babyMovement: 0,
    note: "",
  };
}

export default function JournalCheckIn() {
  const { me } = useMe();
  const language = me?.user.language ?? "en";
  const isSw = language === "sw";
  const week = resolveGestationalWeek(me?.user ?? null);
  const showBabyMovement = !!week && week >= BABY_MOVEMENT_MIN_WEEK;

  const [clientEntryId, setClientEntryId] = useState(newClientEntryId);
  const [form, setForm] = useState<FormState>(freshFormState);
  const [view, setView] = useState<"form" | "confirmation">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<JournalEntrySubmitResponse | null>(null);

  const [todayEntries, setTodayEntries] = useState<JournalEntry[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [historyDays, setHistoryDays] = useState<JournalHistoryDay[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);

  const refreshToday = useCallback(async () => {
    try {
      const data = await fetchTodayJournal();
      setTodayEntries(data.entries);
      setTodayCount(data.count);
    } catch {
      // Best-effort — the confirmation screen still works from lastResult
      // even if this refresh fails.
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await fetchJournalHistory(14);
      setHistoryDays(data.days);
    } catch {
      // History list just stays empty; not worth surfacing an error for.
    }
  }, []);

  useEffect(() => {
    refreshToday();
    refreshHistory();
  }, [refreshToday, refreshHistory]);

  const canSubmit = form.mood != null && form.appetite != null && !submitting;

  function toggleSymptom(value: string) {
    setForm((f) => ({
      ...f,
      symptoms: f.symptoms.includes(value) ? f.symptoms.filter((s) => s !== value) : [...f.symptoms, value],
    }));
  }

  function clearSymptoms() {
    setForm((f) => ({ ...f, symptoms: [] }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || form.mood == null || form.appetite == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitJournalEntry({
        mood: form.mood,
        symptoms: form.symptoms,
        symptomsText: form.symptomsText.trim() || undefined,
        sleepHours: form.sleepHours,
        appetite: form.appetite,
        ...(showBabyMovement ? { babyMovement: form.babyMovement } : {}),
        note: form.note.trim() || undefined,
        clientEntryId,
      });
      setLastResult(result);
      setView("confirmation");
      await Promise.all([refreshToday(), refreshHistory()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // authedFetch already redirected
      setError(err instanceof ApiError ? err.message : "Could not save your check-in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherCheckin() {
    setClientEntryId(newClientEntryId());
    setForm(freshFormState());
    setLastResult(null);
    setError(null);
    setView("form");
  }

  const hasEscalation = !!lastResult?.escalation;

  const historySummaryLine = useMemo(() => {
    const totalEntries = historyDays.reduce((sum, d) => sum + d.entries.length, 0);
    if (totalEntries === 0) return isSw ? "Hakuna maandishi bado" : "No entries yet";
    return isSw
      ? `Siku ${historyDays.length} zenye maandishi`
      : `${historyDays.length} day${historyDays.length === 1 ? "" : "s"} with entries`;
  }, [historyDays, isSw]);

  return (
    <div className={styles.wrap}>
      {view === "form" && (
        <form className={styles.formCard} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label>{isSw ? "Unajisikiaje leo?" : "How are you feeling today?"}</label>
            <div className={styles.moodGrid} role="radiogroup" aria-label="Mood, 1 to 10">
              {MOOD_VALUES.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={form.mood === v}
                  className={`${styles.moodBtn} ${form.mood === v ? styles.moodBtnActive : ""}`}
                  onClick={() => setForm((f) => ({ ...f, mood: v }))}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className={styles.moodScale}>
              <span>{isSw ? "Chini sana" : "Very low"}</span>
              <span>{isSw ? "Bora kabisa" : "Excellent"}</span>
            </div>
          </div>

          <div className={styles.field}>
            <label>{isSw ? "Dalili zozote za kimwili?" : "Any physical symptoms?"}</label>
            <div className={styles.chipRow}>
              <button
                type="button"
                className={`${styles.chip} ${form.symptoms.length === 0 ? styles.chipActive : ""}`}
                aria-pressed={form.symptoms.length === 0}
                onClick={clearSymptoms}
              >
                {isSw ? "Hakuna" : "None of these"}
              </button>
              {SYMPTOM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.chip} ${form.symptoms.includes(opt.value) ? styles.chipActive : ""}`}
                  aria-pressed={form.symptoms.includes(opt.value)}
                  onClick={() => toggleSymptom(opt.value)}
                >
                  {isSw ? opt.sw : opt.en}
                </button>
              ))}
            </div>
            <textarea
              className={styles.textarea}
              placeholder={isSw ? "Maelezo mengine (hiari)…" : "Anything else worth mentioning (optional)…"}
              rows={2}
              value={form.symptomsText}
              onChange={(e) => setForm((f) => ({ ...f, symptomsText: e.target.value }))}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="sleepHours">{isSw ? "Ulilala masaa mangapi?" : "How many hours did you sleep?"}</label>
            <div className={styles.stepper}>
              <button
                type="button"
                className={styles.stepperBtn}
                aria-label={isSw ? "Punguza" : "Decrease"}
                onClick={() => setForm((f) => ({ ...f, sleepHours: Math.max(0, Math.round((f.sleepHours - 0.5) * 10) / 10) }))}
              >
                <MinusIcon width={18} height={18} />
              </button>
              <span className={`${styles.stepperValue} tabular-nums`} id="sleepHours">
                {form.sleepHours}
                <span className={styles.stepperUnit}>h</span>
              </span>
              <button
                type="button"
                className={styles.stepperBtn}
                aria-label={isSw ? "Ongeza" : "Increase"}
                onClick={() => setForm((f) => ({ ...f, sleepHours: Math.min(14, Math.round((f.sleepHours + 0.5) * 10) / 10) }))}
              >
                <PlusIcon width={18} height={18} />
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <label>{isSw ? "Hamu yako ya kula?" : "How was your appetite?"}</label>
            <div className={styles.seg} role="radiogroup" aria-label="Appetite">
              {APPETITE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={styles.segOpt}
                  role="radio"
                  aria-checked={form.appetite === opt.value}
                  onClick={() => setForm((f) => ({ ...f, appetite: opt.value }))}
                >
                  {isSw ? opt.sw : opt.en}
                </button>
              ))}
            </div>
          </div>

          {showBabyMovement && (
            <div className={styles.field}>
              <label htmlFor="babyMovement">
                {isSw ? "Mtoto alitembea mara ngapi leo?" : "How many times did you feel baby move today?"}
              </label>
              <div className={styles.stepper}>
                <button
                  type="button"
                  className={styles.stepperBtn}
                  aria-label={isSw ? "Punguza" : "Decrease"}
                  onClick={() => setForm((f) => ({ ...f, babyMovement: Math.max(0, f.babyMovement - 1) }))}
                >
                  <MinusIcon width={18} height={18} />
                </button>
                <span className={`${styles.stepperValue} tabular-nums`} id="babyMovement">
                  {form.babyMovement}
                </span>
                <button
                  type="button"
                  className={styles.stepperBtn}
                  aria-label={isSw ? "Ongeza" : "Increase"}
                  onClick={() => setForm((f) => ({ ...f, babyMovement: f.babyMovement + 1 }))}
                >
                  <PlusIcon width={18} height={18} />
                </button>
              </div>
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="note">{isSw ? "Maelezo mengine (hiari)" : "Any other notes (optional)"}</label>
            <textarea
              id="note"
              className={styles.textarea}
              placeholder={isSw ? "Unajisikiaje kwa ujumla?" : "How are you feeling overall?"}
              rows={3}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>

          {error && <p className={styles.errorNote}>{error}</p>}

          <button type="submit" className={styles.submitBtn} disabled={!canSubmit}>
            {submitting ? (isSw ? "Inahifadhi…" : "Saving…") : isSw ? "Hifadhi ukaguzi" : "Save check-in"}
          </button>
        </form>
      )}

      {view === "confirmation" && lastResult && (
        <div className={styles.confirmStack}>
          {hasEscalation && (
            <div className={styles.escalationCard} role="alert">
              <p className={styles.escalationHeading}>
                <AlertIcon width={16} height={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
                {isSw ? "Hii inaweza kuwa dharura" : "This may need urgent care"}
              </p>
              <p className={styles.escalationBody}>{lastResult.escalation}</p>
              <button type="button" className={styles.escalationBtn} onClick={() => setHelpOpen(true)}>
                {isSw ? "Pata msaada sasa" : "Get help now"}
              </button>
            </div>
          )}

          <div className={styles.successCard}>
            <span className={styles.successIcon}>
              <CheckIcon width={20} height={20} />
            </span>
            <h2 className={styles.successTitle}>{isSw ? "Ukaguzi umehifadhiwa" : "Check-in saved"}</h2>
            <p className={styles.successBody}>
              {isSw
                ? `Umeangalia mara ${todayCount} leo.`
                : `Checked in ${todayCount} time${todayCount === 1 ? "" : "s"} today.`}
            </p>
            <button type="button" className={styles.secondaryBtn} onClick={startAnotherCheckin}>
              {isSw ? "Ongeza ukaguzi mwingine" : "Add another check-in"}
            </button>
          </div>

          {todayEntries.length > 0 && (
            <ul className={styles.todayList}>
              {todayEntries.map((entry) => (
                <li key={entry.id} className={styles.todayItem}>
                  <span className={styles.todayTime}>
                    {entry.completedAt
                      ? new Date(entry.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "—"}
                  </span>
                  <span className={styles.todayGlance}>
                    {entry.mood != null ? `${formatMoodEmoji(entry.mood)} ${entry.mood}/10` : "—"}
                    {entry.sleepHours != null ? ` · 😴 ${entry.sleepHours}h` : ""}
                    {entry.hasRedFlags ? ` · ⚠️ ${isSw ? "Iliyoashiriwa" : "Flagged"}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <details className={styles.history}>
        <summary className={styles.historySummary}>
          <span>{isSw ? "Siku 14 zilizopita" : "Last 14 days"}</span>
          <span className={styles.historyCount}>{historySummaryLine}</span>
        </summary>
        <div className={styles.historyBody}>
          {historyDays.length === 0 && (
            <p className={styles.historyEmpty}>
              {isSw ? "Bado hakuna maandishi ya kuonyesha." : "Nothing to show yet — your check-ins will appear here."}
            </p>
          )}
          {historyDays.map((day) => (
            <div key={day.date} className={styles.historyDay}>
              <span className={styles.historyDate}>{formatDayLabel(day.date)}</span>
              <span className={styles.historyGlance}>
                {day.entries
                  .map((e) => {
                    const parts: string[] = [];
                    if (e.mood != null) parts.push(`${formatMoodEmoji(e.mood)} ${e.mood}/10`);
                    if (e.sleepHours != null) parts.push(`😴 ${e.sleepHours}h`);
                    if (e.hasRedFlags) parts.push("⚠️");
                    return parts.join(" · ") || "—";
                  })
                  .join("  •  ")}
              </span>
            </div>
          ))}
        </div>
      </details>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} language={language} />
    </div>
  );
}
