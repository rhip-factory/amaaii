import EmptyState from "@/components/EmptyState";
import PageContainer from "@/components/PageContainer";
import { JournalIcon } from "@/components/icons";

// Designed empty state only — the real multi-step journal form lives in a
// later package. For now this tab's whole job is getting a mother into
// the existing WhatsApp/chat journaling flow, which already works today.
export default function JournalPage() {
  return (
    <PageContainer title="Journal" subhead="A two-minute daily check-in — mood, sleep, water, and how baby's doing.">
      <EmptyState
        Icon={JournalIcon}
        title="No entries yet"
        body="Today's check-in happens in Chat for now — a full journal form is coming soon."
        ctaLabel="Start today's check-in"
        ctaHref="/chat?prefill=journal"
      />
    </PageContainer>
  );
}
