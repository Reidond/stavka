import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/usage")({
  component: () => (
    <PlaceholderSection
      title="Usage"
      description="Calls, tokens, provider failures, and real and equivalent costs will appear here."
    />
  ),
});
