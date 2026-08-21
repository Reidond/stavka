import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/system")({
  component: () => (
    <PlaceholderSection
      title="System"
      description="Durable Objects, service bindings, deployments, and readiness checks will appear here."
    />
  ),
});
