"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./JournalCheckIn.module.css";
import HelpSheet from "./HelpSheet";
import { AlertIcon, CheckIcon, MinusIcon, PlusIcon } from "./icons";
import { ApiError, UnauthorizedError, fetchJournalHistory, fetchTodayJournal, submitJournalEntry } from "@/lib/api";
import { useMe } from "@/lib/MeContext";
import { useOutbox } from "@/lib/OutboxContext";
import { isClientRejection } from "@/lib/outbox";
import { detectLocalDangerSigns } from "@/lib/localDangerSigns";
import { EMERGENCY_COPY } from "@/lib/dangerSignsCopy";
import { resolveGestationalWeek } from "@/lib/pregnancy";
import { APPETITE_OPTIONS, SYMPTOM_OPTIONS } from "@/lib/journalVocab";
import type {
  Appetite,
  JournalEntry,
  JournalEntryInput,
  JournalEntrySubmitResponse,
  JournalHistoryDay,
  Language,
} from "@/lib/types";

const MOOD_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const BABY_MOVEMENT_MIN_WEEK = 20;

function newClientEntryId(): string {
  // crypto.randomUUID() is available in every browser this PWA targets
  // (secure context, evergreen Chrome/Safari) — generated once at
  // form-mount (and again per fresh check-in) so a double-tap, a network
  // retry, OR an offline-queued submission that later flushes all replay
  // the SAME id and the server's idempotency check (POST
  // /journal/entries) dedupes it instead of writing twice. This is also
  // what the offline outbox keys its queue on (outbox.ts).
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

// Mirrors apps/server/src/app.ts's dangerScanText construction exactly
// (symptoms joined with underscores replaced by spaces, plus symptomsText
// and note) so the offline local check scans the SAME text the server
// would have. See localDangerSigns.ts for why this duplicate exists.
function buildDangerScanText(input: JournalEntryInput): string {
  return [input.symptoms.map((s) => s.replace(/_/g, " ")).join(", "), input.symptomsText, input.note]
    .filter(Boolean)
    .join(". ");
}

function buildOfflineEscalationCopy(language: Language): string {
  const copy = EMERGENCY_COPY[language];
  const caveat =
    language === "sw"
      ? "Ukiwa na dalili hizi, nenda kliniki sasa — usisubiri programu iunganishwe tena."
      : "If you have these symptoms, go to a clinic now — don't wait for the app to reconnect.";
  return `${copy.body} ${caveat}`;
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

  const { pendingItems, queue: queueOffline, flush: flushOutboxNow, syncedVersion, droppedNotice, dismissDroppedNotice } =
    useOutbox();

  const [clientEntryId, setClientEntryId] = useState(newClientEntryId);
  const [form, setForm] = useState<FormState>(freshFormState);
  const [view, setView] = useState<"form" | "confirmation">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<JournalEntrySubmitResponse | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [offlineEscalation, setOfflineEscalation] = useState<string | null>(null);

  const [todayEntries, setTodayEntries] = useState<JournalEntry[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [todayStale, setTodayStale] = useState(false);
  const [historyDays, setHistoryDays] = useState<JournalHistoryDay[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);

  const refreshToday = useCallback(async () => {
    try {
      const { data, stale } = await fetchTodayJournal();
      setTodayEntries(data.entries);
      setTodayCount(data.count);
      setTodayStale(stale);
    } catch {
      // Best-effort — the confirmation screen still works from lastResult
      // even if this refresh fails, and offline-queued items still show
      // via the outbox (below) even with zero server-confirmed entries.
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const { data } = await fetchJournalHistory(14);
      setHistoryDays(data.days);
    } catch {
      // History list just stays empty; not worth surfacing an error for.
    }
  }, []);

  useEffect(() => {
    refreshToday();
    refreshHistory();
  }, [refreshToday, refreshHistory]);

  // A flush that synced at least one item means server state moved —
  // drop any "waiting to sync" badges by re-pulling /journal/today (P2-D
  // design item 3). Skipped on the very first render (mount already
  // triggers its own refresh above).
  const skipNextSyncRefresh = useRef(true);
  useEffect(() => {
    if (skipNextSyncRefresh.current) {
      skipNextSyncRefresh.current = false;
      return;
    }
    refreshToday();
    refreshHistory();
  }, [syncedVersion, refreshToday, refreshHistory]);

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

    const input: JournalEntryInput = {
      mood: form.mood,
      symptoms: form.symptoms,
      symptomsText: form.symptomsText.trim() || undefined,
      sleepHours: form.sleepHours,
      appetite: form.appetite,
      ...(showBabyMovement ? { babyMovement: form.babyMovement } : {}),
      note: form.note.trim() || undefined,
      clientEntryId,
    };

    try {
      const result = await submitJournalEntry(input);
      setLastResult(result);
      setQueuedOffline(false);
      setOfflineEscalation(null);
      setView("confirmation");
      await Promise.all([refreshToday(), refreshHistory()]);
      // Item 1's third flush trigger: a successful submit is a good sign
      // the network is back, so take the opportunity to drain anything
      // queued from earlier too.
      void flushOutboxNow();
    } catch (err) {
      if (err instanceof UnauthorizedError) return; // authedFetch already redirected

      if (err instanceof ApiError && isClientRejection(err)) {
        // The server looked at this exact payload and rejected it (bad
        // mood value, unknown symptom, etc.) — surface it so the user can
        // fix the form. Queuing it would just fail again identically once
        // it flushed.
        setError(err.message);
        setSubmitting(false);
        return;
      }

      // Network failure (fetch TypeError / AbortError from the request
      // timeout) or an unexpected server error: queue it rather than
      // lose the check-in.
      try {
        await queueOffline(input);
      } catch {
        setError(isSw ? "Imeshindwa kuhifadhi. Tafadhali jaribu tena." : "Could not save your check-in. Please try again.");
        setSubmitting(false);
        return;
      }

      // Danger-sign caveat (design item 5): the real triage only runs once
      // this reaches the server, which could be much later. Run the
      // duplicated CRITICAL/HIGH-only check now so a mother describing an
      // emergency sees the escalation card immediately, offline.
      const local = detectLocalDangerSigns(buildDangerScanText(input));
      setOfflineEscalation(
        local.urgencyLevel === "critical" || local.urgencyLevel === "high" ? buildOfflineEscalationCopy(language) : null
      );
      setLastResult(null);
      setQueuedOffline(true);
      setView("confirmation");
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherCheckin() {
    setClientEntryId(newClientEntryId());
    setForm(freshFormState());
    setLastResult(null);
    setQueuedOffline(false);
    setOfflineEscalation(null);
    setError(null);
    setView("form");
  }

  const hasEscalation = queuedOffline ? !!offlineEscalation : !!lastResult?.escalation;
  const escalationText = queuedOffline ? offlineEscalation : lastResult?.escalation;

  // Today's queued-but-not-yet-synced items: pending outbox entries from
  // today that the server hasn't confirmed yet (matched — and excluded
  // once confirmed — on clientEntryId, so a synced item is never counted
  // twice between the server list and the outbox).
  const queuedTodayItems = useMemo(() => {
    const todayKey = new Date().toDateString();
    const serverIds = new Set(todayEntries.map((e) => e.clientEntryId).filter((id): id is string => !!id));
    return pendingItems.filter(
      (item) => new Date(item.queuedAt).toDateString() === todayKey && !serverIds.has(item.clientEntryId)
    );
  }, [pendingItems, todayEntries]);

  const mergedTodayCount = todayCount + queuedTodayItems.length;

  const historySummaryLine = useMemo(() => {
    const totalEntries = historyDays.reduce((sum, d) => sum + d.entries.length, 0);
    if (totalEntries === 0) return isSw ? "Hakuna maandishi bado" : "No entries yet";
    return isSw
      ? `Siku ${historyDays.length} zenye maandishi`
      : `${historyDays.length} day${historyDays.length === 1 ? "" : "s"} with entries`;
  }, [historyDays, isSw]);

  return (
    <div className={styles.wrap}>
      {droppedNotice && (
        <div className={styles.droppedNotice} role="alert">
          <span>
            {isSw
              ? `Ukaguzi mmoja haukuweza kuhifadhiwa: ${droppedNotice.message}`
              : `One of your queued check-ins couldn't be saved: ${droppedNotice.message}`}
          </span>
          <button type="button" className={styles.dismissBtn} onClick={dismissDroppedNotice}>
            {isSw ? "Funga" : "Dismiss"}
          </button>
        </div>
      )}

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

      {view === "confirmation" && (lastResult || queuedOffline) && (
        <div className={styles.confirmStack}>
          {hasEscalation && (
            <div className={styles.escalationCard} role="alert">
              <p className={styles.escalationHeading}>
                <AlertIcon width={16} height={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
                {isSw ? "Hii inaweza kuwa dharura" : "This may need urgent care"}
              </p>
              <p className={styles.escalationBody}>{escalationText}</p>
              <button type="button" className={styles.escalationBtn} onClick={() => setHelpOpen(true)}>
                {isSw ? "Pata msaada sasa" : "Get help now"}
              </button>
            </div>
          )}

          <div className={styles.successCard}>
            <span className={styles.successIcon}>
              <CheckIcon width={20} height={20} />
            </span>
            <h2 className={styles.successTitle}>
              {queuedOffline ? (isSw ? "Imehifadhiwa kwenye simu" : "Saved on this phone") : isSw ? "Ukaguzi umehifadhiwa" : "Check-in saved"}
            </h2>
            <p className={styles.successBody}>
              {queuedOffline
                ? isSw
                  ? "Itatumwa ukiwa mtandaoni tena."
                  : "Will sync when you're back online."
                : isSw
                  ? `Umeangalia mara ${mergedTodayCount} leo.`
                  : `Checked in ${mergedTodayCount} time${mergedTodayCount === 1 ? "" : "s"} today.`}
            </p>
            <button type="button" className={styles.secondaryBtn} onClick={startAnotherCheckin}>
              {isSw ? "Ongeza ukaguzi mwingine" : "Add another check-in"}
            </button>
          </div>
        </div>
      )}

      {(todayEntries.length > 0 || queuedTodayItems.length > 0) && (
        <div className={styles.field}>
          {todayStale && (
            <p className={styles.staleNote}>
              {isSw ? "Zinaonyesha ukaguzi wa mwisho ulioihifadhiwa." : "Showing your last saved check-ins."}
            </p>
          )}
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
            {queuedTodayItems.map((item) => {
              const local = detectLocalDangerSigns(buildDangerScanText(item.payload));
              const flagged = local.urgencyLevel === "critical" || local.urgencyLevel === "high";
              return (
                <li key={item.clientEntryId} className={styles.todayItem}>
                  <span className={styles.todayTime}>—</span>
                  <span className={styles.todayGlance}>
                    {formatMoodEmoji(item.payload.mood)} {item.payload.mood}/10 · 😴 {item.payload.sleepHours}h
                    {flagged ? ` · ⚠️ ${isSw ? "Iliyoashiriwa" : "Flagged"}` : ""}
                  </span>
                  <span className={styles.syncBadge}>{isSw ? "Inasubiri kutumwa" : "Waiting to sync"}</span>
                </li>
              );
            })}
          </ul>
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
