import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/decisions")({
  component: () => (
    <PlaceholderSection
      title="Decisions"
      description="Commander and Sergeant decisions, issued commands, and their outcomes will appear here."
    />
  ),
});
