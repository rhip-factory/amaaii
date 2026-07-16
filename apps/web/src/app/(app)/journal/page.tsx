import PageContainer from "@/components/PageContainer";
import JournalCheckIn from "@/components/JournalCheckIn";

// The structured daily check-in form (P2-C) — writes the same journal
// data the WhatsApp free-text flow does, so weekly summaries, doctor
// reports, and trend computation work unchanged on entries from either
// source. See apps/server/src/app.ts's POST /journal/entries.
export default function JournalPage() {
  return (
    <PageContainer title="Journal" subhead="A two-minute daily check-in — mood, sleep, appetite, and how baby's doing.">
      <JournalCheckIn />
    </PageContainer>
  );
}
