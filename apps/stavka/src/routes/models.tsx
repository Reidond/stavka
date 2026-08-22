import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/models")({
  component: () => (
    <PlaceholderSection
      title="Models"
      description="Model aliases, providers, resolved models, and availability will appear here."
    />
  ),
});
