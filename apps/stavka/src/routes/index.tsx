import { createFileRoute, Link } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function OverviewPage() {
  return (
    <PlaceholderSection
      title="Overview"
      description="Readiness, active sessions, provider health, and recent failures will be summarized here."
    >
      <p className="m-0 text-sm text-kumo-subtle">
        Open{" "}
        <Link to="/simulations" className="text-kumo-strong underline">
          Simulations
        </Link>{" "}
        to run a proving-ground scenario while this section is being built.
      </p>
    </PlaceholderSection>
  );
}
