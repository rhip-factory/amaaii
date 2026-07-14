import EmptyState from "@/components/EmptyState";
import PageContainer from "@/components/PageContainer";
import { InsightsIcon } from "@/components/icons";

// Designed empty state only — real charts land in a later package once
// there's enough journal history to chart.
export default function InsightsPage() {
  return (
    <PageContainer title="Insights" subhead="Mood, sleep, and symptom patterns over time.">
      <EmptyState
        Icon={InsightsIcon}
        title="Nothing to show yet"
        body="Your trends will appear here after a few check-ins — mood, sleep, and anything worth watching."
        ctaLabel="Start today's check-in"
        ctaHref="/chat?prefill=journal"
      />
    </PageContainer>
  );
}
