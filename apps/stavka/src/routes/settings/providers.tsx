import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../../components/shell";

export const Route = createFileRoute("/settings/providers")({
  component: () => (
    <PlaceholderSection
      title="Provider settings"
      description="Codex and Claude connections plus the provider kill switch will be managed here."
    />
  ),
});
