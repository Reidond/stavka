import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../../components/shell";

export const Route = createFileRoute("/settings/access")({
  component: () => (
    <PlaceholderSection
      title="Access settings"
      description="Owner, operator, spectator, and automation access will be managed here."
    />
  ),
});
